"""InputService: extracted session responsibility; shared state belongs to DeviceSession."""

from __future__ import annotations

import contextlib
import time
from collections.abc import Iterator
from typing import TYPE_CHECKING, Any

from ..core.bezier_trajectory import ActionDeferredError
from ..core.flow_engine import FlowEngine

if TYPE_CHECKING:
    from .device import DeviceSession


class InputService:
    def __init__(self, session: DeviceSession) -> None:
        self.session = session

    @contextlib.contextmanager
    def _automatic_input(self) -> Iterator[None]:
        with self.session._input_lock:
            if self.session._manual_touch:
                raise ActionDeferredError("手动手势进行中，请稍后执行")
            yield

    def _automatic_engines(self) -> list[FlowEngine]:
        """Snapshot before taking the input lock (never invert session/input locks)."""
        with self.session.lock:
            engines = [runner.engine for runner in self.session.runners.values()]
            engines.append(self.session.engine)
        return list({id(engine): engine for engine in engines if isinstance(engine, FlowEngine)}.values())

    @contextlib.contextmanager
    def _manual_input(self) -> Iterator[None]:
        """Manual input takes over persistent pointers before sending its own input."""
        engines = self._automatic_engines()
        with self.session._input_lock:
            if self.session._manual_touch:
                raise ActionDeferredError("手动手势进行中，请稍后执行")
            self.session._manual_touch = True
            try:
                for engine in engines:
                    if engine.result == "running" and engine.uses_scheduled_touches:
                        engine.pause_execution()
                yield
            finally:
                self.session._manual_touch = False

    def run_action(self, action: dict[str, Any]) -> str:
        """手动单步与后台执行互斥，但永不阻塞 capture 的状态锁。"""
        with self.session._execution_lock:
            if self.session._stop.is_set():
                raise RuntimeError("会话已关闭")
            if any(
                engine.result == "running" and engine.uses_scheduled_touches for engine in self._automatic_engines()
            ):
                raise RuntimeError("多指流程运行中不能单独执行动作，请先停止流程")
            frame = self.session._latest_frame
            if frame is not None and not self.session.running:
                self.session.engine.perceive(frame)
            if isinstance(self.session.engine, FlowEngine):
                return self.session.engine.run_action(action)
            with self._manual_input():
                return self.session.engine.run_action(action)

    def touch(self, phase: str, x: float, y: float) -> None:
        """实时触控（画面栏拖动时逐事件转发）。

        move 不写事件（拖动一次会来上百个），只在 down/up 留痕。
        """
        if phase not in ("down", "move", "up"):
            # 在会话层统一校验：各控制器行为保持一致
            raise ValueError(f"phase 必须是 down/move/up，收到: {phase}")
        with self.session.lock:
            controller = self.session.controller
        engines = self._automatic_engines() if phase == "down" else []
        if phase == "down":
            # 标记先于抢输入锁；worker不会在整段手动手势的move之间插入自动触摸。
            self.session._manual_touch = True
        try:
            with self.session._input_lock:
                if self.session._stop.is_set():
                    self.session._manual_touch = False
                    return
                if phase == "down":
                    for engine in engines:
                        if engine.result == "running" and engine.uses_scheduled_touches:
                            engine.pause_execution()
                touch = getattr(controller, "touch", None)
                if callable(touch):
                    touch(phase, x, y)
                elif phase == "up":
                    controller.click(x, y)
                else:
                    return
        except BaseException:
            self.session._manual_touch = False
            raise
        finally:
            if phase == "up":
                self.session._manual_touch = False
        if phase == "down":
            self.session._touch_from = (x, y)
            self.session._input_seq += 1
            self.session.emit(
                "engine.event",
                {
                    "deviceId": self.session.device_id,
                    "seq": self.session._input_seq,
                    "ts": time.time(),
                    "type": "manual_input",
                    "node": self.session.engine.current,
                    "edge": None,
                    "message": f"手动触控 按下 ({x:.3f}, {y:.3f})",
                },
            )
        elif phase == "up":
            start = getattr(self.session, "_touch_from", None)
            detail = (
                f"({x:.3f}, {y:.3f})" if start is None else f"({start[0]:.3f}, {start[1]:.3f}) → ({x:.3f}, {y:.3f})"
            )
            self.session._input_seq += 1
            self.session.emit(
                "engine.event",
                {
                    "deviceId": self.session.device_id,
                    "seq": self.session._input_seq,
                    "ts": time.time(),
                    "type": "manual_input",
                    "node": self.session.engine.current,
                    "edge": None,
                    "message": f"手动触控 {detail}",
                },
            )

    def tap(self, x: float, y: float) -> None:
        """归一化坐标轻触。"""
        started = time.perf_counter()
        with self.session.lock:
            controller = self.session.controller
        with self._manual_input():
            if self.session._stop.is_set():
                return
            controller.click(x, y)
        self.session._emit_input("手动点击", f"({x:.3f}, {y:.3f})", started)

    def swipe(self, x1: float, y1: float, x2: float, y2: float, duration: float) -> None:
        """归一化坐标滑动。"""
        started = time.perf_counter()
        with self.session.lock:
            controller = self.session.controller
        with self._manual_input():
            if self.session._stop.is_set():
                return
            controller.swipe(x1, y1, x2, y2, duration=duration)
        self.session._emit_input(
            "手动滑动", f"({x1:.2f}, {y1:.2f}) → ({x2:.2f}, {y2:.2f}) {duration * 1000:.0f}ms", started
        )

    def press(self, name: str) -> None:
        """功能键（back/home/recents/power/volume_*）。"""
        started = time.perf_counter()
        with self.session.lock:
            controller = self.session.controller
        with self._manual_input():
            if self.session._stop.is_set():
                return
            if hasattr(controller, "press"):
                controller.press(name)
            else:
                controller.key(name)
        self.session._emit_input("手动按键", name, started)

    def _emit_input(self, title: str, detail: str, started: float) -> None:
        cost_ms = (time.perf_counter() - started) * 1000
        with self.session.lock:
            self.session._input_seq += 1
        self.session.emit(
            "engine.event",
            {
                "deviceId": self.session.device_id,
                "seq": self.session._input_seq,
                "ts": time.time(),
                "type": "manual_input",
                "node": self.session.engine.current,
                "edge": None,
                "message": f"{title} {detail}（{cost_ms:.1f}ms）",
            },
        )
