"""顺序执行 `graph.flow.steps` 的步骤链引擎。"""

from __future__ import annotations

import contextlib
import copy
import itertools
import random
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..devices.base import Controller
from .actions import Action
from .bezier_trajectory import (
    ActionCancelledError,
    ActionDeferredError,
    apply_point_jitter,
    execute_swipe,
    execute_tap,
    generate_swipe_track,
    generate_tap_track,
    normalize_path,
    resolve_click_human,
    resolve_swipe_bezier,
    resolve_swipe_points,
)
from .evidence import RunEvidence
from .flow_model import STEP_KINDS, explicit_click_target_mode
from .frame import Detection, Frame, best_per_label
from .graph import Graph
from .recognizer import TemplateRecognizer, VoteFilter, perceive
from .selection import select_rects
from .state_machine import describe_action
from .touch_scheduler import TouchHandle, TouchOwner, get_touch_scheduler
from .trace import TraceBuffer, TraceEvent
from .variables import VariableStore, VarValue, resolve_spec, resolve_value

#: 单次 tick 最多推进步数
MAX_STEPS_PER_TICK = 200
#: 即便没有设备动作，条件/赋值/错误循环也必须及时让出采集线程。
MAX_ADVANCE_SECONDS = 0.01


def _as_int(value: object, fallback: int) -> int:
    """`graph.default()` 非整数时用 fallback。"""
    return value if isinstance(value, int) and not isinstance(value, bool) else fallback


def _is_pending_link(step: dict[str, Any]) -> bool:
    params = step.get("params")
    return isinstance(params, dict) and bool(params.get("_pendingLink"))


def _is_norm_rect(value: object) -> bool:
    return _coerce_norm_rect(value) is not None


def _coerce_norm_rect(value: object) -> list[float] | None:
    """归一化 [x,y,w,h]：兼容 list / 部分 JSON 对象写法。"""
    raw: list[object] | None = None
    if isinstance(value, (list, tuple)) and len(value) == 4:
        raw = list(value)
    elif isinstance(value, dict) and all(key in value for key in ("x", "y", "w", "h")):
        raw = [value["x"], value["y"], value["w"], value["h"]]
    if raw is None:
        return None
    try:
        x, y, w, h = (float(str(item)) for item in raw)
    except (TypeError, ValueError):
        return None
    if not (w > 0 and h > 0 and 0 <= x <= 1 and 0 <= y <= 1 and x + w <= 1.001 and y + h <= 1.001):
        return None
    return [x, y, w, h]


def _normalize_click_params(params: dict[str, Any]) -> dict[str, Any]:
    coerced = _coerce_norm_rect(params.get("rect"))
    if coerced is None:
        return params
    return {**params, "rect": coerced}


def _click_target_mode(params: dict[str, Any]) -> str:
    """与桌面端 `clickTargetMode` 对齐：坐标 / 随机范围 / 识别器。"""
    by = explicit_click_target_mode(params)
    if by is not None:
        return by
    rec = str(params.get("rec") or "").strip()
    if _is_norm_rect(params.get("rect")) and not rec:
        return "region"
    if rec:
        return "recognizer"
    return "coord"


#: 需要"等到识别命中"的步骤
_CONDITION_KINDS = ("wait", "cond")

#: 块的收尾/分隔标记：是块结构的一部分，不参与"未接入"判定
_BLOCK_END_KINDS = ("else", "condend", "loopend", "parallelbranch", "parallelend")

#: "做一件事"的步骤 → 引擎 Action 的类型
_ACTION_KINDS = {"click": "click", "hold": "long_press", "swipe": "swipe", "key": "key", "text": "text"}


def _branch_marks(steps: list[dict[str, Any]]) -> tuple[dict[int, tuple[int | None, int]], dict[int, int]]:
    """「条件」分叉的下标映射。

    返回 (每个「条件」→ (否则下标|None, 条件结束下标), 每个「否则」→ 对应的「条件结束」下标)。
    校验（`validate_flow`）已保证标记严格 LIFO 配对，这里对坏结构**只跳过不抛** ——
    一份手改坏的图不该把采集线程打死。
    """
    cond_else: dict[int, int] = {}
    cond_end: dict[int, int] = {}
    open_conds: list[int] = []
    for index, step in enumerate(steps):
        kind = step.get("type")
        if kind == "cond":
            open_conds.append(index)
        elif kind == "else":
            if open_conds:
                cond_else[open_conds[-1]] = index
        elif kind == "condend" and open_conds:
            cond_end[open_conds.pop()] = index
    branches = {ci: (cond_else.get(ci), cond_end.get(ci, -1)) for ci in cond_end}
    else_to_end = {e: end for (e, end) in branches.values() if e is not None}
    return branches, else_to_end


def _loop_marks(steps: list[dict[str, Any]]) -> dict[int, tuple[int, int]]:
    """每个「循环」→ (循环体首步下标, 「循环结束」下标)。"""
    open_loops: list[int] = []
    out: dict[int, tuple[int, int]] = {}
    for index, step in enumerate(steps):
        kind = step.get("type")
        if kind == "loop":
            open_loops.append(index)
        elif kind == "loopend" and open_loops:
            loop_index = open_loops.pop()
            out[loop_index] = (loop_index + 1, index)
    return out


@dataclass
class _LoopFrame:
    loop_index: int
    body_start: int
    remaining: int
    total: int


def _as_var_value(value: object) -> VarValue:
    """把 `resolve_value` 的结果收窄成变量能存的值（表达式算出 list/dict 时就转字符串）。"""
    if isinstance(value, (bool, int, float, str)):
        return value
    return str(value)


@dataclass
class _Blocking:
    """当前把游标挡住的那一步（等待识别 / 延时）的计时状态。"""

    step_id: str
    started_at: float
    entered_frame: int
    stable: int = 0
    random_wait_ms: int | None = None


def _public_params(params: dict[str, Any]) -> dict[str, Any]:
    """去掉引擎内部参数（`_` 开头），值收成 JSON 能放下的形状（写进事件 extra）。"""
    out: dict[str, Any] = {}
    for key, value in params.items():
        if key.startswith("_"):
            continue
        if value is None or isinstance(value, (str, int, float, bool, list, dict)):
            out[key] = value
        else:
            out[key] = str(value)
    return out


