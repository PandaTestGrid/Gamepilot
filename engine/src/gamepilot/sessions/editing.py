"""GraphEditingService: extracted session responsibility; shared state belongs to DeviceSession."""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

import cv2

from ..core.actions import Action
from ..core.conditions import ALWAYS_LABEL
from ..core.flow_model import validate_flow
from ..core.flow_record import action_to_flow_step
from ..core.graph import GRAPH_WRITE_LOCK, Edge, Graph, Node

if TYPE_CHECKING:
    from .device import DeviceSession

from .graph_ops import (
    graph_edge_add,
    graph_node_add,
    graph_node_remove,
    graph_node_update,
    graph_remove_recognizer,
    graph_rename_recognizer,
    next_node_id,
)
from .models import _load_graph, flow_steps


class GraphEditingService:
    def __init__(self, session: DeviceSession) -> None:
        self.session = session

    def _require_workflow(self) -> None:
        """写盘类操作的前置检查：没有选择工作流时报中文错误（契约 §2.4），不崩、不写到 cwd。"""
        if not self.session.project.root:
            raise ValueError("还没有选择工作流")

    def record_action(self, action: dict[str, Any], *, to: str | None = None) -> dict[str, Any]:
        self.session._require_workflow()
        if self.session._root_busy(self.session.project.root):
            raise ValueError("运行中不能修改流程图，请先停止")
        """把手动操作录成工作流里的一步。

        - 有 `flow.steps`：追加到链尾（步骤链真源，Automa 式画布会立刻看到）。
        - 否则：仍写 nodes/edges 状态图（兼容旧工作流 / 测试）。
        """
        with self.session.lock:
            parsed = Action.parse(action)
            if flow_steps(self.session.graph):
                return self.session._record_flow_action(parsed)
            # 这一步挂在哪个界面上？按"能录就录"的顺序找：
            #   ① 当前帧能确认在哪个界面（最准）
            #   ② 本会话内最近录过的界面（刚录完模板就点一下的常见场景）
            #   ③ 工作流里最后一个界面（应用重启后 _last_node_id 会丢，但 graph.json 还在）
            #   ④ 一个都没有 → 自动用当前画面建一个界面，别让用户卡在"录不了"
            # 刚录过模板（2 分钟内）时，用户下一步的意图就是"在这个界面上做"，
            # 优先用它：否则自动建的界面（模板就取自当前画面，必然匹配）会把归属抢走
            recent_node = (
                self.session._last_node_id
                if self.session._last_node_id and time.time() - self.session._last_node_at < 120
                else None
            )
            source = recent_node or self.session.engine.locate() or self.session._latest_node_id()
            created_for_recording = None
            if source is None:
                source, created_for_recording = self.session._auto_create_node_for_recording()
            if created_for_recording:
                self.session.emit(
                    "engine.event",
                    {
                        "deviceId": self.session.device_id,
                        "seq": self.session._input_seq,
                        "ts": time.time(),
                        "type": "node_auto_created",
                        "node": created_for_recording,
                        "message": f"工作流里还没有界面，已用当前画面自动建了「{created_for_recording}」",
                    },
                )
            when = ""
            if source and source in self.session.graph.nodes:
                enter = self.session.graph.nodes[source].enter
                if enter:
                    when = enter[0]
            condition = {"all_of": [when]} if when else {"always": True}
            edge_id = f"e_rec_{len(self.session.graph.edges) + 1}"
            while any(edge.id == edge_id for edge in self.session.graph.edges):
                edge_id = f"{edge_id}_x"
            edge = Edge.from_dict(
                {
                    "id": edge_id,
                    "when": when or ALWAYS_LABEL,
                    "from": source,
                    "to": to,
                    # 一步只做一次：进入节点后 600ms 内不重复（避免 14fps 下连点）
                    "cooldown_ms": 600,
                    "condition": condition,
                    "action": parsed.to_dict(),
                }
            )
            self.session.graph.add_edge(edge)
            self.session.graph.validate()
            self.session.graph.save()
            self.session.reload_graph()
            self.session._pending_edge_id = edge_id
            self.session.emit(
                "engine.event",
                {
                    "deviceId": self.session.device_id,
                    "seq": self.session._input_seq,
                    "ts": time.time(),
                    "type": "action_recorded",
                    "node": source,
                    "edge": edge_id,
                    "message": f"录制步骤 {edge_id}: {parsed.describe()}",
                },
            )
            return {"edgeId": edge_id, "graph": self.session.graph.to_dict()}

    def _record_flow_action(self, parsed: Action) -> dict[str, Any]:
        step = action_to_flow_step(parsed)
        steps = list(flow_steps(self.session.graph))
        steps.append(step)
        self.session.graph.flow = validate_flow({"steps": steps}, set(self.session.graph.recognizers), strict=False)
        self.session.graph.validate()
        self.session.graph.save()
        self.session.reload_graph()
        step_id = str(step["id"])
        self.session.emit(
            "engine.event",
            {
                "deviceId": self.session.device_id,
                "seq": self.session._input_seq,
                "ts": time.time(),
                "type": "action_recorded",
                "node": step_id,
                "edge": None,
                "message": f"录制模块 {step_id}: {parsed.describe()}",
            },
        )
        return {"stepId": step_id, "edgeId": step_id, "graph": self.session.graph.to_dict()}

    def _latest_node_id(self) -> str | None:
        """工作流里最后一个界面（dict 保序，所以就是最后加进去的那个）。"""
        return next(reversed(self.session.graph.nodes), None) if self.session.graph.nodes else None

    def _auto_create_node_for_recording(self) -> tuple[str, str | None]:
        """当前画面还没对应界面时，自动建一个（顺手用画面中部做模板，好让状态机能认出它）。"""
        if self.session.last_frame is None:
            raise RuntimeError("还没有可用画面：先连接设备、等到画面出来，再开「录操作」")
        # id 分配走同一个 helper：这里的 index 还要拿来起名字（`界面3`），所以自己算一遍序号
        node_id = next_node_id(self.session.graph)
        index = int(node_id.removeprefix("n_"))
        name = f"界面{index}"

        # 用画面中部 60% 当模板：避开状态栏时钟/通知这类一直在变的地方
        height, width = self.session.last_frame.shape[:2]
        crop = self.session.last_frame[int(height * 0.2) : int(height * 0.8), int(width * 0.2) : int(width * 0.8)]
        label = f"{node_id}_screen"
        filename = f"{label}.png"
        path = f"{self.session.project.templates_dir}/{filename}"
        if not cv2.imwrite(path, crop):
            raise RuntimeError(f"模板图写入失败：{path}")
        self.session.graph.add_recognizer(
            label,
            {
                "type": "template",
                "template": f"templates/{filename}",
                "threshold": 0.8,
                "roi": [0.2, 0.2, 0.6, 0.6],
            },
        )
        self.session.graph.upsert_node(Node(id=node_id, name=name, enter=[label]))
        self.session._last_node_id = node_id
        self.session._last_node_at = time.time()
        return node_id, name

    def graph_node_add(self, node_id: str | None, name: str | None, enter: list[str] | None) -> dict[str, Any]:
        self.session._require_workflow()
        with self.session.lock:
            result = graph_node_add(self.session.graph, node_id, name, enter)
            self.session.graph.save()
            self.session.reload_graph()
            return result

    def graph_node_update(self, node_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        self.session._require_workflow()
        with self.session.lock:
            result = graph_node_update(self.session.graph, node_id, patch)
            self.session.graph.save()
            self.session.reload_graph()
            return result

    def graph_node_remove(self, node_id: str) -> dict[str, Any]:
        self.session._require_workflow()
        with self.session.lock:
            result = graph_node_remove(self.session.graph, node_id)
            self.session.graph.save()
            self.session.reload_graph()
            return result

    def graph_edge_add(
        self,
        *,
        src: str | None,
        dst: str | None,
        when: str | None = None,
        action: dict[str, Any] | None = None,
        condition: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.session._require_workflow()
        with self.session.lock:
            result = graph_edge_add(self.session.graph, src=src, dst=dst, when=when, action=action, condition=condition)
            self.session.graph.save()
            self.session.reload_graph()
            return result

    def rename_recognizer(self, old: str, new: str) -> dict[str, Any]:
        self.session._require_workflow()
        """给识别器改名（级联所有引用），落盘 → 热重载。

        和 `remove_recognizer` 相反：改名是**可以**在还被引用时做的 ——
        因为引用会一起改（见 `Graph.rename_recognizer`）。
        改完必须 `save()` + `reload_graph()`：不重载的话，引擎里跑的还是旧标签的识别器，
        画面上的分数会一直挂在旧名字上。
        """
        with self.session.lock, GRAPH_WRITE_LOCK:
            self.session.graph = _load_graph(self.session.project)
            result = graph_rename_recognizer(self.session.graph, old, new)
            self.session.graph.save()
            self.session.reload_graph()
            return result

    def remove_recognizer(self, label: str) -> dict[str, Any]:
        self.session._require_workflow()
        """删掉一个模板/识别器。

        被别处引用时**拒绝删除**并说清被谁用了 —— 直接删会让工作流变成"引用了不存在的东西"，
        跑起来才发现（比删不掉更糟）。
        """
        with self.session.lock, GRAPH_WRITE_LOCK:
            self.session.graph = _load_graph(self.session.project)
            result = graph_remove_recognizer(self.session.graph, label, project_root=self.session.project.root)
            self.session.graph.save()
            self.session.reload_graph()
            return result

    def set_threshold(self, label: str, threshold: float) -> dict[str, Any]:
        self.session._require_workflow()
        with self.session.lock, GRAPH_WRITE_LOCK:
            self.session.graph = _load_graph(self.session.project)
            self.session.graph.set_threshold(label, threshold)
            self.session.graph.save()
            self.session.reload_graph()
            return {"label": label, "threshold": threshold}

    def set_recognizer_search(self, label: str, search: str) -> dict[str, Any]:
        """切换模板的搜索范围（region / full），落盘并热重载。

        和改阈值一样允许在运行中调整：搜索范围只影响"在哪找"，不改图结构。
        """
        self.session._require_workflow()
        with self.session.lock, GRAPH_WRITE_LOCK:
            self.session.graph = _load_graph(self.session.project)
            result = self.session.graph.set_recognizer_search(label, search)
            self.session.graph.save()
            self.session.reload_graph()
            return result

    def save_graph(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.session._require_workflow()
        if self.session._root_busy(self.session.project.root):
            raise ValueError("运行中不能修改流程图，请先停止")
        with self.session.lock, GRAPH_WRITE_LOCK:
            graph = Graph.from_dict(payload, base_dir=self.session.project.root, path=self.session.project.graph_path)
            graph.save()
            self.session.reload_graph()
            return graph.to_dict()
