"""状态机运行时（DESIGN.md §7 的语义实现）。

一次 `tick(frame)` = 感知 → 决策 → 动作，**非阻塞**：
动作执行后挂起一个 pending 转换，下一帧再确认是否真的切过去了。
这样低帧率（5~10fps）与高延迟（adb 转发）都不会把时序搞乱，
失败也能被计数、重试、上报，而不是静默跑在错误状态上。

recovery 边（弹窗/掉线这类中断）优先于一切普通边，执行后进入 settle，
等触发标签消失再重新定位所处界面。
"""

from __future__ import annotations

import contextlib
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..devices.base import Controller
from .frame import Detection, Frame
from .graph import Edge, Graph
from .recognizer import VoteFilter, perceive
from .trace import TraceBuffer, TraceEvent


@dataclass
class Pending:
    kind: str  # transition | settle
    edge: Edge
    dst: str | None = None
    absent: str | None = None
    deadline: float = 0.0
    attempt: int = 1


class Engine:
    def __init__(
        self,
        graph: Graph,
        controller: Controller,
        *,
        trace: TraceBuffer | None = None,
        on_event: Callable[[TraceEvent], None] | None = None,
        vote: int | None = None,
        transition_timeout_ms: int | None = None,
        start_node: str | None = None,
    ) -> None:
        self.graph = graph
        self.controller = controller
        self.trace = trace or TraceBuffer()
        self.on_event = on_event
        vote_window = vote if vote is not None else _as_int(graph.default("vote", 2), 2)
        timeout = (
            transition_timeout_ms
            if transition_timeout_ms is not None
            else _as_int(graph.default("transition_timeout_ms", 4000), 4000)
        )
        self.vote = VoteFilter(vote_window)
        self.transition_timeout_ms = timeout
        self.current: str | None = start_node
        self.pending: Pending | None = None
        self.detections: dict[str, Detection] = {}
        self.stats = {"ticks": 0, "actions": 0, "transitions": 0, "failed": 0, "recoveries": 0}
        self.seq = 0
        self._outbox: list[TraceEvent] = []
        self._last_fire: dict[str, float] = {}
        self._entered_at = time.time()

    # ------------------------------------------------------------------ #
    # 感知
    # ------------------------------------------------------------------ #

    def perceive(self, frame: Frame) -> dict[str, Detection]:
        self.detections = perceive(self.graph.recognizers, frame, self.vote)
        return self.detections

    # ------------------------------------------------------------------ #
    # 一次 tick
    # ------------------------------------------------------------------ #

    def tick(self, frame: Frame) -> list[TraceEvent]:
        self._outbox = []
        detections = self.perceive(frame)
        self.stats["ticks"] += 1
        self.trace.add_frame(frame.index, self.current, [item.to_dict() for item in detections.values()])

        # 0) 有挂起转换：先确认它，本帧不再做新决策
        if self.pending is not None:
            self._advance_pending()
            return self._outbox

        # 1) recovery 边优先于一切普通边
        for edge in self._recoveries():
            if self._guard_ok(edge):
                self.stats["recoveries"] += 1
                self._emit("recovery_matched", node=self.current, edge=edge, message=f"中断: {edge.when}")
                self._execute(edge)
                self._last_fire[edge.id] = time.time()
                # 关掉弹窗后要确认它真的消失了，再重新定位所处界面
                self.pending = Pending(
                    kind="settle",
                    edge=edge,
                    absent=edge.when,
                    deadline=time.time() + self.transition_timeout_ms / 1000,
                )
                return self._outbox

        # 2) 不知道自己在哪里 → 全局重新定位
        if self.current is None or self.current not in self.graph.nodes:
            node_id, score = self._resolve()
            if node_id:
                self._enter(node_id, score)
            return self._outbox

        # 3) 选优先级最高的可执行边
        for edge in self._outgoing(self.current):
            if self._guard_ok(edge):
                self._emit("edge_matched", node=self.current, edge=edge, message=f"{edge.when} → {edge.dst or '原地'}")
                self._execute(edge)
                self._last_fire[edge.id] = time.time()
                if edge.dst:
                    self.pending = Pending(
                        kind="transition",
                        edge=edge,
                        dst=edge.dst,
                        deadline=time.time() + self.transition_timeout_ms / 1000,
                    )
                return self._outbox

        return self._outbox

    # ------------------------------------------------------------------ #
    # 内部
    # ------------------------------------------------------------------ #

    def _recoveries(self) -> list[Edge]:
        return sorted(
            (edge for edge in self.graph.edges if edge.kind == "recovery" and edge.src is None),
            key=lambda item: item.priority,
            reverse=True,
        )

    def _outgoing(self, node_id: str) -> list[Edge]:
        return sorted(
            (edge for edge in self.graph.edges if edge.kind == "normal" and edge.src == node_id),
            key=lambda item: item.priority,
            reverse=True,
        )

    def _guard_ok(self, edge: Edge) -> bool:
        detection = self.detections.get(edge.when)
        if detection is None or detection.state != "confirmed" or detection.score < edge.min_score:
            return False
        cooldown = edge.cooldown_ms / 1000
        if cooldown <= 0:
            return True
        return time.time() - self._last_fire.get(edge.id, 0.0) >= cooldown

    def _resolve(self) -> tuple[str | None, float]:
        best: tuple[str | None, float] = (None, 0.0)
        for node in self.graph.nodes.values():
            if not node.enter:
                continue
            scores = []
            for label in node.enter:
                detection = self.detections.get(label)
                if detection is None or detection.state != "confirmed":
                    break
                scores.append(detection.score)
            else:
                score = min(scores)
                if score > best[1]:
                    best = (node.id, score)
        return best

    def _enter(self, node_id: str, score: float) -> None:
        changed = node_id != self.current
        self.current = node_id
        self._entered_at = time.time()
        if changed:
            self.vote.reset()
            self._emit(
                "node_entered",
                node=node_id,
                message=f"进入 {self.graph.nodes[node_id].name or node_id} (score={score:.3f})",
                extra={"score": round(score, 4)},
            )

    def _advance_pending(self) -> None:
        pending = self.pending
        if pending is None:
            return
        if pending.kind == "transition" and pending.dst:
            node = self.graph.nodes.get(pending.dst)
            ready = node is not None and all(
                self.detections.get(label) is not None and self.detections[label].state == "confirmed"
                for label in node.enter
            )
            if ready:
                self.stats["transitions"] += 1
                self.pending = None
                self._enter(pending.dst, 0.0)
                return
        elif pending.kind == "settle":
            if pending.absent not in self.detections:
                self.pending = None
                node_id, score = self._resolve()
                self._emit(
                    "recovery_done", node=node_id, edge=pending.edge, message=f"中断已解除 → {node_id or '未知界面'}"
                )
                if node_id:
                    self._enter(node_id, score)
                return

        if time.time() >= pending.deadline:
            if pending.kind == "transition" and pending.attempt < max(1, pending.edge.retries):
                pending.attempt += 1
                pending.deadline = time.time() + self.transition_timeout_ms / 1000
                self._emit("transition_retry", node=self.current, edge=pending.edge, message=f"重试进入 {pending.dst}")
                return
            self.stats["failed"] += 1
            self.pending = None
            self._emit(
                "transition_failed", node=self.current, edge=pending.edge, message=f"进入 {pending.dst or '-'} 超时"
            )

    def _execute(self, edge: Edge) -> None:
        action = edge.action or {}
        kind = str(action.get("type", "click"))
        try:
            if kind == "click":
                target = action.get("target")
                point = None
                if isinstance(target, str) and target:
                    detection = self.detections.get(target)
                    if detection is not None:
                        point = detection.rect.center
                else:
                    rect_value = action.get("rect")
                    if isinstance(rect_value, list):
                        point = _rect_center(rect_value)
                    elif action.get("x") is not None:
                        point = (_as_float(action.get("x"), 0.0), _as_float(action.get("y"), 0.0))
                if point is None:
                    raise ValueError(f"click 缺少可定位的目标: {action}")
                self.controller.click(point[0], point[1])
                self.stats["actions"] += 1
                self._emit(
                    "action_executed", node=self.current, edge=edge, message=f"click({point[0]:.3f},{point[1]:.3f})"
                )
            elif kind == "wait":
                time.sleep(_as_float(action.get("seconds"), 0.5))
                self._emit("action_executed", node=self.current, edge=edge, message="wait")
            elif kind == "key":
                self.controller.key(str(action.get("value", "")))
                self.stats["actions"] += 1
                self._emit("action_executed", node=self.current, edge=edge, message=f"key({action.get('value')})")
            else:
                raise ValueError(f"未支持的动作类型: {kind}")
        except Exception as exc:
            self.stats["failed"] += 1
            self._emit("action_failed", node=self.current, edge=edge, message=f"{kind} 失败: {exc}")

    def _emit(
        self,
        type_: str,
        *,
        node: str | None = None,
        edge: Edge | None = None,
        message: str = "",
        extra: dict[str, Any] | None = None,
    ) -> TraceEvent:
        self.seq += 1
        event = TraceEvent(
            seq=self.seq,
            ts=time.time(),
            type=type_,
            node=node if node is not None else self.current,
            edge=edge.id if edge else None,
            message=message,
            extra=extra or {},
        )
        self.trace.add_event(event)
        self._outbox.append(event)
        if self.on_event:
            with contextlib.suppress(Exception):
                self.on_event(event)
        return event

    def state(self) -> dict[str, Any]:
        return {
            "current": self.current,
            "pending": self.pending.edge.id if self.pending else None,
            "tick": self.stats["ticks"],
            "stats": dict(self.stats),
            "detections": [item.to_dict() for item in self.detections.values()],
        }


def _rect_center(rect: list[Any]) -> tuple[float, float]:
    x, y, w, h = (_as_float(item, 0.0) for item in rect[:4])
    return (x + w / 2, y + h / 2)


def _as_float(value: Any, fallback: float) -> float:
    """DSL 里的数字可能是 int/float/字符串，统一安全转换（坏值退回默认）。"""
    if isinstance(value, bool):
        return fallback
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return fallback
    return fallback


def _as_int(value: Any, fallback: int) -> int:
    return int(_as_float(value, float(fallback)))
