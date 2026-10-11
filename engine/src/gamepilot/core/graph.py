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
        # 直接构造 Edge（测试、手工拼数据）时：没给条件就用 when 当 all_of，保持老语义。
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
        # 只有"恰好等于默认形态"（all_of 就是 when 本身）才省略。
        # 曾经用 labels 的集合比较 → none_of=[when] 也被当成默认形态省略，
        # 读回来变成 all_of=[when] —— **分支直接反过来**（验收时抓到的）
        condition = self.condition
        default_shape = (
            not condition.always
            and not condition.any_of
            and not condition.none_of
            and condition.min_score == 0
            and condition.within_ms == 0
            and (condition.all_of == (self.when,) or (not condition.all_of and not self.when))
        )
        if not default_shape:
            out["condition"] = condition.to_dict()
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
        # path="" 是合法入参：表示"还没有落盘位置"（没有选择工作流时的一等状态），
        # 此时 save() 会明确报「状态图没有保存路径」，而不是往 cwd 里写一个 graph.json
        return cls(
            base_dir=base_dir,
            path=path if path is not None else os.path.join(base_dir, "graph.json"),
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
            # 没有变量就不写这段（老工作流的文件保持干净）
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

    def rename_recognizer(self, old: str, new: str) -> dict[str, int]:
        """给识别器改名（标签），并把**所有引用一起改**。

        为什么必须级联：`node.enter` / `edge.when` / `edge.condition.*` / 动作的
        `target`·`to_target` / 动作里 `$score` 引用的都是**标签字符串**。
        只改 `specs` 的键，`validate()` 立刻就会报"引用了未定义的识别器" ——
        改名只有"全改"和"不改"两种状态，不能半途而废。

        模板文件（`templates/xxx.png`）**不跟着改名**：spec 里存的是相对路径，
        文件叫什么名字对匹配没有任何影响；跟着改反而多出"新文件名已存在""改到一半崩了"的坑。

        返回改名动到的引用处数（界面用它告诉用户"顺带更新了几处引用"）。
        """
        old = old.strip()
        new = validate_recognizer_label(new)
        if old not in self.specs:
            raise KeyError(f"识别器不存在: {old}")
        if old == new:
            return {"nodes": 0, "edges": 0, "scores": 0}
        if new in self.specs:
            raise ValueError(f"已经有同名识别器: {new}")

        # 保持原顺序（键换名字，位置不动）：识别读数列表不该因为改名而跳到别处
        self.specs = {new if key == old else key: value for key, value in self.specs.items()}
        self.recognizers = {new if key == old else key: value for key, value in self.recognizers.items()}

        nodes = 0
        for node in self.nodes.values():
            if old in node.enter:
                node.enter = [new if item == old else item for item in node.enter]
                nodes += 1

        edges = 0
        scores = 0
        for edge in self.edges:
            touched = False
            if edge.when == old:
                edge.when = new
                touched = True
            condition = edge.condition
            renamed = Condition(
                all_of=tuple(new if item == old else item for item in condition.all_of),
                any_of=tuple(new if item == old else item for item in condition.any_of),
                none_of=tuple(new if item == old else item for item in condition.none_of),
                min_score=condition.min_score,
                within_ms=condition.within_ms,
                always=condition.always,
            )
            if renamed != condition:
                edge.condition = renamed
                touched = True
            for key in ("target", "to_target"):
                if edge.action.get(key) == old:
                    edge.action[key] = new
                    touched = True
            renamed_scores = _rename_score_refs(edge.action, old, new)
            scores += renamed_scores
            if touched or renamed_scores:
                edges += 1

        self.validate()
        return {"nodes": nodes, "edges": edges, "scores": scores}

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
                raise ValueError(f"边 {edge.id} 的「运行子工作流」没写工作流名")
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


# 识别器标签的长度上限：它会变成模板文件名（`templates/<label>.png`），
# 太长在 macOS/Linux 上虽然还能写，但界面里已经完全显示不下了
LABEL_MAX_LENGTH = 48

# 标签里不允许出现的字符：路径分隔符（录制时会当文件名用）+ 控制字符
_LABEL_FORBIDDEN = frozenset("/\\")


def validate_recognizer_label(label: str) -> str:
    """校验识别器标签，返回去掉首尾空白后的值（非法就抛 ValueError）。

    标签同时出现在四个地方，所以规则不能松：
    1. `graph.json` 里 `recognizers` 的**键**；
    2. 边的 `when` / `condition` 三个标签列表；
    3. 动作的 `target` / `to_target`；
    4. 录制时被当成模板文件名 `templates/<label>.png`。
    第 4 条是为什么必须挡路径分隔符 —— 否则 `a/../../x` 能把文件写到工程外面去。
    """
    cleaned = label.strip()
    if not cleaned:
        raise ValueError("识别器名字不能为空")
    if len(cleaned) > LABEL_MAX_LENGTH:
        raise ValueError(f"识别器名字太长（最多 {LABEL_MAX_LENGTH} 个字符）")
    if any(char in _LABEL_FORBIDDEN for char in cleaned):
        raise ValueError("识别器名字不能带 / 或 \\（它会变成模板文件名）")
    if any(ord(char) < 32 or ord(char) == 127 for char in cleaned):
        raise ValueError("识别器名字不能带控制字符")
    if cleaned == ALWAYS_LABEL:
        # `when: "always"` 是"无条件边"的哨兵值（conditions.ALWAYS_LABEL），
        # 拿它当识别器名字，边就会在"永远成立"和"等这个标签命中"之间产生歧义
        raise ValueError(f"「{ALWAYS_LABEL}」是保留名（表示无条件），换一个")
    return cleaned


def _rename_score_refs(value: object, old: str, new: str) -> int:
    """把动作里 `{"$score": "旧标签"}` 改成新标签，返回改了几处。

    动作参数可以是任意嵌套结构（列表里套对象、对象里套列表），所以这里递归走一遍：
    漏掉一层就会留下"引用了不存在的识别器"，而且是保存时报错、跑起来才发现。
    """
    count = 0
    if isinstance(value, dict):
        if value.get("$score") == old:
            value["$score"] = new
            count += 1
        for item in value.values():
            count += _rename_score_refs(item, old, new)
    elif isinstance(value, list):
        for item in value:
            count += _rename_score_refs(item, old, new)
    return count
