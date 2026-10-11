"""状态图模型 + JSON DSL（DESIGN.md §7）。

一个工程一份 `graph.json`（人可读、可 git diff、可手改），旁边的 `templates/`
放模板 PNG。识别器 spec 原样保留，改字段不会被写回时丢掉。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any

from .actions import Action
from .conditions import ALWAYS_LABEL, Condition
from .geometry import Rect
from .recognizer import Recognizer, build_recognizer
from .variables import CALL_ACTION, SET_ACTION, Variable, VariableRefs, parse_variables


@dataclass
class Node:
    id: str
    name: str = ""
    enter: list[str] = field(default_factory=list)
    timeout_ms: int | None = None
    note: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Node:
        return cls(
            id=str(data["id"]),
            name=str(data.get("name", data["id"])),
            enter=[str(item) for item in data.get("enter", [])],
            timeout_ms=int(data["timeout_ms"]) if data.get("timeout_ms") else None,
            note=str(data.get("note", "")),
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "name": self.name, "enter": list(self.enter)}
        if self.timeout_ms:
            out["timeout_ms"] = self.timeout_ms
        if self.note:
            out["note"] = self.note
        return out


def _action_is_deferred(spec: object) -> bool:
    """动作里带变量引用（$var/$expr）或是赋值动作时，**延后到执行那一刻**再解析。

    这样 graph.json 里可以写 {"$var": "点击X"}，而不必在加载时就要求它是具体数字。
    """
    if not isinstance(spec, dict):
        return False
    if str(spec.get("type")) in (SET_ACTION, CALL_ACTION):
        return True
    if VariableRefs.collect(spec).vars:
        return True
    if VariableRefs.collect_scores(spec):
        return True
    return any(key in spec for key in ("$expr",))


@dataclass
class Edge:
    id: str
    when: str
    src: str | None = None
    dst: str | None = None
    kind: str = "normal"  # normal | recovery
    priority: int = 0
    min_score: float = 0.0
    cooldown_ms: int = 0
    retries: int = 1
    action: dict[str, Any] = field(default_factory=dict)
    # 判断条件（all_of / any_of / none_of / min_score / within_ms）。
    # 没写 condition 时，用 when 当 all_of —— 完全兼容老的 graph.json
    condition: Condition = field(default_factory=Condition)

    @property
    def action_fallback_target(self) -> str | None:
        """动作没写目标时用 when 兜底；"无条件"边（when 是哨兵）不能兜底。"""
        return None if self.when in ("", ALWAYS_LABEL) else self.when

    def __post_init__(self) -> None:
        # 直接构造 Edge（测试、脚本）时：没给条件就用 when 当 all_of，保持老语义。
        # 否则空条件会被当成"永远成立"，恢复边会在第一帧就误触发。
        if not self.condition.labels and not self.condition.always and self.when:
            self.condition = Condition(all_of=(self.when,))

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Edge:
        when = str(data.get("when") or "")
        raw_action = data.get("action") or {"type": "click", "target": when}
        return cls(
            id=str(data["id"]),
            when=when,
            src=data.get("from") or data.get("src"),
            dst=data.get("to") or data.get("dst"),
            kind=str(data.get("kind", "normal")),
            priority=int(data.get("priority", 0)),
            min_score=float(data.get("min_score", 0.0)),
            cooldown_ms=int(data.get("cooldown_ms", 0)),
            retries=int(data.get("retries", 1)),
            action=(
                # 带变量引用/赋值的动作原样保留（运行时求值后再解析），其余照旧规范化
                dict(raw_action)
                if _action_is_deferred(raw_action)
                else Action.parse(
                    raw_action,
                    fallback_target=None if when == ALWAYS_LABEL else when,
                ).to_dict()
            ),
            condition=Condition.parse(data.get("condition"), fallback=when),
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "action": dict(self.action)}
        if self.when:
            out["when"] = self.when
        # always 必须写进文件：丢了它再读回来会变成"一个叫 always 的识别器标签"（踩过）
        if (
            self.condition.always
            or self.condition.within_ms
            or self.condition.min_score
            or (self.condition.labels and set(self.condition.labels) != {self.when})
        ):
            out["condition"] = self.condition.to_dict()
        if self.src:
            out["from"] = self.src
        if self.dst:
            out["to"] = self.dst
        if self.kind != "normal":
            out["kind"] = self.kind
        if self.priority:
            out["priority"] = self.priority
        if self.min_score:
            out["min_score"] = self.min_score
        if self.cooldown_ms:
            out["cooldown_ms"] = self.cooldown_ms
        if self.retries != 1:
            out["retries"] = self.retries
        return out


@dataclass
class Graph:
    nodes: dict[str, Node] = field(default_factory=dict)
    edges: list[Edge] = field(default_factory=list)
    recognizers: dict[str, Recognizer] = field(default_factory=dict)
    # 变量（"黑板"）：动作参数可以用 {"$var": 名字} 引用它们
    variables: dict[str, Variable] = field(default_factory=dict)
    specs: dict[str, dict[str, Any]] = field(default_factory=dict)
    defaults: dict[str, object] = field(default_factory=dict)
    path: str | None = None
    base_dir: str = "."

    # ---------- 构造 / 读写 ----------

    @classmethod
    def from_dict(cls, data: dict[str, Any], base_dir: str, path: str | None = None) -> Graph:
        specs = {str(label): dict(spec) for label, spec in (data.get("recognizers") or {}).items()}
        graph = cls(
            nodes={node["id"]: Node.from_dict(node) for node in data.get("nodes", [])},
            edges=[Edge.from_dict(edge) for edge in data.get("edges", [])],
            defaults=dict(data.get("defaults") or {}),
            variables=parse_variables(data.get("variables")),
            path=path,
            base_dir=base_dir,
        )
        graph.specs = specs
        graph.recognizers = {label: build_recognizer(label, spec, base_dir) for label, spec in specs.items()}
        graph.validate()
        return graph

    @classmethod
    def empty(cls, base_dir: str, path: str | None = None) -> Graph:
        return cls(
            base_dir=base_dir,
            path=path or os.path.join(base_dir, "graph.json"),
            defaults={"vote": 2, "tick_ms": 200, "transition_timeout_ms": 4000},
        )

    @classmethod
    def load(cls, path: str) -> Graph:
        if not os.path.exists(path):
            return cls.empty(os.path.dirname(os.path.abspath(path)), os.path.abspath(path))
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        return cls.from_dict(data, base_dir=os.path.dirname(os.path.abspath(path)), path=os.path.abspath(path))

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "version": 1,
            "defaults": dict(self.defaults),
            "recognizers": {label: dict(spec) for label, spec in self.specs.items()},
            "nodes": [node.to_dict() for node in self.nodes.values()],
            "edges": [edge.to_dict() for edge in self.edges],
        }
        if self.variables:
            # 没有变量就不写这段（老脚本的文件保持干净）
            out["variables"] = {name: var.to_dict() for name, var in self.variables.items()}
        return out

    def save(self, path: str | None = None) -> str:
        target = path or self.path
        if not target:
            raise ValueError("状态图没有保存路径")
        os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(self.to_dict(), handle, ensure_ascii=False, indent=2)
        self.path = os.path.abspath(target)
        return self.path

    # ---------- 编辑 ----------

    def add_recognizer(self, label: str, spec: dict[str, Any]) -> None:
        self.specs[label] = dict(spec)
        self.recognizers[label] = build_recognizer(label, spec, self.base_dir)

    def set_threshold(self, label: str, threshold: float) -> None:
        spec = self.specs.get(label)
        if spec is None:
            raise KeyError(f"识别器不存在: {label}")
        spec["threshold"] = round(float(threshold), 4)
        self.add_recognizer(label, spec)

    def upsert_node(self, node: Node) -> None:
        self.nodes[node.id] = node

    def add_edge(self, edge: Edge) -> None:
        self.edges = [item for item in self.edges if item.id != edge.id] + [edge]

    def labels(self) -> list[str]:
        return sorted(self.recognizers)

    def default(self, key: str, fallback: object) -> object:
        return self.defaults.get(key, fallback)

    # ---------- 校验 ----------

    def validate(self) -> None:
        for edge in self.edges:
            if edge.src and edge.src not in self.nodes:
                raise ValueError(f"边 {edge.id} 的 from 节点不存在: {edge.src}")
            if edge.dst and edge.dst not in self.nodes:
                raise ValueError(f"边 {edge.id} 的 to 节点不存在: {edge.dst}")
            if not edge.condition.always:
                fallback_labels = () if edge.when in ("", ALWAYS_LABEL) else (edge.when,)
                for condition_label in edge.condition.labels or fallback_labels:
                    if condition_label not in self.recognizers:
                        raise ValueError(f"边 {edge.id} 的条件引用了未定义的识别器: {condition_label}")
            # 变量引用必须是定义过的（和识别器标签一样在保存时报错，别等跑起来才发现）
            for name in VariableRefs.collect(edge.action).vars:
                if name not in self.variables:
                    raise ValueError(f"边 {edge.id} 的动作引用了未定义的变量: {name}")
            for label in VariableRefs.collect_scores(edge.action):
                if label not in self.recognizers:
                    raise ValueError(f"边 {edge.id} 的动作引用了未定义的识别器（$score）: {label}")
            if str(edge.action.get("type")) == SET_ACTION:
                target_name = str(edge.action.get("name") or "").strip()
                if not target_name:
                    raise ValueError(f"边 {edge.id} 的赋值动作没写变量名")
                if target_name not in self.variables:
                    raise ValueError(f"边 {edge.id} 给未定义的变量赋值: {target_name}")
                continue
            if str(edge.action.get("type")) == CALL_ACTION and not str(edge.action.get("script") or "").strip():
                raise ValueError(f"边 {edge.id} 的「运行子脚本」没写脚本名")
            if _action_is_deferred(edge.action):
                # 带变量引用的动作：参数值要等运行时才知道，这里只校验引用本身
                continue
            action = Action.parse(edge.action, fallback_target=edge.action_fallback_target)
            for action_label in (action.target, action.to_target):
                if action_label and action_label not in self.recognizers:
                    raise ValueError(f"边 {edge.id} 的动作引用了未定义的识别器: {action_label}")
        for node in self.nodes.values():
            for label in node.enter:
                if label not in self.recognizers:
                    raise ValueError(f"节点 {node.id} 引用了未定义的识别器: {label}")

    def summary(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "nodes": [node.to_dict() for node in self.nodes.values()],
            "edges": [edge.to_dict() for edge in self.edges],
            "recognizers": [{"label": label, **spec} for label, spec in self.specs.items()],
        }


def roi_of(spec: dict[str, Any]) -> Rect | None:
    return Rect.parse(spec["roi"]) if spec.get("roi") else None