@dataclass
class FlowEngine:
    """把 `graph.flow.steps` 一步步执行掉。"""

    graph: Graph
    controller: Controller
    trace: TraceBuffer = field(default_factory=TraceBuffer)
    on_event: Callable[[TraceEvent], None] | None = None
    on_call: Callable[[str], None] | None = None
    # 只保护设备动作事务；识别/证据/事件不持输入锁，手动触控不会被慢识别阻塞。
    input_guard: Callable[[], contextlib.AbstractContextManager[None]] | None = None

    def __post_init__(self) -> None:
        self.steps: list[dict[str, Any]] = list((self.graph.flow or {}).get("steps") or [])
        self._cond_branches, self._else_to_end = _branch_marks(self.steps)
        self._else_owner = {
            else_index: cond_index
            for cond_index, (else_index, _end) in self._cond_branches.items()
            if else_index is not None
        }
        self._end_owner = {
            end_index: cond_index for cond_index, (_else, end_index) in self._cond_branches.items() if end_index >= 0
        }
        self._loop_marks = _loop_marks(self.steps)
        self._loop_stack: list[_LoopFrame] = []
        self._parallel_children: list[FlowEngine] = []
        self._parallel_end = -1
        self._parent: FlowEngine | None = None
        self._root: FlowEngine = self
        self._branch_path: list[int] = []
        self._range_start = 0
        self._range_end: int | None = None
        self._touch_owner = TouchOwner(f"flow:{uuid.uuid4().hex}")
        self._default_finger = 1
        self._touch_handle: TouchHandle | None = None
        self._assigned_finger: int | None = None
        self._cancelled_contact = False
        self._owner_cancelled = False
        self._touch_step: str | None = None
        self._action_finger = 1
        self._perception_cache: dict[tuple[int, tuple[tuple[str, str], ...]], dict[str, Detection]] = {}
        self.cursor = 0
        self._start_cursor = 0
        self.blocking: _Blocking | None = None
        self.current: str | None = self.steps[0]["id"] if self.steps else None
        # 和状态机保持同一个形状：会话/状态面板读的都是这几个字段
        self.pending: None = None
        self.detections: dict[str, Detection] = {}
        self.variables = VariableStore()
        self.breakpoints: set[str] = set()
        self.paused_at: str | None = None
        # 单步：`_entries` 记"进入步骤"的次数；恢复/单步时把基准设成"下一步"，
        # 下一次进入新步骤（含循环再入同一节）就停 —— 用计数器而不是比较 step_id，
        # 否则"循环体只有一个步骤"时永远停不下来。
        self._entries = 0
        self._skip_entry = -1
        self._pause_next = False
        # 出错重试的冷却时间点（`retry_interval_ms`）：到点之前不推进游标
        self._retry_ready_at = 0.0
        self._stop_requested = threading.Event()
        self.result = "idle"  # idle | running | success | failure | cancelled
        # 调用子工作流时当前链挂起：不是用户暂停，也不发 flow_finished。
        # `_runner_busy` 仍算占用（不能编辑/重复启动），但不参与 tick。
        self.waiting = False
        self.waiting_for: str | None = None
        self.stats = {"ticks": 0, "actions": 0, "steps": 0, "failed": 0}
        self.seq = 0
        self._outbox: list[TraceEvent] = []
        self._breakpoint_passed: set[str] = set()
        # 已经报过"开始"的那一步：等待/延时会跨很多帧，不能每帧都重报一次 step_started
        self._announced: str | None = None
        # 从「未接入」模块开跑：只跑这段游离片段，不要补上包围它的循环
        self._detached_start = False
        self._error_retries: dict[str, int] = {}
        self._vote = VoteFilter(_as_int(self.graph.default("vote", 2), 2))
        # 这一拍每个标签实际用的搜索范围：步骤切换范围时用它判断要不要按需重识别
        self._detection_scope: dict[str, str] = {}
        self._break_after: dict[int, str] = {}
        # 执行证据（可选）：每步截图 + 事件流水落盘。由 Session 在开跑时挂上，跑完收回。
        self.evidence: RunEvidence | None = None
        # 当前这一步开始执行的时间（monotonic）：`step_finished` 的 durationMs 用它算
        self._step_started_at: float | None = None
        # 最近一帧：失败时要截"失败瞬间"的画面（`_handle_failure` 拿不到 frame）
        self._last_frame: Frame | None = None
        # 整条链开始的时间：`flow_finished` 报总耗时
        self._run_started_at: float | None = None
        # 这一步实际选中了哪些命中（多目标策略）：`action_executed` 的 extra 用它
        self._last_selection: dict[str, Any] = {}
        self.reset_variables()

    def perceive(self, frame: Frame, search_overrides: dict[str, str] | None = None) -> dict[str, Detection]:
        """跑一遍识别。搜索范围只有两个来源：步骤写了的，或默认的原区域。

        模板不再带「默认搜索范围」——录制时不设，`graph.json` 里老数据的
        `recognizers[*].search` 也不再参与，否则界面上看不到、却还在偷偷整帧搜。
        """
        overrides = search_overrides or {}
        scopes = {label: overrides.get(label) or "region" for label in self.graph.recognizers}
        if self._parent is not None:
            key = (frame.index, tuple(sorted(scopes.items())))
            cached = self._root._perception_cache.get(key)
            if cached is None:
                raw = perceive(self.graph.recognizers, frame, VoteFilter(1), scopes)
                cached = copy.deepcopy(raw)
                self._root._perception_cache[key] = cached
            self.detections = copy.deepcopy(cached)
            for label, detection in self.detections.items():
                detection.state = "confirmed" if self._vote.update(label, True) else "pending"
            for label in self._vote.snapshot():
                if label not in self.detections:
                    self._vote.update(label, False)
        else:
            self.detections = perceive(self.graph.recognizers, frame, self._vote, scopes)
            self._perception_cache = {(frame.index, tuple(sorted(scopes.items()))): copy.deepcopy(self.detections)}
        self._detection_scope = dict(scopes)
        return self.detections

    def _step_search_scope(self, params: dict[str, Any]) -> str | None:
        search = str(params.get("search") or "").strip().lower()
        return search if search in ("region", "full") else None

    def _step_search_labels(self, params: dict[str, Any]) -> set[str]:
        labels: set[str] = set()
        label = str(params.get("rec") or "").strip()
        if label:
            labels.add(label)
        # 条件步骤可能有两组以上标签（groups[].all）：同一个步骤共用一个搜索范围
        groups = params.get("groups")
        if isinstance(groups, list):
            for group in groups:
                if not isinstance(group, dict):
                    continue
                all_of = group.get("all")
                if not isinstance(all_of, list):
                    continue
                labels.update(str(item).strip() for item in all_of if item is not None and str(item).strip())
        return labels

    def _step_search_overrides(self) -> dict[str, str]:
        """当前这一步声明的搜索范围（`params.search` = region / full）。

        搜索范围是**步骤的能力**：同一个模板，A 步可以只在录制区域找，B 步可以整帧找。
        没写就是原区域（引擎不读模板上的历史 `search` 字段）。
        """
        if not 0 <= self.cursor < len(self.steps):
            return {}
        params = self.steps[self.cursor].get("params")
        if not isinstance(params, dict):
            return {}
        search = self._step_search_scope(params)
        if search is None:
            return {}
        return {item: search for item in self._step_search_labels(params)}

    def _apply_step_search(self, frame: Frame, params: dict[str, Any]) -> None:
        """进入一步时把它声明的搜索范围落到检测结果上（跨步骤同一拍也立刻生效）。

        没写不是"什么都不做"：上一步可能是 full，这一步要回到原区域，否则会拿上一步的
        整帧结果去判断本步。
        """
        labels = self._step_search_labels(params)
        if not labels:
            return
        target = self._step_search_scope(params) or "region"
        for label in labels:
            self._ensure_scope(frame, label, target)

    def _ensure_scope(self, frame: Frame, label: str, search: str) -> None:
        if self._detection_scope.get(label) == search:
            return
        recognizer = self.graph.recognizers.get(label)
        if not getattr(recognizer, "enabled", True):
            self.detections.pop(label, None)
            self._vote.update(label, False)
            return
        if not isinstance(recognizer, TemplateRecognizer):
            return
        hits = recognizer.detect(frame, search=search)
        if self.graph.recognizers.get(label) is not recognizer or not recognizer.enabled:
            hits = []
        # 这里也要打包候选：否则切到「全屏」的那一拍会丢掉多目标列表，
        # 策略只能看到一个最高分，等于白配。
        best = best_per_label(hits).get(label) if hits else None
        if best is None:
            self.detections.pop(label, None)
            self._vote.update(label, False)
        else:
            confirmed = self._vote.update(label, True)
            best.state = "confirmed" if confirmed else "pending"
            self.detections[label] = best
        self._detection_scope[label] = search

    def _hit(self, label: str) -> bool:
        if not getattr(self.graph.recognizers.get(label), "enabled", True):
            return False
        detection = self.detections.get(label)
        return detection is not None and detection.state == "confirmed"

    def _best_score_text(self, label: str) -> str:
        """失败原因补一句"当帧看到的最好成绩"：0.61 < 阈值 0.82 这类信息不用再翻识别器设置。"""
        recognizer = self.graph.recognizers.get(label)
        error = getattr(recognizer, "last_error", None)
        if error:
            # OCR 模型没就绪这类问题，光说"超时"用户没法处理
            return f"识别器报错：{error}"
        detection = self.detections.get(label)
        if detection is None:
            return "这一帧完全没命中"
        threshold = getattr(recognizer, "threshold", None)
        if isinstance(threshold, (int, float)):
            return f"当帧最高分 {detection.score:.2f} < 阈值 {float(threshold):.2f}"
        return f"当帧最高分 {detection.score:.2f}（未达命中条件）"

    def _scores(self) -> dict[str, float]:
        return {item.label: item.score for item in self.detections.values()}

    def locate(self) -> str | None:
        """ "我现在在哪个界面"（节点的 enter 识别器全部命中）。

        步骤链自己不靠它跑，但它得能用：`record_action` 要知道手动操作归属哪个界面，
        而且两套模型是并存的（读数和画布都还在用状态图那套）。
        """
        for node in self.graph.nodes.values():
            if node.enter and all(self._hit(label) for label in node.enter):
                return node.id
        return None

    def reset_variables(self) -> None:
        self.variables.reset(self.graph.variables)

    @property
    def uses_scheduled_touches(self) -> bool:
        return any(
            step.get("type") in ("parallel", "touch") or "finger" in step.get("params", {})
            for step in self.steps
        )

    @property
    def touch_owner(self) -> str:
        return self._touch_owner

    @property
    def active_step_ids(self) -> list[str]:
        if self.result != "running":
            return []
        children = tuple(self._parallel_children)
        if children:
            return [step for child in children for step in child.active_step_ids]
        current = self.paused_at or self.current
        return [current] if current else []

    def cancel_actions(self, reason: str = "external") -> None:
        self._owner_cancelled = True
        owners = [self._touch_owner]
        for owner in owners:
            owner.cancelled.set()
        scheduler = get_touch_scheduler(self.controller, create=False)
        handle = self._touch_handle
        if handle is not None and not handle.done.is_set():
            self._emit("gesture_retry", message="触控动作已取消，继续后从头重试", extra={"reason": reason})
        elif scheduler is not None and any(scheduler.has_contacts(owner) for owner in owners):
            self._cancelled_contact = True
        self._owner_cancelled = True
        if scheduler is not None:
            for owner in owners:
                with contextlib.suppress(Exception):
                    scheduler.cancel_owner(owner)
        self._assigned_finger = None
        if self._touch_handle is not None:
            self._touch_handle = None
            self._touch_step = None
            self._announced = None
        for child in tuple(self._parallel_children):
            child.cancel_actions(reason)

    def pause_execution(self) -> None:
        self.paused_at = self.current
        self.cancel_actions("pause")
        for child in tuple(self._parallel_children):
            child.pause_execution()

    @property
    def paused(self) -> bool:
        return self.paused_at is not None

    def resume(self) -> None:
        """继续：清掉暂停标记，下一拍从**当前这一步**接着来。"""
        self.paused_at = None
        if self._cancelled_contact:
            self._finish("failure", "持续触点已取消，请从流程起点或所属并行块头重新运行")
            return
        if self._owner_cancelled:
            self._touch_owner = TouchOwner(f"flow:{uuid.uuid4().hex}")
            self._owner_cancelled = False
        for child in tuple(self._parallel_children):
            child.resume()
        # 被恢复的那一步自身再进入一次不算"新的一步"
        self._skip_entry = self._entries + 1
        self._pause_next = False

    def step(self) -> None:
        """单步：先继续，等**执行完当前这一步**、进入下一步之前再停。"""
        self.resume()
        self._pause_next = True

    def start(self, from_step_id: str | None = None) -> None:
        """从头（或指定步骤）开始跑：再点一次「运行」就是**重跑一遍**（游标、断点经过记录都复位）。"""
        self.cancel_actions("restart")
        self._touch_owner = TouchOwner(f"flow:{uuid.uuid4().hex}")
        self._owner_cancelled = False
        self._cancelled_contact = False
        self._parallel_children = []
        raw_steps = list((self.graph.flow or {}).get("steps") or [])
        self.steps = [
            step
            for step in raw_steps
            if not (
                step.get("type") == "loopbreak"
                and isinstance(step.get("params"), dict)
                and step.get("params", {}).get("_implicit")
            )
        ]
        self._cond_branches, self._else_to_end = _branch_marks(self.steps)
        self._else_owner = {
            else_index: cond_index
            for cond_index, (else_index, _end) in self._cond_branches.items()
            if else_index is not None
        }
        self._end_owner = {
            end_index: cond_index for cond_index, (_else, end_index) in self._cond_branches.items() if end_index >= 0
        }
        self._loop_marks = _loop_marks(self.steps)
        self.cursor = 0
        if from_step_id:
            depth = 0
            for step in self.steps:
                if str(step.get("id")) == from_step_id and (
                    depth or step.get("type") in ("parallelbranch", "parallelend")
                ):
                    raise ValueError("不能从并行分支内部启动，请从并行块头运行")
                if step.get("type") == "parallel":
                    depth += 1
                elif step.get("type") == "parallelend":
                    depth = max(0, depth - 1)
            for index, step in enumerate(self.steps):
                if str(step.get("id")) == from_step_id:
                    self.cursor = index
                    break
            else:
                raise ValueError(f"找不到步骤: {from_step_id}")
        self._start_cursor = self.cursor
        self.blocking = None
        self._breakpoint_passed = set()
        self._entries = 0
        self._skip_entry = -1
        self._pause_next = False
        self._retry_ready_at = 0.0
        self._announced = None
        self._error_retries = {}
        self._loop_stack = []
        start_step = self.steps[self.cursor] if 0 <= self.cursor < len(self.steps) else None
        self._detached_start = bool(from_step_id and start_step is not None and _is_pending_link(start_step))
        self._hydrate_loop_stack(self.cursor)
        self._break_after = {}
        self.paused_at = None
        self.waiting = False
        self.waiting_for = None
        self.current = self.steps[self.cursor]["id"] if self.steps else None
        self._stop_requested.clear()
        self.result = "running"
        self._run_started_at = time.monotonic()
        tail = f"从第 {self.cursor + 1} 步" if from_step_id else f"{len(self.steps)} 步"
        self._emit("flow_started", message=f"开始执行步骤链（{tail}）")

    def wait_for_subflow(self, child_root: str = "") -> None:
        """调用子工作流成功后挂起当前链。

        游标先推进到「调用」的下一条：恢复时从下一条继续，不能再执行一次调用，
        否则会无限重复调用同一个子工作流。`result` 保持 running，界面仍显示这条链在运行
        （只是停在调用节点等子链）。真正的结束由 `resume_from_subflow` /
        `fail_from_subflow` 决定。
        """
        if self.result != "running":
            return
        self.cursor = min(len(self.steps), self.cursor + 1)
        self.waiting = True
        self.waiting_for = child_root or None
        name = (self.steps[self.cursor - 1].get("params") or {}).get("name") if self.cursor > 0 else ""
        self._emit("subflow_waiting", message=f"等待子工作流「{name or child_root}」执行完")

    def resume_from_subflow(self) -> None:
        """子链成功后继续当前链（从调用步的下一条开始）。"""
        if self.result != "running":
            return
        self.waiting = False
        self.waiting_for = None
        self._emit("subflow_resumed", message="子工作流执行完，继续当前链")

    def fail_from_subflow(self, message: str) -> None:
        """子链失败/被停止：当前链跟着失败，不能假装成功继续。"""
        self.waiting = False
        self.waiting_for = None
        self._finish("failure", message)

    def request_stop(self) -> None:
        """置位并同步释放本运行触点；不等待执行锁或新的采集帧。"""
        self._stop_requested.set()
        self.cancel_actions("stop")
        for child in tuple(self._parallel_children):
            child.request_stop()

    def stop_execution(self) -> None:
        self.request_stop()
        if self.result == "running":
            self._finish("cancelled", "已停止")

    def tick(self, frame: Frame) -> list[TraceEvent]:
        self._outbox = []
        self._last_frame = frame
        # A queued frame must not enter expensive inference after cancellation.
        # Stop is a control operation, not work to be serviced after YOLO/OCR.
        if self._stop_requested.is_set():
            self.stop_execution()
            return self._flush()
        detections = self.perceive(frame, self._step_search_overrides())
        self.stats["ticks"] += 1
        self.trace.add_frame(frame.index, self.current, [item.to_dict() for item in detections.values()])
        if self.result == "running" and not self.paused and not self.waiting:
            self._advance(frame)
        return self._flush()

    def _advance(self, frame: Frame) -> None:
        # 一拍最多执行一个设备动作：循环/相邻动作必须先让采集线程推帧，
        # 下一拍重新识别。步数上限无法约束同步点击的耗时（100 次点击可阻塞数秒）。
        action_performed = False
        started = time.perf_counter()
        for iteration in range(MAX_STEPS_PER_TICK):
            if self._stop_requested.is_set():
                self.stop_execution()
                return
            if iteration and time.perf_counter() - started >= MAX_ADVANCE_SECONDS:
                return
            if self.result != "running" or self.paused or self.waiting:
                return
            if self._range_end is not None and not self._range_start <= self.cursor < self._range_end:
                self._finish("success", "并行分支完成")
                return
            if not 0 <= self.cursor < len(self.steps):
                self._finish("success", "整条链跑完了")
                return
            step = self.steps[self.cursor]
            step_id = str(step["id"])
            kind = str(step["type"])
            params: dict[str, Any] = dict(step.get("params") or {})
            self.current = step_id
            # 出错重试的间隔（`retry_interval_ms`）：没到点就原地等，不推进游标、不重复发事件
            if self._retry_ready_at:
                if time.monotonic() < self._retry_ready_at:
                    return
                self._retry_ready_at = 0.0
            # 同一拍里从「全屏」步骤走到「区域」步骤（或反过来）时，检测结果要立刻换范围
            self._apply_step_search(frame, params)

            if params.get("_pendingLink") and self.cursor != self._start_cursor and kind not in _BLOCK_END_KINDS:
                self._finish("success", f"第 {self.cursor + 1} 步起的模块还没有连线接入，到此结束")
                return

            if step.get("disabled"):
                skip_to = self._cursor_after_disabled_block(kind, self.cursor)
                self._announced = None
                self._emit("step_skipped", message=f"第 {self.cursor + 1} 步已停用，跳过")
                self.cursor = skip_to
                continue

            # 单步：进入一个"新"步骤就停（恢复时那一步自身的再进入不算）
            self._entries += 1
            if self._pause_next and self._entries > self._skip_entry:
                self._pause_next = False
                self.paused_at = step_id
                self._root.cancel_actions("breakpoint")
                self._emit("breakpoint_hit", message=f"单步：第 {self.cursor + 1} 步「{kind}」执行前暂停")
                return

            # 断点：**执行前**停（和状态机的边断点一个语义）
            if step_id in self.breakpoints and step_id not in self._breakpoint_passed:
                self._breakpoint_passed.add(step_id)
                self.paused_at = step_id
                self._root.cancel_actions("breakpoint")
                self._emit("breakpoint_hit", message=f"断点：第 {self.cursor + 1} 步「{kind}」执行前暂停")
                return

            if self._announced != step_id:
                # 一次"到达"只报一次：等待/延时会跨帧，重报会把事件流刷满
                self._announced = step_id
                self._step_started_at = None  # 上一步没走"完成"路径时别把它的耗时带过来
                self._emit(
                    "step_started",
                    message=f"第 {self.cursor + 1} 步 · {kind}",
                    extra=self._step_extra(params),
                )
                self._step_started_at = time.monotonic()
                self._capture_step(self.cursor + 1, step_id, kind, params)

            if kind == "parallel":
                outcome = self._try_parallel(frame, params)
                if outcome != "done":
                    return
                continue
            if kind == "touch":
                try:
                    self._perform_touch(step_id, params)
                except ActionDeferredError:
                    return
                except Exception as error:
                    if self._handle_failure(step_id, params, str(error)) == "fail":
                        return
                    continue
            elif kind == "wait":
                outcome = self._try_wait(step_id, params, frame)
                if outcome in ("wait", "fail"):
                    return
                if outcome != "ok":
                    # 出错策略已经推进/跳转游标，或要求重新等待：不要再按成功路径推进一次。
                    continue
            elif kind == "delay":
                if self._try_delay(step_id, params, frame):
                    return
            elif kind == "end":
                # 「结束」= Python 里的 return：这一支到此为止，**不走块后第一步**。
                # 没有这一步时，条件块后面的步骤是所有支尾的公共后续（分支尾必然落到它），
                # 于是"挑战做完就结束"没法表达（见 flow-branch-layout 的续接边）。
                self._finish("success", "到达「结束」步骤：本次执行结束")
                return
            elif kind == "cond":
                # 分叉：命中 → 继续做这一块（then 段）；没命中 → 若配了模板匹配等待时间则等待，超时再跳到「否则」或「条件结束」
                # 上一次进入这一支后若被 loopbreak 直接带走，收尾标记会残留：重新进入时先清掉
                self._break_after.pop(self.cursor, None)
                if not self._condition_ok(params):
                    cond_wait_ms = self._resolve_match_timeout_ms(params, default_fallback=0)
                    if cond_wait_ms > 0:
                        state = self._blocking_for(f"{step_id}:cond", frame.index)
                        if (time.monotonic() - state.started_at) * 1000 < cond_wait_ms:
                            return
                        self.blocking = None
                    summary = self._condition_summary(params)
                    else_index, end_index = self._cond_branches.get(self.cursor, (None, -1))
                    if end_index < 0:
                        # 老写法：只有「条件」、没有配对的「条件结束」—— 没命中就停链（保住老图）
                        self._finish("failure", f"条件不满足：「{summary}」没命中，链停在这里")
                        return
                    self._emit(
                        "cond_false",
                        message=(
                            f"条件不成立：「{summary}」没命中 → "
                            + ("走「否则」这一支" if else_index is not None else "跳过这一块")
                        ),
                    )
                    if params.get("_loopRepeat") == "then" and not self._has_explicit_edges():
                        else_empty = else_index is None or else_index + 1 >= end_index
                        if else_empty:
                            if not self._repeat_loop_and_jump(params):
                                return
                            self._announced = None
                            continue
                        if else_index is not None:
                            self._break_after[self.cursor] = "else"
                            self.cursor = else_index + 1
                            self._announced = None
                            continue
                    self.cursor = end_index + 1 if else_index is None else else_index + 1
                    self._announced = None
                    continue
                self.blocking = None
                if params.get("_loopRepeat") == "else" and not self._has_explicit_edges():
                    else_index, end_index = self._cond_branches.get(self.cursor, (None, -1))
                    then_end = else_index if else_index is not None else end_index
                    if then_end == self.cursor + 1:
                        if not self._repeat_loop_and_jump(params):
                            return
                        self._announced = None
                        continue
                    self._break_after[self.cursor] = "then"
            elif kind == "else":
                # 走到「否则」= 是从「条件」命中那一支过来的：then 段到此为止，跳过 else 段
                end_index = self._else_to_end.get(self.cursor, -1)
                if end_index < 0:
                    self._finish("failure", "「否则」找不到对应的「条件结束」")
                    return
                owner = self._else_owner.get(self.cursor, -1)
                if owner >= 0 and self._break_after.pop(owner, ""):
                    if not self._repeat_loop_and_jump(self.steps[owner].get("params") or {}):
                        return
                    self._announced = None
                    continue
                self._emit("cond_true_done", message="条件成立：这一支做完，跳过「否则」")
                self.cursor = end_index + 1
                self._announced = None
                continue
            elif kind == "condend":
                owner = self._end_owner.get(self.cursor, -1)
                if owner >= 0 and self._break_after.pop(owner, ""):
                    if not self._repeat_loop_and_jump(self.steps[owner].get("params") or {}):
                        return
                    self._announced = None
                    continue
            elif kind == "loop":
                count = max(1, _as_int(params.get("count"), 1))
                meta = self._loop_marks.get(self.cursor)
                if meta is None:
                    self._finish("failure", "「循环」没有配对的「循环结束」")
                    return
                body_start, _loop_end = meta
                self._loop_stack.append(
                    _LoopFrame(
                        loop_index=self.cursor,
                        body_start=body_start,
                        remaining=count,
                        total=count,
                    )
                )
                self.stats["steps"] += 1
                self._emit_step_finished(f"第 {self.cursor + 1} 步完成 · 循环 {count} 次")
                self._announced = None
                self.cursor = body_start
                continue
            elif kind == "loopend":
                back = str(params.get("back") or "")
                loop_index = next(
                    (i for i, s in enumerate(self.steps) if str(s.get("id")) == back and s.get("type") == "loop"),
                    -1,
                )
                # 禁止用 `frame`：会盖掉 tick 传入的画面帧，下一轮 delay/click 读 frame.index 会崩
                loop_frame = next((item for item in reversed(self._loop_stack) if item.loop_index == loop_index), None)
                if loop_frame is None or loop_index < 0:
                    if self._detached_start:
                        self._finish("success", "未接入模块已执行完")
                        return
                    self._finish("failure", "「循环结束」找不到对应的「循环」")
                    return
                loop_frame.remaining -= 1
                if loop_frame.remaining > 0:
                    self._emit(
                        "loop_repeat",
                        message=f"循环继续（还剩 {loop_frame.remaining} 次）",
                    )
                    self.cursor = loop_frame.body_start
                    self._announced = None
                    continue
                while self._loop_stack and self._loop_stack[-1].loop_index != loop_index:
                    self._loop_stack.pop()
                if self._loop_stack:
                    self._loop_stack.pop()
                self.stats["steps"] += 1
                self._emit_step_finished(f"第 {self.cursor + 1} 步完成")
                self._announced = None
                self.cursor += 1
                continue
            elif kind == "loopbreak":
                if params.get("_implicit") and not self._loop_stack:
                    self._announced = None
                    self.cursor += 1
                    continue
                if not self._pop_loop_and_jump_after(str(params.get("back") or "")):
                    self._finish("failure", "「跳出循环」不在任何循环里")
                    return
                self.stats["steps"] += 1
                self._emit_step_finished(f"第 {self.cursor + 1} 步完成")
                self._announced = None
                continue
            elif kind in _ACTION_KINDS:
                if action_performed:
                    return
                # 一个动作要跨好几拍走完「等命中 → 动作前延迟 → 动作 → 动作后延迟」。
                # 已经进入哪一段，这一拍就只推进那一段：以前只认 `:post`，其余情况都会
                # 重新调 `_try_wait_action_target()`，用 `:match` 把正在走的 `:pre` 顶掉
                # （`_blocking_for` 按 step_id 换槽），执行前延迟永远走不完 —— 表现就是
                # 「设了 100ms 匹配等待却一直卡在这一步，直到目标出现」。
                phase = str(self.blocking.step_id) if self.blocking is not None else ""
                if phase == f"{step_id}:post":
                    # 已在等动作后延迟：只检查它是否结束（动作已经做过，不能再点一次）
                    if self._try_step_phase_delay(f"{step_id}:post", self._resolve_post_and_interval_ms(params), frame):
                        return
                else:
                    if phase != f"{step_id}:pre" and self._touch_step != step_id:
                        # 1) 若是识别器定位的动作，未命中时先按模板匹配等待时间（默认 20s）跨帧等待
                        match_wait = self._try_wait_action_target(step_id, kind, params, frame)
                        if match_wait == "wait":
                            return
                        if match_wait == "timeout":
                            # 等命中超时就是这一步的结论：不能再走动作前延迟去点一个没命中的
                            # 目标（否则「匹配等待 100ms」实际要多等一个执行前延迟，报错也会
                            # 变成「目标当前没有命中，无法定位」，看不出是等超时）。
                            if self._fail_action_match_timeout(step_id, params) == "fail":
                                return
                            continue

                    # 2) 动作前延迟（pre_delay_ms / pre_action_delay_ms）
                    if self._touch_step != step_id and self._try_step_phase_delay(
                        f"{step_id}:pre", self._resolve_pre_delay_ms(params), frame
                    ):
                        return

                    # 3) 动作前延迟期间目标可能已经丢失：执行前再按同一匹配超时等待。
                    # 否则「命中 → 3s 执行前延迟 → 目标消失」会绕过 match_timeout，
                    # 直接报「目标当前没有命中，无法定位」，看起来像等待设置完全没生效。
                    target = str(params.get("rec") or "").strip()
                    if (
                        kind in ("click", "hold")
                        and target
                        and _click_target_mode(params) == "recognizer"
                        and target not in self.detections
                    ):
                        match_wait = self._try_wait_action_target(step_id, kind, params, frame)
                        if match_wait == "wait":
                            return
                        if match_wait == "timeout":
                            if self._fail_action_match_timeout(step_id, params) == "fail":
                                return
                            continue

                    # 4) 执行本步动作
                    try:
                        ok, message = self._perform_step(step_id, kind, params)
                    except ActionDeferredError:
                        # 手动手势抢先占用了输入通道；不走出错策略，下帧重新识别/定位。
                        return
                    action_performed = True
                    if self._stop_requested.is_set():
                        self.stop_execution()
                        return
                    if not ok:
                        if self._handle_failure(step_id, params, message) == "fail":
                            return
                        continue
                    self._error_retries.pop(step_id, None)

                    # 4) 动作后延迟 + 步骤间默认间隔（post_delay_ms / post_action_delay_ms + step_interval_ms）
                    if self._try_step_phase_delay(f"{step_id}:post", self._resolve_post_and_interval_ms(params), frame):
                        return
            elif kind == "setvar":
                ok, message = self._perform_setvar(params)
                if not ok:
                    if self._handle_failure(step_id, params, message) == "fail":
                        return
                    continue
                self._error_retries.pop(step_id, None)
                self._emit("action_executed", message=message)
                self.stats["actions"] += 1
            elif kind == "call":
                self._call_subflow(params)
                return
            elif kind not in STEP_KINDS:
                self._finish("failure", f"第 {self.cursor + 1} 步的类型不认识: {kind}")
                return

            self.stats["steps"] += 1
            self._emit_step_finished(f"第 {self.cursor + 1} 步完成")
            self._announced = None
            self.cursor += 1

    def _cursor_after_disabled_block(self, kind: str, index: int) -> int:
        """停用循环/条件头 = 整块不跑，游标落到对应结束标记之后。"""
        if kind == "parallel":
            owner = self.steps[index]["id"]
            for target in range(index + 1, len(self.steps)):
                if (
                    self.steps[target].get("type") == "parallelend"
                    and self.steps[target].get("params", {}).get("parallel") == owner
                ):
                    return target + 1
        if kind == "loop":
            meta = self._loop_marks.get(index)
            if meta is not None:
                return meta[1] + 1
        elif kind == "cond":
            _else, end_index = self._cond_branches.get(index, (None, -1))
            if end_index >= 0:
                return end_index + 1
        return index + 1

    def _hydrate_loop_stack(self, start: int) -> None:
        """从中间开跑时补上包围当前步的循环帧，否则 loopend / 条件跳出循环会对不上。"""
        if self._detached_start:
            # 未接入模块不在循环连线上：补栈会让 loopend 把这一步再跑 N 次
            self._loop_stack = []
            return
        open_loops: list[int] = []
        for index, step in enumerate(self.steps):
            if index >= start:
                break
            kind = step.get("type")
            if kind == "loop":
                open_loops.append(index)
            elif kind == "loopend" and open_loops:
                open_loops.pop()
        self._loop_stack = []
        for loop_index in open_loops:
            meta = self._loop_marks.get(loop_index)
            if meta is None:
                continue
            body_start, _end = meta
            count = max(1, _as_int((self.steps[loop_index].get("params") or {}).get("count"), 1))
            self._loop_stack.append(
                _LoopFrame(loop_index=loop_index, body_start=body_start, remaining=count, total=count)
            )

    def _has_explicit_edges(self) -> bool:
        """Authored edges make branch tails converge naturally, not implicitly break.

        `_loopRepeat` is legacy layout metadata, never a break instruction in
        an edge-authored graph. Explicit loopbreak/end steps remain authoritative.
        """
        return any(isinstance((step.get("params") or {}).get("_out"), list) for step in self.steps)

    def _repeat_loop_and_jump(self, params: dict[str, Any]) -> bool:
        """条件的「这一支再循环」/「另一支结束」：目标循环写进 `_loopRepeatLoop`。

        老图没有这个字段，退回最内层循环（原来的行为）。
        """
        target = str(params.get("_loopRepeatLoop") or "")
        if self._pop_loop_and_jump_after(target):
            return True
        self._finish("failure", "「条件」的再循环目标不在当前循环里，请重新连接这一支")
        return False

    def _pop_loop_and_jump_after(self, back_loop_id: str) -> bool:
        """结束指定（或最内层）循环，游标跳到对应「循环结束」之后。"""
        loop_index = -1
        if back_loop_id:
            loop_index = next(
                (
                    i
                    for i, step in enumerate(self.steps)
                    if str(step.get("id")) == back_loop_id and step.get("type") == "loop"
                ),
                -1,
            )
            if loop_index < 0 or not any(frame.loop_index == loop_index for frame in self._loop_stack):
                return False
        elif self._loop_stack:
            loop_index = self._loop_stack[-1].loop_index
        else:
            return False
        meta = self._loop_marks.get(loop_index)
        if meta is None:
            return False
        _, loop_end = meta
        while self._loop_stack and self._loop_stack[-1].loop_index != loop_index:
            self._loop_stack.pop()
        if self._loop_stack:
            self._loop_stack.pop()
        self._emit("loop_break", message="跳出循环（提前结束，不再计剩余次数）")
        self.cursor = loop_end + 1
        return True

    def _try_parallel(self, frame: Frame, params: dict[str, Any]) -> str:
        if not self._parallel_children:
            owner = self.steps[self.cursor]["id"]
            markers = []
            end = -1
            for index in range(self.cursor + 1, len(self.steps)):
                step = self.steps[index]
                if step.get("params", {}).get("parallel") != owner:
                    continue
                if step.get("type") == "parallelbranch":
                    markers.append(index)
                elif step.get("type") == "parallelend":
                    end = index
                    break
            if end < 0 or len(markers) != params.get("branches", 2):
                self._finish("failure", "并行块边界不完整")
                return "failed"
            if sum(1 for _ in self._root._all_engines()) + len(markers) > 32:
                self._finish("failure", "并行嵌套超过执行分支上限")
                return "failed"
            self._parallel_end = end
            for number, (start, limit) in enumerate(zip(markers, [*markers[1:], end], strict=True), 1):
                child = FlowEngine(self.graph, self.controller, input_guard=self.input_guard)
                child.start()
                child._outbox = []
                child._parent = self
                child.breakpoints = self._root.breakpoints
                child._root = self._root
                child._stop_requested = self._root._stop_requested
                child._branch_path = [*self._branch_path, number]
                child.steps = self.steps
                child.variables = self.variables
                child.evidence = self.evidence
                child.cursor = start + 1
                child._range_start = start + 1
                child._range_end = limit
                child.current = self.steps[start + 1]["id"] if start + 1 < limit else None
                child._default_finger = number
                self._parallel_children.append(child)
                if self._root._stop_requested.is_set() or self._root.paused:
                    child.cancel_actions("stop")
                    return "failed"
        for child in tuple(self._parallel_children):
            if child.result == "running":
                child._last_frame = frame
                child.perceive(frame, child._step_search_overrides())
                if not child.paused:
                    child._advance(frame)
                if child.paused:
                    self._root.paused_at = child.paused_at
                    self._root.cancel_actions("breakpoint")
                    return "waiting"
            if params.get("mode", "all") == "all" and child.result in ("failure", "cancelled"):
                self._finish("failure", "并行分支失败")
                return "failed"
            if params.get("mode", "all") == "any" and child.result == "success":
                break
        outcomes = [child.result for child in self._parallel_children]
        success = (
            all(result == "success" for result in outcomes)
            if params.get("mode", "all") == "all"
            else "success" in outcomes
        )
        if success:
            for child in self._parallel_children:
                child.cancel_actions("join")
            self._parallel_children = []
            self._emit_step_finished("并行块完成")
            self._announced = None
            self.cursor = self._parallel_end + 1
            return "done"
        if all(result != "running" for result in outcomes):
            self._finish("failure", "所有并行分支失败")
            return "failed"
        return "waiting"

    def _all_engines(self) -> list[FlowEngine]:
        return [self, *(engine for child in tuple(self._parallel_children) for engine in child._all_engines())]

    def _poll_touch(self, step_id: str) -> bool:
        handle = self._touch_handle
        if handle is None or self._touch_step != step_id:
            return False
        if not handle.done.is_set():
            raise ActionDeferredError("触控动作进行中")
        self._touch_handle = None
        self._touch_step = None
        if handle.error is not None:
            self._touch_owner = TouchOwner(f"flow:{uuid.uuid4().hex}")
            self._assigned_finger = None
            raise RuntimeError(str(handle.error))
        if handle.cancelled:
            self._emit("gesture_retry", message="触控动作已取消，从头重试")
            return False
        return True

    def _finger_for(self, params: dict[str, Any]) -> int:
        explicit = params.get("finger")
        if explicit is not None:
            if not isinstance(explicit, int) or isinstance(explicit, bool) or not 1 <= explicit <= 10:
                raise ValueError("finger 必须是 1..10 的整数")
            self._assigned_finger = explicit
            return explicit
        scheduler = get_touch_scheduler(self.controller)
        assert scheduler is not None
        self._assigned_finger = scheduler.allocate_finger(
            self._touch_owner, self._assigned_finger or self._default_finger
        )
        return self._assigned_finger

    def _submit_touch(
        self,
        step_id: str,
        params: dict[str, Any],
        events: list[tuple[float, str, float, float]],
        *,
        owner: TouchOwner | None = None,
    ) -> None:
        scheduler = get_touch_scheduler(self.controller)
        assert scheduler is not None
        finger = int(params["finger"]) if owner is not None else self._finger_for(params)
        owner = owner if owner is not None else self._touch_owner
        guard = self.input_guard() if self.input_guard is not None else contextlib.nullcontext()
        with guard:
            if self._stop_requested.is_set():
                raise ActionCancelledError("设备动作已取消")
            self._touch_handle = scheduler.submit(owner, finger, events)
        self._touch_step = step_id
        raise ActionDeferredError("触控动作进行中")

    def _perform_parallel_action(self, step_id: str, spec: dict[str, Any], params: dict[str, Any]) -> str:
        if self._poll_touch(step_id):
            self.stats["actions"] += 1
            return describe_action(spec)
        resolved = resolve_spec(dict(spec), self.variables, self._scores())
        action = Action.parse(resolved)
        defaults = dict(self.graph.defaults)
        if action.type == "swipe":
            start = self._resolve_point(action, action.target, action.x, action.y)
            end = self._resolve_point(action, action.to_target, action.to_x, action.to_y, allow_auto=True)
            duration = max(0.05, action.duration_ms / 1000)
            config = resolve_swipe_bezier(resolved, defaults)
            path = normalize_path(action.path)
            if path is None:
                path = (
                    generate_swipe_track(start, end, duration=duration, config=config)
                    if config.enabled
                    else resolve_swipe_points(start, end, duration, None)
                )
            lengths = [((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5 for a, b in itertools.pairwise(path)]
            total = sum(lengths)
            events = [(0.0, "down", *path[0])]
            elapsed = 0.0
            for index, point in enumerate(path[1:]):
                elapsed += duration * lengths[index] / total if total else duration / max(1, len(path) - 1)
                events.append((elapsed, "move", *point))
            events.append((duration + max(0, action.hold_ms) / 1000, "up", *path[-1]))
        else:
            points = self._resolve_points(action, action.target, action.x, action.y)
            config_click = resolve_click_human(resolved, defaults)
            duration_ms = max(50, action.duration_ms) if action.type == "long_press" else config_click.duration_ms
            duration_ms = max(10, duration_ms)
            if config_click.delay_jitter_ms > 0:
                duration_ms = max(
                    10, round(duration_ms + random.uniform(-config_click.delay_jitter_ms, config_click.delay_jitter_ms))
                )
            duration = duration_ms / 1000
            events = []
            offset = 0.0
            for point in points:
                landed = apply_point_jitter(point, config_click.jitter_px)
                for _ in range(2 if action.type == "double_click" else 1):
                    path = (
                        generate_tap_track(landed, duration=duration, micro_px=config_click.micro_px)
                        if config_click.micro_px > 0
                        else [landed]
                    )
                    events.append((offset, "down", *path[0]))
                    for index, current in enumerate(path[1:], 1):
                        events.append((offset + duration * index / max(1, len(path) - 1), "move", *current))
                    events.append((offset + duration, "up", *path[-1]))
                    offset += duration + max(0.03, min(0.08, duration))
                offset += 0.12
        self._submit_touch(step_id, params, events)
        return describe_action(resolved)

    def _perform_touch(self, step_id: str, params: dict[str, Any]) -> None:
        if self._poll_touch(step_id):
            return
        phase = str(params.get("phase") or "")
        scheduler = get_touch_scheduler(self.controller)
        assert scheduler is not None
        finger = self._finger_for(params)
        if phase == "up":
            x, y = scheduler.position(self._touch_owner, finger)
        else:
            x, y = float(params.get("x", 0.5)), float(params.get("y", 0.5))
        duration = max(0, min(600000, float(params.get("duration_ms", 0)))) / 1000
        events = [(0.0, phase, x, y)]
        if phase == "move" and duration:
            sx, sy = scheduler.position(self._touch_owner, finger)
            count = max(1, min(1000, int(duration / 0.01)))
            events = [
                (duration * i / count, "move", sx + (x - sx) * i / count, sy + (y - sy) * i / count)
                for i in range(1, count + 1)
            ]
        self._submit_touch(step_id, params, events)

    def _blocking_for(self, step_id: str, frame_index: int) -> _Blocking:
        """取/建这一步的计时状态。**只认进入之后的帧**（见文件头第 1 条）。"""
        if self.blocking is None or self.blocking.step_id != step_id:
            self.blocking = _Blocking(step_id, time.monotonic(), frame_index)
        return self.blocking

    def _try_wait(self, step_id: str, params: dict[str, Any], frame: Frame) -> str:
        label = str(params.get("rec") or "")
        if not label:
            self.blocking = None
            return self._handle_failure(step_id, params, "「等待界面」还没选要等哪个识别器")
        default_wait_ms = _as_int(self.graph.default("wait_timeout_ms", 20000), 20000)
        timeout_ms = int(params.get("timeout_ms") or default_wait_ms)
        default_vote = _as_int(self.graph.default("vote", 2), 2)
        stable_frames = max(1, int(params.get("stable_frames") or default_vote))
        state = self._blocking_for(step_id, frame.index)

        if (time.monotonic() - state.started_at) * 1000 >= timeout_ms:
            # 等待失败也必须遵守全局/步骤出错策略；重试时重新计时，不能沿用已超时的状态。
            self.blocking = None
            return self._handle_failure(
                step_id, params, f"等待「{label}」超时（{timeout_ms}ms）· {self._best_score_text(label)}"
            )
        if frame.index <= state.entered_frame:
            return "wait"  # 还是进入时那一帧：不算数，等下一帧
        state.stable = state.stable + 1 if self._hit(label) else 0
        if state.stable >= stable_frames:
            self.blocking = None
            self._error_retries.pop(step_id, None)
            return "ok"
        return "wait"

    def _try_delay(self, step_id: str, params: dict[str, Any], frame: Frame) -> bool:
        """返回 True = 还在等。"""
        raw_ms = params.get("ms")
        if raw_ms is None or isinstance(raw_ms, bool):
            ms = 500
        else:
            try:
                ms = max(0, int(float(raw_ms)))
            except (TypeError, ValueError):
                ms = 500
        # 只认严格的 True：手改 graph 写成 "true"/1 时按固定延时走，
        # 不能在执行途中抛错把整条流程打断（与前端 `random === true` 一致）。
        random_mode = params.get("random") is True
        if random_mode:
            state = self._blocking_for(step_id, frame.index)
            if state.random_wait_ms is None:

                def bound(value: Any, fallback: int) -> int:
                    if value is None or isinstance(value, bool):
                        return min(600000, max(0, fallback))
                    try:
                        return min(600000, max(0, int(float(value))))
                    except (TypeError, ValueError, OverflowError):
                        return min(600000, max(0, fallback))

                minimum = bound(params.get("minMs"), 0)
                maximum = bound(params.get("maxMs"), minimum if "minMs" in params else ms)
                minimum, maximum = sorted((minimum, maximum))
                state.random_wait_ms = random.randint(minimum, maximum)
                self._emit(
                    "random_delay",
                    message=f"随机等待 {state.random_wait_ms}ms",
                    extra={**self._step_extra(), "randomWaitMs": state.random_wait_ms},
                )
                if self.evidence is not None:
                    self.evidence.merge(
                        self.cursor + 1,
                        {"randomWaitMs": state.random_wait_ms, "message": f"随机等待 {state.random_wait_ms}ms"},
                    )
            ms = state.random_wait_ms
        return self._try_step_phase_delay(step_id, ms, frame)

    def _general_settings(self, params: dict[str, Any]) -> dict[str, Any]:
        settings = params.get("settings")
        if not isinstance(settings, dict):
            return {}
        general = settings.get("general")
        return dict(general) if isinstance(general, dict) else {}

    def _with_jitter_ms(self, base_ms: int) -> int:
        if base_ms <= 0:
            return 0
        jitter = _as_int(self.graph.default("delay_jitter_ms", 0), 0)
        if jitter <= 0:
            return base_ms
        return max(0, base_ms + random.randint(-jitter, jitter))

    def _resolve_match_timeout_ms(self, params: dict[str, Any], *, default_fallback: int = 20000) -> int:
        # 条件/动作可以直接写 timeout_ms（条件面板使用这个字段）；
        # 显式写 0 也要能关闭等待，不能被 `or` 当成未配置而回退到全局值。
        for key in ("timeout_ms", "match_timeout_ms"):
            direct = params.get(key)
            if isinstance(direct, (int, float)) and not isinstance(direct, bool):
                return max(0, int(direct))
        general = self._general_settings(params)
        override = general.get("matchTimeoutMs")
        if isinstance(override, (int, float)) and not isinstance(override, bool):
            return max(0, int(override))
        return max(0, _as_int(self.graph.default("match_timeout_ms", default_fallback), default_fallback))

    def _resolve_pre_delay_ms(self, params: dict[str, Any]) -> int:
        general = self._general_settings(params)
        override = general.get("preDelayMs")
        if isinstance(override, (int, float)) and not isinstance(override, bool):
            base = max(0, int(override))
        else:
            base = max(0, _as_int(self.graph.default("pre_action_delay_ms", 0), 0))
        return self._with_jitter_ms(base)

    def _resolve_post_and_interval_ms(self, params: dict[str, Any]) -> int:
        general = self._general_settings(params)
        override = general.get("postDelayMs")
        if isinstance(override, (int, float)) and not isinstance(override, bool):
            post_ms = max(0, int(override))
        else:
            post_ms = max(0, _as_int(self.graph.default("post_action_delay_ms", 0), 0))
        interval_ms = max(0, _as_int(self.graph.default("step_interval_ms", 0), 0))
        return self._with_jitter_ms(post_ms + interval_ms)

    def _try_step_phase_delay(self, phase_id: str, ms: int, frame: Frame) -> bool:
        """阶段延时（动作前 / 动作后+步骤间隔 / 延时模块）：返回 True 表示还在等待。"""
        if ms <= 0:
            if self.blocking is not None and self.blocking.step_id == phase_id:
                self.blocking = None
            return False
        state = self._blocking_for(phase_id, frame.index)
        if (time.monotonic() - state.started_at) * 1000 >= ms:
            self.blocking = None
            return False
        return True

    def _try_wait_action_target(self, step_id: str, kind: str, params: dict[str, Any], frame: Frame) -> str:
        """若动作按识别器定位且当前未命中，按 match_timeout_ms（默认 20s）跨帧等待。"""
        if kind not in ("click", "hold"):
            return "ready"
        mode = _click_target_mode(params)
        if mode in ("coord", "region"):
            return "ready"
        target = str(params.get("rec") or "").strip()
        if not target:
            return "ready"
        if target in self.detections:
            if self.blocking is not None and self.blocking.step_id == f"{step_id}:match":
                self.blocking = None
            return "ready"
        timeout_ms = self._resolve_match_timeout_ms(params, default_fallback=20000)
        if timeout_ms <= 0:
            return "ready"
        state = self._blocking_for(f"{step_id}:match", frame.index)
        if (time.monotonic() - state.started_at) * 1000 >= timeout_ms:
            self.blocking = None
            return "timeout"
        return "wait"

    def _fail_action_match_timeout(self, step_id: str, params: dict[str, Any]) -> str:
        label = str(params.get("rec") or "").strip()
        timeout_ms = self._resolve_match_timeout_ms(params, default_fallback=20000)
        return self._handle_failure(
            step_id,
            params,
            f"等待「{label}」超时（{timeout_ms}ms）："
            f"目标当前没有命中 · {self._best_score_text(label)}",
        )

    def _condition_ok(self, params: dict[str, Any]) -> bool:
        groups = params.get("groups")
        if isinstance(groups, list) and groups:
            for group in groups:
                if not isinstance(group, dict):
                    continue
                all_of = group.get("all")
                if not isinstance(all_of, list) or not all_of:
                    continue
                labels = [str(item).strip() for item in all_of if item is not None and str(item).strip()]
                if labels and all(self._hit(label) for label in labels):
                    return True
            return False
        label = str(params.get("rec") or "")
        return bool(label) and self._hit(label)

    def _condition_summary(self, params: dict[str, Any]) -> str:
        groups = params.get("groups")
        if isinstance(groups, list) and groups:
            parts: list[str] = []
            for group in groups:
                if not isinstance(group, dict):
                    continue
                all_of = group.get("all")
                if not isinstance(all_of, list):
                    continue
                labels = [str(item).strip() for item in all_of if item is not None and str(item).strip()]
                if labels:
                    parts.append(" 且 ".join(labels))
            if parts:
                return " 或 ".join(parts)
        return str(params.get("rec") or "")

    def _call_subflow(self, params: dict[str, Any]) -> None:
        """「调用子流程」：在后台跑另一份工作流，跑完再回到当前链下一条。

        和状态机的「运行子工作流」共用 `on_call` → 会话层 `_call_workflow`，但两边语义不同：
        状态机调用后继续自己的边；FlowEngine 调用后由会话层把当前链挂起（`wait_for_subflow`），
        子链结束再恢复。不能再像旧版一样调用完就 `_finish(success)` 把当前链整份结束。
        """
        name = str(params.get("name") or "").strip()
        if not name:
            self._finish("failure", "「调用子流程」还没选要调用哪份工作流")
            return
        if self.on_call is None:
            self._finish("failure", "当前环境不支持调用子流程")
            return
        try:
            self.on_call(name)
        except Exception as exc:
            self._finish("failure", f"调用子流程「{name}」失败：{exc}")
            return
        self._emit("action_executed", message=f"调用子流程「{name}」")
        if self.waiting:
            # 会话层已经启动子链并让本链挂起：不要收尾，等子链跑完再回来。
            return
        self._finish("success", f"已切到子流程「{name}」")

    def _spec_for(self, kind: str, params: dict[str, Any]) -> dict[str, Any]:
        """目录里的参数 → 引擎的 action spec（两边的字段名不一样，映射只在这一处）。"""
        if kind in ("click", "hold"):
            raw_event = str(params.get("event") or "").strip()
            if kind == "hold" and not raw_event:
                action_type = "long_press"
            elif raw_event == "double_click":
                action_type = "double_click"
            elif raw_event in ("long_press", "hold"):
                action_type = "long_press"
            else:
                action_type = "click"

            mode = _click_target_mode(params)
            if mode == "region":
                coerced = _coerce_norm_rect(params.get("rect"))
                if coerced is None:
                    raise ValueError("随机范围点击尚未框选范围（请在画面栏拖框后再运行）")
                spec = {
                    "type": action_type,
                    "rect": coerced,
                    "random_in_rect": True,
                }
            elif mode == "coord":
                x, y = params.get("x"), params.get("y")
                if x is None or y is None:
                    raise ValueError("坐标点击缺少 x/y（请在节点填写或在画面上选点）")
                spec = {"type": action_type, "x": x, "y": y}
            else:
                rec = str(params.get("rec") or "").strip()
                if not rec:
                    raise ValueError("图像点击尚未选择识别器")
                spec = {"type": action_type, "target": rec}
                strategy = str(params.get("strategy") or "auto").strip().lower()
                if strategy and strategy != "auto":
                    spec["strategy"] = strategy
                    if strategy == "nth":
                        spec["index"] = params.get("index", 1)
            if action_type == "long_press":
                default_long_ms = _as_int(self.graph.default("long_press_duration_ms", 600), 600)
                spec["duration_ms"] = params.get("duration_ms") or default_long_ms
            # 拟人参数（偏移 / 按下 / 微移）只读全局设置，不从这里往下传
            return spec
        if kind == "swipe":
            default_swipe_ms = _as_int(self.graph.default("swipe_duration_ms", 300), 300)
            spec = {
                "type": "swipe",
                "x": params.get("x"),
                "y": params.get("y"),
                "to_x": params.get("to_x"),
                "to_y": params.get("to_y"),
                "duration_ms": params.get("duration_ms") or default_swipe_ms,
            }
            # 连续轨迹 / 末端按住（ADR 0002）：给了就按轨迹走，起点终点从首尾取
            if isinstance(params.get("path"), list):
                spec["path"] = params["path"]
            if params.get("hold_ms") not in (None, ""):
                spec["hold_ms"] = params["hold_ms"]
            # 拟人贝塞尔参数只读全局设置，不从这里往下传
            return spec
        if kind == "key":
            return {"type": "key", "value": params.get("value")}
        return {"type": "text", "value": params.get("value")}

    def _on_error_settings(self, params: dict[str, Any]) -> dict[str, Any]:
        settings = params.get("settings")
        if not isinstance(settings, dict):
            return {}
        on_error = settings.get("onError")
        return dict(on_error) if isinstance(on_error, dict) else {}

    def _step_index(self, step_id: str) -> int:
        for index, item in enumerate(self.steps):
            if str(item.get("id")) == step_id:
                return index
        return -1

    def _note_retry_wait(self) -> None:
        """重试前等多久：`retry_interval_ms`（0 = 下一拍立刻重试）。"""
        interval = max(0, _as_int(self.graph.default("retry_interval_ms", 0), 0))
        self._retry_ready_at = time.monotonic() + interval / 1000 if interval else 0.0

    def _resolve_step_failure(self, step_id: str, params: dict[str, Any], message: str) -> str:
        """出错策略：fail | retry | continue | fallback（跳转到指定步）。"""
        policy = self._on_error_settings(params)
        if not policy.get("enabled"):
            global_policy = str(self.graph.default("on_step_error", "stop") or "stop")
            if global_policy == "continue":
                self._emit("step_error_continue", message=message)
                return "continue"
            if global_policy == "retry":
                max_retries = max(1, _as_int(self.graph.default("step_retries", 2), 2))
                left = self._error_retries.get(step_id, max_retries)
                if left > 0:
                    self._error_retries[step_id] = left - 1
                    self._emit(
                        "step_retry",
                        message=f"出错重试（还剩 {left} 次）: {message}",
                        extra={**self._step_extra(params), "retry": left, "reason": message},
                    )
                    self._note_retry_wait()
                    return "retry"
                self._error_retries.pop(step_id, None)
            return "fail"
        if policy.get("retry"):
            max_retries = _as_int(policy.get("retryTimes"), 3)
            if max_retries < 1:
                max_retries = 1
            left = self._error_retries.get(step_id, max_retries)
            if left > 0:
                self._error_retries[step_id] = left - 1
                self._emit(
                    "step_retry",
                    message=f"出错重试（还剩 {left} 次）: {message}",
                    extra={**self._step_extra(params), "retry": left, "reason": message},
                )
                self._note_retry_wait()
                return "retry"
            self._error_retries.pop(step_id, None)
        mode = str(policy.get("mode") or "throw")
        if mode == "continue":
            self._emit("step_error_continue", message=message)
            return "continue"
        if mode == "insertData":
            insert = policy.get("insertData")
            if isinstance(insert, dict):
                key = insert.get("key")
                if isinstance(key, str) and key.strip():
                    self.variables.set(key.strip(), insert.get("value", ""))
                    self._emit("step_error_insert", message=f"出错写入变量「{key.strip()}」")
            return "continue"
        if mode == "fallback":
            target = policy.get("fallbackStepId")
            if isinstance(target, str) and target.strip():
                index = self._step_index(target.strip())
                if index >= 0:
                    self._emit("step_error_fallback", message=f"出错回退到第 {index + 1} 步: {message}")
                    self.cursor = index
                    return "fallback"
        return "fail"

    def _handle_failure(self, step_id: str, params: dict[str, Any], message: str) -> str:
        """按出错策略处理失败的一步；返回 "fail" 表示整条链要停，其余可继续推进。"""
        outcome = self._resolve_step_failure(step_id, params, message)
        if outcome == "retry":
            return "retry"
        if outcome == "continue":
            self.stats["steps"] += 1
            self._emit_step_finished(f"第 {self.cursor + 1} 步完成（出错已跳过）")
            self._announced = None
            self.cursor += 1
            return "continue"
        if outcome == "fallback":
            self._announced = None
            return "fallback"
        self._finish("failure", message)
        return "fail"

    def _perform_step(self, step_id: str, kind: str, params: dict[str, Any]) -> tuple[bool, str]:
        if kind in ("click", "hold"):
            params = _normalize_click_params(params)
        spec: dict[str, Any] = {}
        try:
            spec = dict(self._spec_for(kind, params))
            if (self._parent is not None or self.uses_scheduled_touches) and kind in ("click", "hold", "swipe"):
                described = self._perform_parallel_action(step_id, spec, params)
            else:
                described = self.perform(spec)
            if self._stop_requested.is_set():
                raise ActionCancelledError("设备动作已取消")
        except ActionCancelledError:
            return False, "已停止"
        except ActionDeferredError:
            raise
        except Exception as error:
            self.stats["failed"] += 1
            message = str(error) or error.__class__.__name__
            self._emit("step_failed", message=message, extra={**self._step_extra(params), "reason": message})
            return False, message
        details = self._match_details(params)
        self._emit(
            "action_executed",
            message=described,
            extra={
                "index": self.cursor + 1,
                "kind": kind,
                "params": self._resolved_params(spec),
                **details,
            },
        )
        if self.evidence is not None:
            self.evidence.merge(self.cursor + 1, {"result": described, **details})
        return True, described

    def _resolved_params(self, spec: dict[str, Any]) -> dict[str, Any]:
        """动作的实际入参（变量已求值）—— 排查"点到了哪"靠它。"""
        with contextlib.suppress(Exception):
            return _public_params(dict(resolve_spec(dict(spec), self.variables, self._scores())))
        return _public_params(dict(spec))

    def _match_details(self, params: dict[str, Any]) -> dict[str, Any]:
        """按识别器定位的动作：把当帧分数与命中框带上（"为什么没点中"就看这个）。"""
        label = str(params.get("rec") or "").strip()
        detection = self.detections.get(label) if label else None
        if detection is None:
            return {}
        details: dict[str, Any] = {
            "label": label,
            "score": round(float(detection.score), 4),
            "matchedRect": detection.rect.to_list(),
        }
        if len(detection.all_rects()) > 1:
            details["candidates"] = len(detection.all_rects())
        if self._last_selection:
            details.update(self._last_selection)
        return details

    def _perform_setvar(self, params: dict[str, Any]) -> tuple[bool, str]:
        """「赋值」：把 `value` 求值后写进运行期变量。"""
        name = str(params.get("name") or "").strip()
        if not name:
            return False, "「赋值」没写变量名"
        try:
            value = self._resolve_setvar_value(params.get("value", ""))
        except Exception as error:
            message = str(error) or error.__class__.__name__
            self._emit("step_failed", message=message, extra={**self._step_extra(params), "reason": message})
            return False, message
        self.variables.set(name, value)
        message = f"设置变量 {name} = {self.variables.get(name)!r}"
        if self.evidence is not None:
            self.evidence.merge(self.cursor + 1, {"result": message})
        return True, message

    def _resolve_setvar_value(self, raw: object) -> VarValue:
        """赋值右边的取值规则。

        - `{"$var":…}` / `{"$expr":…}` / `{"$score":…}`：走 `resolve_value`；
        - 纯数字字符串：转成数字（`次数` 是数字变量时才能累加）；
        - `$` 开头：当表达式（`$次数 + 1`）；
        - 其余：原样当字面量（空串就是空串）。
        """
        if isinstance(raw, (dict, list)):
            return _as_var_value(resolve_value(raw, self.variables, self._scores()))
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, (int, float)):
            return float(raw)
        text = str(raw).strip()
        if not text:
            return ""
        if text.startswith("$"):
            return _as_var_value(resolve_value({"$expr": text[1:].strip()}, self.variables, self._scores()))
        try:
            return float(text)
        except ValueError:
            return text

    def perform(self, spec: dict[str, Any]) -> str:
        """在输入事务内执行；手动通道占用时可延后至下帧，不持锁做感知。"""
        if self._stop_requested.is_set():
            raise ActionCancelledError("设备动作已取消")
        guard = self.input_guard() if self.input_guard is not None else contextlib.nullcontext()
        with guard:
            # 抢输入锁期间可能已收到停止；不能等到 controller 调用返回才发现。
            if self._stop_requested.is_set():
                raise ActionCancelledError("设备动作已取消")
            return self._perform_guarded(spec)

    def _perform_guarded(self, spec: dict[str, Any]) -> str:
        """执行一个动作 spec（**已求值**）。和状态机共用同一套落点解析与输入方式。"""
        if self._stop_requested.is_set():
            raise ActionCancelledError("设备动作已取消")
        resolved = resolve_spec(dict(spec), self.variables, self._scores())
        described = describe_action(resolved)
        action = Action.parse(resolved)
        controller = self.controller
        self._last_selection = {}

        if action.type == "text":
            if not hasattr(controller, "text"):
                raise ValueError("这个设备不支持「输入文字」")
            controller.text(action.value)
            self.stats["actions"] += 1
            return described
        if action.type == "key":
            self._press(action.value)
            self.stats["actions"] += 1
            return described
        if action.type == "wait":
            # 这一套的"等"是**独立的一步**，不在动作里 —— 走到这里说明有人手写了 wait 动作
            raise ValueError("步骤链里不要用 wait 动作；用「延时」或「等待界面」那两步")

        if action.type == "swipe":
            start = self._resolve_point(action, action.target, action.x, action.y)
            end = self._resolve_point(action, action.to_target, action.to_x, action.to_y, allow_auto=True)
            execute_swipe(
                controller,
                start,
                end,
                max(0.05, action.duration_ms / 1000.0),
                resolved,
                dict(self.graph.defaults),
                path=action.path,
                hold_ms=action.hold_ms,
                cancel_event=self._stop_requested,
            )
            self.stats["actions"] += 1
            return described

        points = self._resolve_points(action, action.target, action.x, action.y)
        defaults = dict(self.graph.defaults)
        performed = 0
        for point in points:
            if self._stop_requested.is_set():
                raise ActionCancelledError("设备动作已取消")
            if action.type == "long_press":
                execute_tap(
                    controller,
                    point,
                    resolved,
                    defaults,
                    duration_ms=max(50, action.duration_ms),
                    cancel_event=self._stop_requested,
                )
            elif action.type == "double_click":
                execute_tap(controller, point, resolved, defaults, count=2, cancel_event=self._stop_requested)
            else:
                execute_tap(controller, point, resolved, defaults, cancel_event=self._stop_requested)
            performed += 1
            # 等待可被停止信号唤醒；停止后不能再遍历并点击剩余候选。
            if len(points) > 1:
                self._stop_requested.wait(0.12)

        self.stats["actions"] += performed
        if len(points) > 1:
            return f"{described}（共 {len(points)} 个候选，依次点击）"
        return described

    def run_action(self, action: dict[str, Any]) -> str:
        """调试用："单独执行这一步" —— 不影响游标。"""
        if action.get("type") == "touch":
            raise ValueError("持续触控只能在完整流程运行，请使用运行和停止控制")
        described = self.perform(dict(action))
        self._emit("action_manual", message=f"单独执行：{described}")
        return described

    def _resolve_points(
        self,
        action: Action,
        target: str | None,
        x: float | None,
        y: float | None,
    ) -> list[tuple[float, float]]:
        """把目标解析成要点的点列表（多目标策略可能返回多个）。"""
        if not target:
            return [self._resolve_point(action, None, x, y)]
        detection = self.detections.get(target)
        if detection is None:
            # 素材当前没命中 → **不退回坐标**，直接失败（点错地方比不点更糟）
            raise ValueError(f"目标 {target} 当前没有命中，无法定位")
        rects = select_rects(
            detection,
            action.strategy,
            anchor=self._anchor_of(target),
            index=action.index,
        )
        self._last_selection = {
            "strategy": action.strategy,
            "candidates": len(detection.all_rects()),
            "picked": [rect.to_list() for rect in rects],
        }
        return [rect.center for rect in rects]

    def _anchor_of(self, label: str) -> tuple[float, float] | None:
        """「离录制位置最近」的锚点：识别器录制时框选区域的中心。"""
        recognizer = self.graph.recognizers.get(label)
        roi = getattr(recognizer, "roi", None)
        if roi is None:
            return None
        return (roi.cx, roi.cy)

    def _resolve_point(
        self,
        action: Action,
        target: str | None,
        x: float | None,
        y: float | None,
        *,
        allow_auto: bool = False,
    ) -> tuple[float, float]:
        if target:
            detection = self.detections.get(target)
            if detection is not None:
                rects = select_rects(
                    detection,
                    action.strategy,
                    anchor=self._anchor_of(target),
                    index=action.index,
                )
                self._last_selection = {
                    "strategy": action.strategy,
                    "candidates": len(detection.all_rects()),
                    "picked": [rect.to_list() for rect in rects],
                }
                return rects[0].center
            # 素材当前没命中 → **不退回坐标**，直接失败（点错地方比不点更糟）
            if not allow_auto:
                raise ValueError(f"目标 {target} 当前没有命中，无法定位")
        if action.rect is not None:
            rect = action.rect
            if action.random_in_rect:
                width = max(float(rect[2]), 1e-6)
                height = max(float(rect[3]), 1e-6)
                return (
                    min(1.0, max(0.0, float(rect[0]) + random.uniform(0.0, width))),
                    min(1.0, max(0.0, float(rect[1]) + random.uniform(0.0, height))),
                )
            return (rect[0] + rect[2] / 2, rect[1] + rect[3] / 2)
        if x is not None and y is not None:
            return (x, y)
        if allow_auto:
            return (0.5, 0.5)
        raise ValueError(f"{action.type} 缺少可定位的目标: {action.to_dict()}")

    def _press(self, name: str) -> None:
        controller = self.controller
        if hasattr(controller, "press"):
            controller.press(name)
        else:
            controller.key(name)

    def _finish(self, result: str, message: str) -> None:
        self.cancel_actions("finish")
        self.result = result
        self.waiting = False
        self.waiting_for = None
        self.blocking = None
        if result == "failure":
            self._capture_step(
                self.cursor + 1,
                str(self.current or ""),
                self._kind_at_cursor(),
                tag="failed",
                message=message,
            )
        total_ms = None
        if self._run_started_at is not None:
            total_ms = round((time.monotonic() - self._run_started_at) * 1000)
        self._emit(
            "flow_finished",
            message=message,
            extra={"result": result, "durationMs": total_ms, "steps": self.stats["steps"]},
        )

    def state(self) -> dict[str, Any]:
        return {
            "current": self.current,
            "pending": None,
            "tick": self.stats["ticks"],
            "stats": dict(self.stats),
            "detections": [item.to_dict() for item in self.detections.values()],
            "waiting": self.waiting,
            "activeStepIds": self.active_step_ids,
        }

    def _flush(self) -> list[TraceEvent]:
        out = self._outbox
        self._outbox = []
        return out

    def _loop_progress(self) -> list[dict[str, Any]]:
        """当前循环栈：前端循环节点头部用来画「2 / 12」。"""
        out: list[dict[str, Any]] = []
        for frame in self._loop_stack:
            if not 0 <= frame.loop_index < len(self.steps):
                continue
            step_id = str(self.steps[frame.loop_index].get("id") or "")
            if not step_id:
                continue
            total = max(1, int(frame.total))
            remaining = max(0, int(frame.remaining))
            current = min(total, max(1, total - remaining + 1))
            out.append({"stepId": step_id, "current": current, "total": total})
        return out

    def _kind_at_cursor(self) -> str:
        if 0 <= self.cursor < len(self.steps):
            return str(self.steps[self.cursor].get("type") or "")
        return ""

    def _step_extra(self, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """这一步的调试字段：第几步、类型、实际参数、耗时（毫秒）。"""
        extra: dict[str, Any] = {"index": self.cursor + 1, "kind": self._kind_at_cursor()}
        if params is not None:
            extra["params"] = _public_params(params)
        if self._step_started_at is not None:
            extra["durationMs"] = round((time.monotonic() - self._step_started_at) * 1000)
        return extra

    def _emit_step_finished(self, message: str) -> TraceEvent:
        extra = self._step_extra()
        event = self._emit("step_finished", message=message, extra=extra)
        if self.evidence is not None and "durationMs" in extra:
            self.evidence.merge(self.cursor + 1, {"durationMs": extra["durationMs"]})
        self._step_started_at = None
        return event

    def _capture_step(
        self,
        index: int,
        step_id: str,
        kind: str,
        params: dict[str, Any] | None = None,
        *,
        tag: str = "step",
        message: str = "",
    ) -> None:
        """把这一步的证据（截图 + 参数）记下来（没挂证据目录时什么也不做）。"""
        if self.evidence is None:
            return
        image = self._last_frame.image if self._last_frame is not None else None
        self.evidence.step(
            index,
            step_id,
            kind,
            image,
            tag=tag,
            message=message,
            params=_public_params(params) if params else None,
        )

    def attach_evidence(self, evidence: RunEvidence | None) -> None:
        self.evidence = evidence

    def close_evidence(self) -> RunEvidence | None:
        """跑完收尾：返回证据目录（调用方拿去给界面看），并解除挂载。"""
        evidence = self.evidence
        self.evidence = None
        if evidence is not None:
            evidence.close()
        return evidence

    def _emit(self, type_: str, *, message: str = "", extra: dict[str, Any] | None = None) -> TraceEvent:
        if self._parent is not None:
            if type_ == "flow_finished":
                type_ = "branch_finished"
            payload = dict(extra or {})
            payload.setdefault("loops", self._loop_progress())
            payload["branchPath"] = list(self._branch_path)
            payload["stepId"] = self.current
            root = self._root
            current = root.current
            root.current = self.current
            try:
                return root._emit(type_, message=message, extra=payload)
            finally:
                root.current = current
        self.seq += 1
        payload = dict(extra or {})
        if "loops" not in payload:
            payload["loops"] = self._loop_progress()
        event = TraceEvent(
            seq=self.seq,
            ts=time.time(),
            type=type_,
            node=self.current,
            edge=None,
            message=message,
            extra=payload,
        )
        self.trace.add_event(event)
        if self.evidence is not None:
            self.evidence.event(event.to_dict())
        self._outbox.append(event)
        if self.on_event:
            with contextlib.suppress(Exception):
                self.on_event(event)
        return event
