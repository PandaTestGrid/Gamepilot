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
from .actions import Action
from .conditions import Condition, ConditionTimer
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
        # 限时等待（condition.within_ms）的计时状态
        self.condition_timer = ConditionTimer()
        self.transition_timeout_ms = timeout
        self.current: str | None = start_node
        self.pending: Pending | None = None
        self.detections: dict[str, Detection] = {}
        self.stats = {"ticks": 0, "actions": 0, "transitions": 0, "failed": 0, "recoveries": 0}
        self._timeout_reported: set[str] = set()
        # 本次"进入节点"期间已经触发过的边（dst 为空的边默认只触发一次，
        # 否则 14fps 下会每帧点一次 —— 实测会连点 5 次）
        self._fired_in_node: set[str] = set()
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
                self._fired_in_node.add(edge.id)
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
                self._fired_in_node.add(edge.id)
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

    def locate(self) -> str | None:
        """当前在哪个界面。

        正在跑状态机时就是 `current`；没跑（录制脚本时）也能只看当前帧的识别结果判断，
        这样"录下来的这一步属于哪个界面"才准。
        """
        if self.current:
            return self.current
        node_id, score = self._resolve()
        if node_id:
            self._enter(node_id, score)
            return node_id
        return None

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
        """条件是否成立（可带限时等待）。

        返回 False 的原因有三种：条件没成立、冷却中、限时等待超时。
        超时会发一条 `edge_timeout` 事件（每条边每次进入节点只报一次），
        这样"等界面出现最多 10 秒"这种意图在事件栏能看见，而不是静默什么都不做。
        """
        if edge.id in self._fired_in_node and (edge.dst is None or edge.cooldown_ms <= 0):
            # 这次访问已经做过了：不再考虑它，也**不该再报"等待超时"**
            # （真机跑脚本时踩到过：边执行完 1.5 秒后又多报一条 edge_timeout）
            return False
        condition = edge.condition
        status = self.condition_timer.check(self.current, edge.id, condition.within_ms, time.time())
        if status == "timeout":
            key = f"{self.current}:{edge.id}"
            if key not in self._timeout_reported:
                self._timeout_reported.add(key)
                self._emit(
                    "edge_timeout",
                    node=self.current,
                    edge=edge,
                    message=f"等待超时（{condition.within_ms}ms 内未满足: {condition.describe()}）",
                )
            return False
        if status == "wait" and not condition.matches(self.detections):
            # 在限时窗口内：条件成立就立刻走，不成立就继续等
            return False
        if not condition.matches(self.detections):
            return False
        if edge.min_score and edge.min_score > condition.min_score:
            # 兼容老字段：边上的 min_score 仍然生效
            primary = self.detections.get(edge.when)
            if primary is None or primary.score < edge.min_score:
                return False
        cooldown = edge.cooldown_ms / 1000
        if cooldown <= 0:
            return True
        return time.time() - self._last_fire.get(edge.id, 0.0) >= cooldown

    def _timeout_key(self, node_id: str | None, edge_id: str) -> str:
        return f"{node_id}:{edge_id}"

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
        # 进入新节点：限时等待重新计时
        self.condition_timer.arm(node_id, time.time())
        self._timeout_reported = {item for item in self._timeout_reported if not item.startswith(f"{node_id}:")}
        self._fired_in_node = set()  # 新的一次访问：动作可以再做一遍
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
            target = self.graph.nodes.get(pending.dst)
            if target is not None and all(
                self.detections.get(label) is not None and self.detections[label].state == "confirmed"
                for label in target.enter
            ):
                # 带上真实分数（事件栏里显示"进入 X (score=…)"才有意义）
                score = min((float(self.detections[label].score) for label in target.enter), default=0.0)
                self.stats["transitions"] += 1
                self.pending = None
                self._enter(pending.dst, score)
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

    def run_action(self, action: dict[str, Any]) -> str:
        """只执行一个动作（调试用"单独跑这一步"），不影响状态机当前位置。

        复用 _execute 那一套（识别器目标解析、等待、按键…），避免两处实现走偏。
        """
        from .actions import Action

        parsed = Action.parse(action)
        edge = Edge(
            id="__manual__",
            when="",
            src=self.current,
            dst=None,
            action=parsed.to_dict(),
            condition=Condition(always=True),
        )
        self._execute(edge)
        self._emit("action_manual", node=self.current, edge=edge, message=f"单独执行：{parsed.describe()}")
        return parsed.describe()

    def _execute(self, edge: Edge) -> None:
        """执行一条边上的动作。

        除了 `wait`，动作都是"发出去就返回"：是否真的切了界面，由后续帧的条件确认
        （低帧率 + 高延迟下这样才不会把时序搞乱）。
        """
        try:
            action = Action.parse(edge.action, fallback_target=edge.action_fallback_target)
        except ValueError as exc:
            self.stats["failed"] += 1
            self._emit("action_failed", node=self.current, edge=edge, message=str(exc))
            return

        try:
            if action.type == "wait":
                time.sleep(action.seconds)
                self._emit("action_executed", node=self.current, edge=edge, message=action.describe())
                return

            if action.type == "key":
                self._press(action.value)
                self.stats["actions"] += 1
                self._emit("action_executed", node=self.current, edge=edge, message=action.describe())
                return

            if action.type == "text":
                self.controller.text(action.value)
                self.stats["actions"] += 1
                self._emit("action_executed", node=self.current, edge=edge, message=action.describe())
                return

            start_point = self._resolve_point(action, action.target, action.x, action.y)
            if action.type == "click":
                self.controller.click(start_point[0], start_point[1])
                self.stats["actions"] += 1
                self._emit(
                    "action_executed",
                    node=self.current,
                    edge=edge,
                    message=f"click({start_point[0]:.3f},{start_point[1]:.3f})",
                )
            elif action.type == "long_press":
                self._long_press(start_point[0], start_point[1], action.duration_ms)
                self.stats["actions"] += 1
                self._emit(
                    "action_executed",
                    node=self.current,
                    edge=edge,
                    message=f"long_press({start_point[0]:.3f},{start_point[1]:.3f},{action.duration_ms}ms)",
                )
            elif action.type == "swipe":
                end_point = self._resolve_point(action, action.to_target, action.to_x, action.to_y, allow_auto=True)
                self.controller.swipe(
                    start_point[0], start_point[1], end_point[0], end_point[1], duration=action.duration_ms / 1000.0
                )
                self.stats["actions"] += 1
                self._emit(
                    "action_executed",
                    node=self.current,
                    edge=edge,
                    message=(
                        f"swipe({start_point[0]:.2f},{start_point[1]:.2f} → "
                        f"{end_point[0]:.2f},{end_point[1]:.2f}, {action.duration_ms}ms)"
                    ),
                )
        except Exception as exc:
            self.stats["failed"] += 1
            self._emit("action_failed", node=self.current, edge=edge, message=f"{action.type} 失败: {exc}")

    def _resolve_point(
        self,
        action: Action,
        target: str | None,
        x: float | None,
        y: float | None,
        *,
        allow_auto: bool = False,
    ) -> tuple[float, float]:
        """把"目标标签 / 矩形 / 坐标"统一解析成归一化点。

        `allow_auto=True`（滑动终点用）：标签没命中、也没给坐标时，
        退化成"沿同一条线的反向滑动"，总比什么都不做强。
        """
        if target:
            detection = self.detections.get(target)
            if detection is not None:
                return detection.rect.center
            if not allow_auto:
                raise ValueError(f"目标 {target} 当前没有命中，无法定位")
        if action.rect is not None:
            rect = action.rect
            return (rect[0] + rect[2] / 2, rect[1] + rect[3] / 2)
        if x is not None and y is not None:
            return (x, y)
        if allow_auto:
            return (0.5, 0.5)
        raise ValueError(f"{action.type} 缺少可定位的目标: {action.to_dict()}")

    def _press(self, name: str) -> None:
        """功能键：优先用控制器的 press（scrcpy 控制通道），否则回退 key。"""
        controller = self.controller
        if hasattr(controller, "press"):
            controller.press(name)
        else:
            controller.key(name)

    def _long_press(self, x: float, y: float, duration_ms: int) -> None:
        """长按：有实时触控能力就按下-等待-抬起，否则退化成一次点击。"""
        controller = self.controller
        if hasattr(controller, "touch"):
            controller.touch("down", x, y)
            time.sleep(max(0.05, duration_ms / 1000.0))
            controller.touch("up", x, y)
        else:
            controller.click(x, y)

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
