"""Device session facade: shared state, lifecycle and explicit typed service delegation.

Locks and worker ownership remain here; business implementation lives in adjacent services.
"""

from __future__ import annotations

import contextlib
import json
import logging
import sqlite3
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator
from typing import Any

import numpy as np

from ..core.actions import Action
from ..core.evidence import RunEvidence
from ..core.flow_engine import FlowEngine
from ..core.frame import Frame
from ..core.geometry import Rect
from ..core.graph import Graph
from ..core.state_machine import Engine
from ..core.trace import TraceBuffer
from ..devices import ORIENTATION_LABELS
from ..devices.base import Controller
from ..frames import FrameSink
from ..project import Project
from .capture import CaptureService
from .editing import GraphEditingService
from .execution import ExecutionService
from .history import HistoryService
from .input import InputService
from .materials import MaterialRecordingService
from .models import (
    FRAME_HISTORY,
    FRAME_HISTORY_BYTES,
    SCRCPY_LOOP_FPS,
    Emit,
    WorkflowRunner,
    _env_int,
    _load_graph,
    describe_graph_error,
)
from .recordings import RecordingService
from .yolo import YoloService

logger = logging.getLogger("gamepilot.session")


class DeviceSession:
    def __init__(
        self,
        device_id: str,
        controller: Controller,
        project: Project,
        emit: Emit,
        *,
        fps: float = 8.0,
        jpeg_width: int = 0,
        jpeg_quality: int = 92,
    ) -> None:
        self._capture = CaptureService(self)
        self._execution = ExecutionService(self)
        self._recordings = RecordingService(self)
        self._history = HistoryService(self)
        self._inputs = InputService(self)
        self._editing = GraphEditingService(self)
        self._materials = MaterialRecordingService(self)
        self._yolo = YoloService(self)
        self.device_id = device_id
        #: 建会话时用的 URI（含 `post=` / `cursor=` 这类输入参数）。同一个 deviceId
        #: 用**不同 URI** 再连一次（例如切前台/后台输入方式）时必须重建会话，不能复用。
        self.source_uri = ""
        self.controller = controller
        self.project = project
        self.emit = emit
        #: AI 识别弹窗的冻结帧（previewId → 那一帧的 BGR 拷贝）：标注/预览时画面不动
        self._preview_frames: dict[str, np.ndarray] = {}
        #: 最近的帧（index, jpeg, width, height, ts）：AI 标注可以前后翻帧挑参考
        self._history_limit = max(20, _env_int("GAMEPILOT_FRAME_HISTORY", FRAME_HISTORY))
        self._history_byte_limit = max(
            32 * 1024 * 1024,
            _env_int("GAMEPILOT_FRAME_HISTORY_BYTES", FRAME_HISTORY_BYTES),
        )
        self._history_bytes = 0
        self._frame_history: deque[tuple[int, bytes, int, int, float]] = deque(maxlen=self._history_limit)
        # AI 对话录屏独立于上述有界预览缓存：每段录像一个 SQLite 文件，
        # 只保留当前写入连接与 id；索引、JPEG 均在磁盘上，不在内存攒帧号。
        self._recordings_dir: str | None = None
        self._recording_id: str | None = None
        self._recording_db: sqlite3.Connection | None = None
        self._recordings_closed = False
        # scrcpy 通道能到 ~28fps，帧率上限跟着提上去；adb 截图通道每秒只有 1.8 帧，
        # 上限设多少都无所谓（循环自然被截图耗时卡住）
        if getattr(controller, "channel", "") == "scrcpy":
            fps = max(fps, SCRCPY_LOOP_FPS)
        self.fps_limit = max(1.0, fps)
        # 推给界面的预览帧：720p/q65 连文字都看不清，AI 标注的示例快照也会糊
        self.jpeg_width = _env_int("GAMEPILOT_JPEG_WIDTH", jpeg_width)
        self.jpeg_quality = _env_int("GAMEPILOT_JPEG_QUALITY", jpeg_quality)

        self.trace = TraceBuffer()
        # 图读不回来（文件被写坏/手改坏）时**不阻断建会话**：拿一张同路径的空图顶上，
        # 把原因记在 graph_error 上；界面显示"这份读不了"，而不是连设备都连不上。
        self.graph_error: str | None = None
        try:
            self.graph = _load_graph(project)
        except Exception as error:
            self.graph = Graph.empty(project.root, path=project.graph_path or None)
            self.graph_error = describe_graph_error(project, error)
            logger.error("状态图读取失败: %s", self.graph_error)
        self.engine = self._make_engine(self.graph)
        self.runners: dict[str, WorkflowRunner] = {}
        # 子工作流 → 调用它的父工作流 root。只对 FlowEngine 的“调用后继续”语义生效。
        self.subflow_parent: dict[str, str] = {}
        # 当前正在 tick 的 runner root：调用动作发生在哪个引擎里，就以它为父链
        # （不能拿 project.root：调用不跳画布后 project 一直是 A，嵌套调用会认错）。
        self._ticking_root = ""
        # 每份工作流最近一次运行的证据目录（跑完也留着：界面要看截图与每一步的参数）
        self.evidence: dict[str, RunEvidence] = {}
        self.lock = threading.RLock()
        self.running = False  # 是否有任一份工作流在跑
        self._run_revision = 0  # State commits and snapshots share self.lock.
        # 「每隔一段 / 定时开始」触发器：下一次该跑的时刻（墙钟秒；None = 不排期）
        self._auto_at: float | None = None
        self.started = False  # 截图循环是否在跑
        self.index = 0
        self.fps = 0.0
        self.capture_ms = 0.0
        self.last_frame: np.ndarray | None = None
        # 连续截图失败才标记不可用；恢复一帧后清掉，不让状态卡在「失败」。
        self.capture_error: str | None = None
        self._last_emit_at: float | None = None
        self._input_seq = 0  # 手动控制事件的序号（事件栏按 seq 排序）
        self._touch_from: tuple[float, float] | None = None
        # 录制的上一条动作边：下次录新界面时自动把 to 接上
        # 「运行子工作流」的回调（由 SessionManager 注入：切工作流目录要全局一致）
        self.on_call_script: Callable[[str], None] | None = None
        self._pending_edge_id: str | None = None
        # 最近一次录制涉及的节点：刚录完模板马上点一下时，靠它定位这一步属于哪个界面
        self._last_node_id: str | None = None
        self._last_node_at = 0.0
        # 推给界面的帧率（0 = 暂停推帧）。识别/状态机不受影响，仍按 fps_limit 跑，
        # 这样"界面不看这台设备"时不会白烧 CPU 与带宽（多设备时尤其明显）
        # 默认 0：界面明确要了才推。连接瞬间就按 15fps 推帧会把控制通道（同一根
        # stdout）灌满，RPC 响应排在几万行帧后面 —— 表现就是"卡在 connecting、一帧都收不到"
        self.stream_fps = 0.0
        # 帧走独立 socket（见 frames.py）：不占控制通道，宿主也不做 base64
        self.frames = FrameSink.from_env()
        self._last_push_at = 0.0
        self._last_seq: int | None = None
        self._last_jpeg: bytes | None = None
        # 分段计时：每 TIMING_LOG_SECONDS 汇总成一行日志，回答"帧率/延迟花在哪"
        self._stage_ms: dict[str, float] = {"capture": 0.0, "perceive": 0.0, "push": 0.0}
        self._stage_frames = 0
        self._stage_since = time.perf_counter()
        # sleep 的实测偏差（秒，EWMA）：用于把"多睡掉的那几毫秒"从间隔里扣回来
        self._sleep_bias = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._worker: threading.Thread | None = None
        self._recorder: threading.Thread | None = None
        self._frame_ready = threading.Condition()
        self._latest_frame: Frame | None = None
        self._execution_lock = threading.RLock()
        self._lifecycle_lock = threading.RLock()
        self._input_lock = threading.Lock()
        self._manual_touch = False
        self._recording_lock = threading.RLock()
        self._record_ready = threading.Condition()
        self._record_pending: tuple[Frame, str] | None = None
        self._record_dropped = 0
        self._execution_ms = 0.0
        self._execution_frames = 0
        self._execution_dropped = 0
        self._execution_index = 0
        self._view_snapshot: tuple[Engine | FlowEngine, int, float, list[dict[str, Any]]] | None = None
        self._view_state: tuple[Engine | FlowEngine, str | None, str | None, int] | None = None
        self._ticking_engine: Engine | FlowEngine | None = None
        self._history_lock = threading.Lock()

    def start(self) -> None:
        if self.started:
            return
        if any(thread is not None and thread.is_alive() for thread in (self._thread, self._worker, self._recorder)):
            raise RuntimeError("旧会话线程尚未退出，不能重启")
        self._stop.clear()
        if self.frames is not None:
            self.frames.start()  # 帧通道：JPEG 走独立 socket，不占控制通道
        self._thread = threading.Thread(target=self._loop, name=f"capture-{self.device_id}", daemon=True)
        self._worker = threading.Thread(target=self._execution_loop, name=f"execute-{self.device_id}", daemon=True)
        self._recorder = threading.Thread(target=self._recording_loop, name=f"record-{self.device_id}", daemon=True)
        self.started = True
        self._worker.start()
        self._recorder.start()
        self._thread.start()
        self._arm_auto_trigger()  # 连上就算第一次（interval/schedule 才有）
        logger.info("会话启动: %s", self.device_id)

    def stop(self) -> None:
        self._stop.set()
        with self._lifecycle_lock, self.lock:
            runners = list(self.runners.values())
            for runner in runners:
                runner.cancelled = True
                if isinstance(runner.engine, FlowEngine):
                    runner.engine.request_stop()
            self.runners.clear()
            self.subflow_parent.clear()
            self.running = False
            if runners:
                self._run_revision += 1
        with self._frame_ready:
            self._latest_frame = None
            self._frame_ready.notify_all()
        with self._record_ready:
            self._record_pending = None
            self._record_ready.notify_all()
        # Release timestamped multi-touch before closing the transport; closing an
        # unused scheduler must not create a worker on single-touch controllers.
        from ..core.touch_scheduler import close_touch_scheduler

        try:
            close_touch_scheduler(self.controller)
        except Exception as exc:  # a broken connection cannot acknowledge an UP
            logger.warning("关闭多指输入调度失败: %s", exc)
        # close 先打断可能阻塞的设备读写；协作动作也会看到 _stop/request_stop。
        try:
            self.controller.close()
        except Exception as exc:  # pragma: no cover
            logger.warning("关闭设备失败: %s", exc)
        for thread in (self._thread, self._worker, self._recorder):
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=3)
                if thread.is_alive():
                    logger.error("会话线程尚未退出（保留引用，禁止重新启动）: %s", thread.name)
        if self.frames is not None:
            self.frames.close()
        self.started = False
        for runner in runners:
            if not runner.inflight:
                self._collect_evidence(runner.root, runner.engine)
        self._recordings.close()

    def _loop(self) -> None:
        return self._capture._loop()

    def _capture_loop(self) -> None:
        return self._capture._capture_loop()

    def _execution_loop(self) -> None:
        return self._execution._execution_loop()

    def _execute_frame(self, frame: Frame) -> None:
        return self._execution._execute_frame(frame)

    def _recording_loop(self) -> None:
        return self._recordings._recording_loop()

    def _flush_timing(self) -> None:
        return self._capture._flush_timing()

    def _complete_run(self, root: str, result: str, *, expected: WorkflowRunner | None = None) -> list[tuple[str, str]]:
        return self._execution._complete_run(root, result, expected=expected)

    def _finish_run(self, root: str, result: str, *, expected: WorkflowRunner | None = None) -> list[tuple[str, str]]:
        return self._execution._finish_run(root, result, expected=expected)

    def _runner_tickable(self, runner: WorkflowRunner) -> bool:
        return self._execution._runner_tickable(runner)

    def _subflow_descendants(self, root: str) -> list[str]:
        return self._execution._subflow_descendants(root)

    def _drop_runner(self, root: str, result: str) -> None:
        return self._execution._drop_runner(root, result)

    def _should_push(self) -> bool:
        return self._capture._should_push()

    def set_stream_fps(self, fps: float) -> None:
        return self._capture.set_stream_fps(fps)

    def _emit_frame(
        self,
        frame: Frame,
        detections: list[dict[str, Any]],
        *,
        snapshot: tuple[Engine | FlowEngine, int, float, list[dict[str, Any]]] | None = None,
    ) -> None:
        # 画面没变（scrcpy 静止时会重复同一帧）就复用上次的 JPEG，省掉一次编码
        return self._capture._emit_frame(frame, detections, snapshot=snapshot)

    def start_recording(self) -> dict[str, Any]:
        return self._recordings.start_recording()

    def _recording_path(self, recording_id: str) -> str:
        # UUID hex is the only permissible filename, even if supplied by an untrusted RPC caller.
        return self._recordings._recording_path(recording_id)

    def _record_frame(self, frame: Frame, *, recording_id: str | None = None) -> None:
        return self._recordings._record_frame(frame, recording_id=recording_id)

    def _recording_summary(self, db: sqlite3.Connection, recording_id: str) -> dict[str, Any]:
        return self._recordings._recording_summary(db, recording_id)

    def stop_recording(self, recording_id: str | None = None) -> dict[str, Any]:
        return self._recordings.stop_recording(recording_id)

    def recording_meta(self, recording_id: str, *, after_index: int = -1, limit: int = 100) -> dict[str, Any]:
        return self._recordings.recording_meta(recording_id, after_index=after_index, limit=limit)

    def recording_frame_at(self, recording_id: str, index: int) -> dict[str, Any]:
        return self._recordings.recording_frame_at(recording_id, index)

    def delete_recording(self, recording_id: str) -> None:
        return self._recordings.delete_recording(recording_id)

    def frame_meta(self) -> dict[str, Any]:
        return self._history.frame_meta()

    def frame_at(self, index: int, nearest: bool = False) -> dict[str, Any]:
        return self._history.frame_at(index, nearest)

    @staticmethod
    def _frame_payload(item: tuple[int, bytes, int, int, float], requested: int) -> dict[str, Any]:
        return HistoryService._frame_payload(item, requested)

    def frame_history(self, count: int = 20) -> list[dict[str, Any]]:
        return self._history.frame_history(count)

    def _encode_jpeg(self, image: np.ndarray) -> bytes:
        return self._history._encode_jpeg(image)

    def _on_engine_event(self, event: Any, *, workflow_root: str = "") -> None:
        return self._execution._on_engine_event(event, workflow_root=workflow_root)

    @contextlib.contextmanager
    def _automatic_input(self) -> Iterator[None]:
        with self._inputs._automatic_input():
            yield

    def _automatic_engines(self) -> list[FlowEngine]:
        return self._inputs._automatic_engines()

    @contextlib.contextmanager
    def _manual_input(self) -> Iterator[None]:
        with self._inputs._manual_input():
            yield

    def run_action(self, action: dict[str, Any]) -> str:
        return self._inputs.run_action(action)

    def touch(self, phase: str, x: float, y: float) -> None:
        return self._inputs.touch(phase, x, y)

    def tap(self, x: float, y: float) -> None:
        return self._inputs.tap(x, y)

    def swipe(self, x1: float, y1: float, x2: float, y2: float, duration: float) -> None:
        return self._inputs.swipe(x1, y1, x2, y2, duration)

    def press(self, name: str) -> None:
        return self._inputs.press(name)

    def _emit_input(self, title: str, detail: str, started: float) -> None:
        return self._inputs._emit_input(title, detail, started)

    def _arm_auto_trigger(self) -> None:
        return self._execution._arm_auto_trigger()

    def _maybe_auto_run(self) -> None:
        return self._execution._maybe_auto_run()

    def start_run(self, from_step_id: str | None = None, workflow_root: str | None = None) -> None:
        return self._execution.start_run(from_step_id, workflow_root)

    def _start_run(self, from_step_id: str | None, workflow_root: str | None) -> None:
        return self._execution._start_run(from_step_id, workflow_root)

    def stop_run(self, workflow_root: str | None = None) -> None:
        return self._execution.stop_run(workflow_root)

    def _stop_run(self, workflow_root: str | None) -> None:
        return self._execution._stop_run(workflow_root)

    def _make_engine(
        self, graph: Graph, start_node: str | None = None, workflow_root: str | None = None
    ) -> Engine | FlowEngine:
        return self._execution._make_engine(graph, start_node, workflow_root)

    def _require_workflow(self) -> None:
        return self._editing._require_workflow()

    def record_action(self, action: dict[str, Any], *, to: str | None = None) -> dict[str, Any]:
        return self._editing.record_action(action, to=to)

    def _record_flow_action(self, parsed: Action) -> dict[str, Any]:
        return self._editing._record_flow_action(parsed)

    def _latest_node_id(self) -> str | None:
        return self._editing._latest_node_id()

    def _auto_create_node_for_recording(self) -> tuple[str, str | None]:
        return self._editing._auto_create_node_for_recording()

    def graph_node_add(self, node_id: str | None, name: str | None, enter: list[str] | None) -> dict[str, Any]:
        return self._editing.graph_node_add(node_id, name, enter)

    def graph_node_update(self, node_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        return self._editing.graph_node_update(node_id, patch)

    def graph_node_remove(self, node_id: str) -> dict[str, Any]:
        return self._editing.graph_node_remove(node_id)

    def graph_edge_add(
        self,
        *,
        src: str | None,
        dst: str | None,
        when: str | None = None,
        action: dict[str, Any] | None = None,
        condition: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self._editing.graph_edge_add(src=src, dst=dst, when=when, action=action, condition=condition)

    def add_recognizer(self, label: str, spec: dict[str, Any]) -> dict[str, Any]:
        return self._yolo.add_recognizer(label, spec)

    def add_example(self, label: str, rect: list[float], image: object = None) -> dict[str, Any]:
        return self._yolo.add_example(label, rect, image)

    def recognizer_detail(self, label: str) -> dict[str, Any]:
        return self._yolo.recognizer_detail(label)

    def recognizer_update(self, label: str, spec: dict[str, Any], new_label: str | None = None) -> dict[str, Any]:
        return self._yolo.recognizer_update(label, spec, new_label)

    def preview_yolo(
        self,
        preview_id: str,
        examples: list[dict[str, Any]],
        *,
        conf: float = 0.3,
        iou: float = 0.45,
        imgsz: int = 640,
        tile: bool = False,
        tile_size: int = 640,
        tile_overlap: float = 0.2,
        freeze: bool = True,
        roi: list[float] | tuple[float, float, float, float] | None = None,
    ) -> dict[str, Any]:
        return self._yolo.preview_yolo(
            preview_id,
            examples,
            conf=conf,
            iou=iou,
            imgsz=imgsz,
            tile=tile,
            tile_size=tile_size,
            tile_overlap=tile_overlap,
            freeze=freeze,
            roi=roi,
        )

    def _finish_record(
        self,
        *,
        label: str,
        spec: dict[str, Any],
        mode: str,
        search_mode: str,
        filename: str,
        rect: Rect,
        as_enter: bool,
        as_action_target: bool,
        node_id: str | None,
        node_name: str | None,
        allocate_node_id: bool,
    ) -> dict[str, Any]:
        return self._materials._finish_record(
            label=label,
            spec=spec,
            mode=mode,
            search_mode=search_mode,
            filename=filename,
            rect=rect,
            as_enter=as_enter,
            as_action_target=as_action_target,
            node_id=node_id,
            node_name=node_name,
            allocate_node_id=allocate_node_id,
        )

    def record_template(
        self,
        rect: Rect,
        label: str,
        threshold: float = 0.82,
        *,
        as_enter: bool = True,
        as_action_target: bool = True,
        node_id: str | None = None,
        node_name: str | None = None,
        allocate_node_id: bool = False,
        search: str = "region",
    ) -> dict[str, Any]:
        return self._materials.record_template(
            rect,
            label,
            threshold,
            as_enter=as_enter,
            as_action_target=as_action_target,
            node_id=node_id,
            node_name=node_name,
            allocate_node_id=allocate_node_id,
            search=search,
        )

    def record_ocr(
        self,
        rect: Rect,
        label: str,
        text: str,
        *,
        mode: str = "contains",
        threshold: float = 0.6,
        as_enter: bool = True,
        as_action_target: bool = True,
        node_id: str | None = None,
        node_name: str | None = None,
        allocate_node_id: bool = False,
        search: str = "region",
    ) -> dict[str, Any]:
        return self._materials.record_ocr(
            rect,
            label,
            text,
            mode=mode,
            threshold=threshold,
            as_enter=as_enter,
            as_action_target=as_action_target,
            node_id=node_id,
            node_name=node_name,
            allocate_node_id=allocate_node_id,
            search=search,
        )

    def rename_recognizer(self, old: str, new: str) -> dict[str, Any]:
        return self._editing.rename_recognizer(old, new)

    def remove_recognizer(self, label: str) -> dict[str, Any]:
        return self._editing.remove_recognizer(label)

    def set_threshold(self, label: str, threshold: float) -> dict[str, Any]:
        return self._editing.set_threshold(label, threshold)

    def set_recognizer_search(self, label: str, search: str) -> dict[str, Any]:
        return self._editing.set_recognizer_search(label, search)

    def save_graph(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._editing.save_graph(payload)

    def _on_call_script(self, script: str) -> None:
        return self._execution._on_call_script(script)

    def _root_key(self, root: str | None) -> str:
        return self._execution._root_key(root)

    def _same_root(self, left: str | None, right: str | None) -> bool:
        return self._execution._same_root(left, right)

    def _runner_busy(self, runner: WorkflowRunner) -> bool:
        return self._execution._runner_busy(runner)

    def _any_running(self) -> bool:
        return self._execution._any_running()

    def _root_busy(self, root: str | None) -> bool:
        return self._execution._root_busy(root)

    def _ensure_runner(self, root: str) -> WorkflowRunner:
        return self._execution._ensure_runner(root)

    def reload_graph(self) -> None:
        return self._execution.reload_graph()

    def status(self) -> dict[str, Any]:
        with self.lock:
            engine = self.engine
            pending = engine.pending
            orientation = getattr(self.controller, "orientation", None)
            orientation_code = orientation if isinstance(orientation, int) else None
            return {
                "deviceId": self.device_id,
                "uri": getattr(self.controller, "options", {}),
                "resolution": list(self.controller.resolution) if self.started else None,
                "running": self.running,
                "workflowRoot": self.graph.base_dir or "",
                "runningWorkflows": [runner.root for runner in self.runners.values() if self._runner_busy(runner)],
                "index": self.index,
                "fps": round(self.fps, 1),
                "fpsLimit": round(self.fps_limit, 1),
                "captureMs": round(self.capture_ms, 1),
                "executionMs": round(self._execution_ms, 1),
                "executionFrames": self._execution_frames,
                "executionIndex": self._execution_index,
                "executionDropped": self._execution_dropped,
                "recordingDropped": self._record_dropped,
                "channel": getattr(self.controller, "channel", "unknown"),
                "streamFps": round(self.stream_fps, 1),
                # iOS 会变：界面方向（横屏坐标变换靠它，排错时一眼能看到）
                "variables": self.engine.variables.snapshot(),
                # 断点调试：暂停态与断点列表（界面/命令行都能看）
                "paused": self.engine.paused,
                "pausedAt": self.engine.paused_at,
                "breakpoints": sorted(self.engine.breakpoints),
                "orientation": orientation_code,
                "orientationName": ORIENTATION_LABELS.get(orientation_code, None) if orientation_code else None,
                "linkNote": getattr(self.controller, "link_note", ""),
                "linkFps": round(float(getattr(self.controller, "link_fps", 0.0)), 1),
                "node": self.engine.current,
                "pending": pending.edge.id if pending else None,
                "tick": self.engine.stats["ticks"],
                "stats": dict(self.engine.stats),
                "graph": json.loads(json.dumps(self.graph.to_dict())),
            }

    def timeline(self, limit: int = 60) -> dict[str, Any]:
        return {
            "frames": self.trace.recent_frames(limit),
            "events": self.trace.recent_events(limit),
            "evidence": self.evidence_bundle(),
        }

    def _attach_evidence(self, runner: WorkflowRunner) -> None:
        return self._execution._attach_evidence(runner)

    def _collect_evidence(self, root: str, engine: Any) -> None:
        return self._execution._collect_evidence(root, engine)

    def evidence_bundle(self, workflow_root: str | None = None) -> dict[str, Any] | None:
        return self._execution.evidence_bundle(workflow_root)

    def evidence_image(self, name: str, workflow_root: str | None = None) -> bytes | None:
        return self._execution.evidence_image(name, workflow_root)
