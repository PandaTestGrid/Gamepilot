"""CaptureService: extracted session responsibility; shared state belongs to DeviceSession."""

from __future__ import annotations

import base64
import contextlib
import logging
import time
from typing import TYPE_CHECKING, Any

from ..core.flow_engine import FlowEngine
from ..core.frame import Frame
from ..core.state_machine import Engine
from ..protocol import NOTIFY_DEVICE_FAILED, NOTIFY_DEVICE_RECOVERED

if TYPE_CHECKING:
    from .device import DeviceSession

from .models import PUSH_TOLERANCE, SLEEP_BIAS_ALPHA, SLEEP_BIAS_MAX, TIMING_LOG_SECONDS

logger = logging.getLogger("gamepilot.session")


class CaptureService:
    def __init__(self, session: DeviceSession) -> None:
        self.session = session

    def _loop(self) -> None:
        try:
            self.session._capture_loop()
        except Exception as error:
            logger.exception("采集线程异常退出: %s", self.session.device_id)
            self.session.capture_error = f"采集线程异常退出: {error}"
            notify = not self.session._stop.is_set()
            self.session._stop.set()
            for runner in list(self.session.runners.values()):
                if isinstance(runner.engine, FlowEngine):
                    runner.engine.request_stop()
            if notify:
                with contextlib.suppress(Exception):
                    self.session.emit(
                        NOTIFY_DEVICE_FAILED, {"deviceId": self.session.device_id, "error": self.session.capture_error}
                    )
        finally:
            self.session.started = False
            with self.session._frame_ready:
                self.session._frame_ready.notify_all()
            with self.session._record_ready:
                self.session._record_ready.notify_all()

    def _capture_loop(self) -> None:
        interval = 1.0 / self.session.fps_limit
        failures = 0
        last_channel = getattr(self.session.controller, "channel", "")
        while not self.session._stop.is_set():
            started = time.perf_counter()
            try:
                image = self.session.controller.screenshot()
            except Exception as exc:
                if self.session._stop.is_set():
                    break  # 用户已断开；迟到的截图异常不能再把设备标成 failed
                failures += 1
                message = f"截图失败: {exc}"
                if failures >= 3 and message != self.session.capture_error:
                    self.session.capture_error = message
                    self.session.emit(
                        NOTIFY_DEVICE_FAILED,
                        {
                            "deviceId": self.session.device_id,
                            "error": message,
                            "channel": getattr(self.session.controller, "channel", "unknown"),
                            "linkNote": getattr(self.session.controller, "link_note", ""),
                        },
                    )
                self.session._stop.wait(0.5)
                continue

            if self.session._stop.is_set():
                break  # 截图完成时会话已停，不能把旧帧或恢复通知再推给前端
            failures = 0
            channel = getattr(self.session.controller, "channel", "")
            if self.session.capture_error is not None or channel != last_channel:
                self.session.capture_error = None
                self.session.emit(
                    NOTIFY_DEVICE_RECOVERED,
                    {
                        "deviceId": self.session.device_id,
                        "channel": channel,
                        "linkNote": getattr(self.session.controller, "link_note", ""),
                    },
                )
            last_channel = channel

            self.session.capture_ms = (time.perf_counter() - started) * 1000
            self.session.index += 1
            frame = Frame(
                image=image,
                size=self.session.controller.resolution,
                index=self.session.index,
                async_max_age_seconds=0.5,
            )
            # 图片发布后只读；控制器可能复用自己的缓冲，因此在边界拷贝一次。
            frame.image = image.copy()
            self.session.last_frame = frame.image
            with self.session._frame_ready:
                self.session._latest_frame = frame
                self.session._frame_ready.notify()
            recording_id = self.session._recording_id
            if recording_id is not None:
                with self.session._record_ready:
                    if self.session._record_pending is not None:
                        self.session._record_dropped += 1
                    self.session._record_pending = (frame, recording_id)
                    self.session._record_ready.notify()
            snapshot = self.session._view_snapshot
            detections = snapshot[3] if snapshot is not None and snapshot[0] is self.session.engine else []
            if self.session._should_push():
                push_started = time.perf_counter()
                self.session._emit_frame(frame, detections, snapshot=snapshot)
                self.session._stage_ms["push"] += (time.perf_counter() - push_started) * 1000

            elapsed = time.perf_counter() - started
            # fps 是"实际交付节奏"（两次推帧的间隔），不是 1/截图耗时：
            # scrcpy 通道截图只要 0.3ms，按后者算会得出 1300fps 这种假数字
            now = time.perf_counter()
            period = now - self.session._last_emit_at if self.session._last_emit_at else elapsed
            self.session.fps = 1.0 / period if period > 0 else 0.0
            self.session._last_emit_at = now
            self.session._stage_ms["capture"] += self.session.capture_ms
            self.session._stage_frames += 1
            self.session._flush_timing()
            # 扣掉实测偏差再睡：不补偿的话中位多睡 3.5ms，30fps 直接掉到 27fps。
            # 偏差按"本拍总耗时（含这觉）vs 目标间隔"学（EWMA）；
            # 一定要在睡完之后量，睡之前量的只是干活时间，永远小于间隔，学不到东西。
            remaining = interval - (time.perf_counter() - started) - self.session._sleep_bias
            if remaining > 0.0:
                self.session._stop.wait(remaining)
                cycle = time.perf_counter() - started
                self.session._sleep_bias = min(
                    SLEEP_BIAS_MAX,
                    max(0.0, self.session._sleep_bias + (cycle - interval) * SLEEP_BIAS_ALPHA),
                )

    def _flush_timing(self) -> None:
        """每 TIMING_LOG_SECONDS 报一次分段耗时：帧率/延迟到底花在哪。

        采集推流只统计抓帧/编码推送；执行耗时独立展示，不再算入视频帧预算。
        慢执行的跳帧数量由 executionDropped 单独统计。
        """
        now = time.perf_counter()
        span = now - self.session._stage_since
        frames = self.session._stage_frames
        if span < TIMING_LOG_SECONDS or frames <= 0:
            return
        stage = self.session._stage_ms
        logger.info(
            "采集推流 %.1ffps（%d 帧 / %.1fs）：抓帧 %.2fms · 独立执行最近 %.2fms · 编码推送 %.2fms · 帧周期 %.1fms · 睡眠补偿 %.1fms",
            frames / span,
            frames,
            span,
            stage["capture"] / frames,
            self.session._execution_ms,
            stage["push"] / frames,
            span * 1000.0 / frames,
            self.session._sleep_bias * 1000.0,
        )
        self.session._stage_ms = {key: 0.0 for key in stage}
        self.session._stage_frames = 0
        self.session._stage_since = now

    def _should_push(self) -> bool:
        """这一拍要不要推给界面（stream_fps = 0 表示界面没显示这台设备）。"""
        if self.session.stream_fps <= 0:
            return False
        gap = 1.0 / self.session.stream_fps
        now = time.perf_counter()
        if now - self.session._last_push_at < gap - min(PUSH_TOLERANCE, gap * 0.2):
            return False
        self.session._last_push_at = now
        return True

    def set_stream_fps(self, fps: float) -> None:
        self.session.stream_fps = max(0.0, float(fps))
        logger.info("推流帧率: %.1f fps (设备 %s)", self.session.stream_fps, self.session.device_id)

    def _emit_frame(
        self,
        frame: Frame,
        detections: list[dict[str, Any]],
        *,
        snapshot: tuple[Engine | FlowEngine, int, float, list[dict[str, Any]]] | None = None,
    ) -> None:
        # 画面没变（scrcpy 静止时会重复同一帧）就复用上次的 JPEG，省掉一次编码
        seq = getattr(self.session.controller, "_frame_seq", None)
        if seq is not None and seq == self.session._last_seq and self.session._last_jpeg is not None:
            jpeg_bytes = self.session._last_jpeg
        else:
            jpeg_bytes = self.session._encode_jpeg(frame.image)
            self.session._last_seq = seq
            self.session._last_jpeg = jpeg_bytes

        if jpeg_bytes:
            with self.session._history_lock:
                if len(self.session._frame_history) == self.session._history_limit:
                    self.session._history_bytes -= len(self.session._frame_history[0][1])
                self.session._frame_history.append(
                    (frame.index, jpeg_bytes, int(frame.size[0]), int(frame.size[1]), frame.ts)
                )
                self.session._history_bytes += len(jpeg_bytes)
                while (
                    self.session._history_bytes > self.session._history_byte_limit
                    and len(self.session._frame_history) > 1
                ):
                    _, old_jpeg, _, _, _ = self.session._frame_history.popleft()
                    self.session._history_bytes -= len(old_jpeg)

        # 帧走独立 socket（原始字节）；没连上时退回 base64 塞在通知里（单测 / 通道失败）
        send_raw = self.session.frames is not None and self.session.frames.connected
        if send_raw:
            assert self.session.frames is not None
            self.session.frames.submit(self.session.device_id, jpeg_bytes)

        if self.session._stop.is_set():
            return
        engine = self.session.engine
        if snapshot is None or snapshot[0] is not engine or frame.ts - snapshot[2] > 0.5:
            detections = []
        detection_index = snapshot[1] if snapshot is not None and snapshot[0] is engine else None
        detection_ts = snapshot[2] if snapshot is not None and snapshot[0] is engine else None
        state = self.session._view_state
        valid_state = state is not None and state[0] is engine
        # FlowEngine 提供只读短快照：并行 child 列表可以替换，采集不能等待执行锁。
        # 不用上次 tick 的 _view_state 推导 active，否则慢并行动作期间会丢失分支高亮。
        current_node = engine.current
        try:
            active_ids = getattr(engine, "active_step_ids", None)
            active_steps = list(active_ids) if active_ids is not None else ([current_node] if current_node else [])
        except (AttributeError, RuntimeError):
            # 与结束/重载的瞬变相遇时退回本次读取的单节点，不中断采集。
            active_steps = [current_node] if current_node else []
        # Reconstruct frontend run state after reload/missed lifecycle events.
        # Only short state locking: capture must not wait for lifecycle/evidence I/O.
        with self.session.lock:
            running_roots = [
                runner.root for runner in self.session.runners.values() if self.session._runner_busy(runner)
            ]
            workflow_root = self.session._root_key(self.session.project.root)
            run_revision = self.session._run_revision
        payload = {
            "deviceId": self.session.device_id,
            "workflowRoot": workflow_root,
            "runningWorkflowRoots": running_roots,
            "runRevision": run_revision,
            "running": bool(running_roots),
            "index": frame.index,
            "ts": round(frame.ts, 3),
            "resolution": list(frame.size),
            "node": state[1] if valid_state and state is not None else current_node,
            "activeStepIds": active_steps,
            "pending": state[2] if valid_state and state is not None else None,
            "tick": state[3] if valid_state and state is not None else 0,
            "detectionIndex": detection_index,
            "detectionTs": detection_ts,
            "executionMs": round(self.session._execution_ms, 1),
            "executionDropped": self.session._execution_dropped,
            "fps": round(self.session.fps, 1),
            "captureMs": round(self.session.capture_ms, 1),
            "detections": detections,
            **({} if send_raw else {"jpeg": base64.b64encode(jpeg_bytes).decode("ascii")}),
        }
        self.session.emit("engine.frame", payload)
