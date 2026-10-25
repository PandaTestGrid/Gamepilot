"""事件门闩回归：采集/投屏不等待流程，执行只消费最新帧。

不依赖 worker 的线程名、Condition 或槽位实现。截图由队列逐帧放行，
慢识别/设备输入由 Event 阻塞；超时仅用于让死锁变成明确的测试失败。
"""

from __future__ import annotations

import json
import queue
import threading
from pathlib import Path
from typing import Any

import pytest

from gamepilot.core.frame import Frame
from gamepilot.devices.synthetic_test import SyntheticController
from gamepilot.project import Project
from gamepilot.session import DeviceSession

_TIMEOUT = 5.0


class _Notifications:
    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.events: list[tuple[str, dict[str, Any]]] = []

    def emit(self, method: str, params: dict[str, Any]) -> None:
        with self.condition:
            self.events.append((method, dict(params)))
            self.condition.notify_all()

    def matching(self, method: str) -> list[dict[str, Any]]:
        with self.condition:
            return [params for name, params in self.events if name == method]

    def wait_frame(self, index: int) -> None:
        with self.condition:
            assert self.condition.wait_for(
                lambda: any(name == "engine.frame" and params["index"] >= index for name, params in self.events),
                timeout=_TIMEOUT,
            ), f"工作流阻塞时，第 {index} 帧仍应推送到界面"


class _CaptureGate:
    """每一个许可对应一次成功截图；没有许可时不产生下一帧。"""

    def __init__(self, controller: SyntheticController, monkeypatch: pytest.MonkeyPatch) -> None:
        self.permits: queue.Queue[bool] = queue.Queue()
        self.entered = threading.Event()
        self.condition = threading.Condition()
        self.requests = 0
        original = controller.screenshot

        def screenshot() -> Any:
            with self.condition:
                self.requests += 1
                self.entered.set()
                self.condition.notify_all()
            if not self.permits.get(timeout=_TIMEOUT * 2):
                raise RuntimeError("test capture closed")
            return original()

        monkeypatch.setattr(controller, "screenshot", screenshot)

    def frame(self) -> None:
        self.permits.put(True)

    def wait_request(self, count: int) -> None:
        with self.condition:
            assert self.condition.wait_for(lambda: self.requests >= count, timeout=_TIMEOUT)

    def unblock(self) -> None:
        self.permits.put(False)


def _session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, flow: bool = False
) -> tuple[DeviceSession, _CaptureGate, _Notifications]:
    controller = SyntheticController()
    controller.connect()
    project = Project(root=str(tmp_path)).ensure()
    if flow:
        Path(project.graph_path).write_text(
            json.dumps(
                {
                    "version": 1,
                    "defaults": {"evidence": False},
                    "nodes": [],
                    "edges": [],
                    "recognizers": {},
                    "flow": {
                        "steps": [
                            {"id": "trigger", "type": "manual", "params": {}},
                            {"id": "first", "type": "click", "params": {"by": "coord", "x": 0.2, "y": 0.3}},
                            {"id": "second", "type": "click", "params": {"by": "coord", "x": 0.4, "y": 0.5}},
                            {"id": "wait", "type": "delay", "params": {"ms": 600_000}},
                        ]
                    },
                }
            ),
            encoding="utf-8",
        )
    gate = _CaptureGate(controller, monkeypatch)
    notifications = _Notifications()
    session = DeviceSession("synthetic:scheduling", controller, project, notifications.emit, fps=30.0, jpeg_width=160)
    # 不测节流算法：每次显式放行的截图都应能够观察到推送。
    session.set_stream_fps(1000.0)
    return session, gate, notifications


def test_stop_signals_before_waiting_for_lifecycle_lock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    session, _gate, _notifications = _session(tmp_path, monkeypatch, flow=True)
    session.start_run()
    engine = session.engine
    stopped = threading.Event()

    def stop() -> None:
        session.stop_run()
        stopped.set()

    thread = threading.Thread(target=stop, daemon=True)
    try:
        with session._lifecycle_lock:
            thread.start()
            assert engine._stop_requested.wait(timeout=1), "停止不能先排队等待生命周期锁，必须先阻止下一次输入"
            assert not stopped.is_set()
        assert stopped.wait(timeout=_TIMEOUT)
    finally:
        thread.join(timeout=_TIMEOUT)
        session.stop()


def test_stop_disarms_pending_automatic_restart(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    session, _gate, _notifications = _session(tmp_path, monkeypatch, flow=True)
    session.start_run()
    session._auto_at = 0.0
    session.stop_run()
    assert session._auto_at is None
    session._maybe_auto_run()
    assert not session.runners
    session.stop()


def test_slow_perceive_keeps_streaming_and_next_perceive_uses_latest_frame(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch)
    entered = threading.Event()
    release = threading.Event()
    next_perceive = threading.Event()
    seen: list[int] = []
    active = 0
    peak_active = 0
    original = session.engine.perceive

    def slow_perceive(frame: Frame, *args: Any, **kwargs: Any) -> Any:
        nonlocal active, peak_active
        active += 1
        peak_active = max(peak_active, active)
        try:
            seen.append(frame.index)
            if len(seen) == 1:
                entered.set()
                assert release.wait(timeout=_TIMEOUT)
            else:
                next_perceive.set()
            return original(frame, *args, **kwargs)
        finally:
            active -= 1

    monkeypatch.setattr(session.engine, "perceive", slow_perceive)
    try:
        session.start()
        gate.frame()
        assert entered.wait(timeout=_TIMEOUT), "第一帧应进入识别"
        notifications.wait_frame(1)
        for index in range(2, 6):
            gate.frame()
            notifications.wait_frame(index)
        assert seen == [1], "识别不得并发进入同一个引擎"
        assert not release.is_set()
        # capture 已进入第六次截图，说明第五帧的整个采集拍（含投递）完成。
        gate.wait_request(6)
        # 此后不再提供截图；若 worker 排队而不是单槽覆盖，下一帧会是 2。
        release.set()
        assert next_perceive.wait(timeout=_TIMEOUT)
        assert seen == [1, 5], "慢识别返回后必须跳过积压帧，直接消费最新帧"
        assert peak_active == 1
    finally:
        release.set()
        gate.unblock()
        session.stop()


def test_slow_click_keeps_streaming_and_next_tick_uses_latest_frame(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch, flow=True)
    entered = threading.Event()
    release = threading.Event()
    next_click = threading.Event()
    seen: list[int] = []
    calls = 0
    original = session.engine.perceive

    def observe_perceive(frame: Frame, *args: Any, **kwargs: Any) -> Any:
        seen.append(frame.index)
        return original(frame, *args, **kwargs)

    def slow_click(*_args: Any, **_kwargs: Any) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            entered.set()
            assert release.wait(timeout=_TIMEOUT)
        else:
            next_click.set()

    monkeypatch.setattr(session.engine, "perceive", observe_perceive)
    # 模拟仅有阻塞 click 的设备通道；支持 touch 的通道优先走可取消触控。
    monkeypatch.setattr(session.controller, "touch", None)
    monkeypatch.setattr(session.controller, "click", slow_click)
    try:
        session.start_run()
        session.start()
        gate.frame()
        assert entered.wait(timeout=_TIMEOUT), "流程应进入第一条设备输入"
        notifications.wait_frame(1)
        for index in range(2, 6):
            gate.frame()
            notifications.wait_frame(index)
        assert calls == 1, "设备动作必须串行执行"
        gate.wait_request(6)
        release.set()
        assert next_click.wait(timeout=_TIMEOUT)
        assert seen == [1, 5], "慢动作返回后不能在旧帧上执行下一条动作"
        assert calls == 2
    finally:
        release.set()
        gate.unblock()
        session.stop()


def test_stop_and_immediate_restart_do_not_reuse_or_remove_inflight_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch, flow=True)
    entered = [threading.Event(), threading.Event()]
    release = [threading.Event(), threading.Event()]
    stop_returned = threading.Event()
    calls = 0
    stopping: threading.Thread | None = None

    def slow_click(*_args: Any, **_kwargs: Any) -> None:
        nonlocal calls
        call = calls
        calls += 1
        if call < 2:
            entered[call].set()
            assert release[call].wait(timeout=_TIMEOUT)

    def stop_run() -> None:
        session.stop_run()
        stop_returned.set()

    # 模拟仅有阻塞 click 的设备通道；支持 touch 的通道优先走可取消触控。
    monkeypatch.setattr(session.controller, "touch", None)
    monkeypatch.setattr(session.controller, "click", slow_click)
    try:
        session.start_run()
        old_engine = session.engine
        session.start()
        gate.frame()
        assert entered[0].wait(timeout=_TIMEOUT)
        stopping = threading.Thread(target=stop_run, daemon=True)
        stopping.start()
        assert stop_returned.wait(timeout=_TIMEOUT), "停止 RPC 不得等待设备输入返回"
        assert not release[0].is_set()
        assert not session.running
        assert [event["result"] for event in notifications.matching("run.stopped")] == ["cancelled"]

        session.start_run()
        new_engine = session.engine
        assert new_engine is not old_engine, "旧 tick 尚未退出，不能重置并复用旧引擎"
        assert session.running
        gate.frame()
        notifications.wait_frame(2)
        release[0].set()
        assert entered[1].wait(timeout=_TIMEOUT), "旧 tick 退出后，新运行应继续执行"
        assert old_engine.result == "cancelled"
        assert session.engine is new_engine
        assert session.running, "旧 tick 的迟到完成不得移除同 root 的新 runner"
        assert new_engine.result == "running"
        assert len(notifications.matching("run.started")) == 2
        assert len(notifications.matching("run.stopped")) == 1, "旧完成不得给新运行再发一次停止通知"
        assert calls == 2, "已停止的旧引擎不得继续发送第二条输入"

        session.stop_run()
        assert not session.running
        assert len(notifications.matching("run.stopped")) == 2
    finally:
        for event in release:
            event.set()
        if stopping is not None:
            stopping.join(timeout=_TIMEOUT)
        gate.unblock()
        session.stop()


def test_disconnect_drops_successful_screenshot_that_returns_after_stop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch)
    stop_returned = threading.Event()

    def stop() -> None:
        session.stop()
        stop_returned.set()

    stopping: threading.Thread | None = None
    try:
        session.start()
        assert gate.entered.wait(timeout=_TIMEOUT)
        stopping = threading.Thread(target=stop, daemon=True)
        stopping.start()
        # 已存在的会话取消 Event 是唯一观察点；不依赖新 worker 的私有结构。
        assert session._stop.wait(timeout=_TIMEOUT)
        gate.frame()
        assert stop_returned.wait(timeout=_TIMEOUT)
        assert notifications.matching("engine.frame") == []
        assert notifications.matching("device.recovered") == []
        assert notifications.matching("device.failed") == []
        assert session.index == 0
    finally:
        gate.unblock()
        if stopping is not None:
            stopping.join(timeout=_TIMEOUT)
        session.stop()


def test_slow_recording_does_not_block_streaming_or_execution(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch)
    entered = threading.Event()
    release = threading.Event()
    next_recording = threading.Event()
    perceived_latest = threading.Event()
    recorded: list[int] = []
    original_perceive = session.engine.perceive

    def slow_recording(frame: Frame, **_kwargs: Any) -> None:
        recorded.append(frame.index)
        if len(recorded) == 1:
            entered.set()
            assert release.wait(timeout=_TIMEOUT)
        else:
            next_recording.set()

    def perceive(frame: Frame, *args: Any, **kwargs: Any) -> Any:
        result = original_perceive(frame, *args, **kwargs)
        if frame.index == 5:
            perceived_latest.set()
        return result

    monkeypatch.setattr(session, "_record_frame", slow_recording)
    monkeypatch.setattr(session.engine, "perceive", perceive)
    try:
        session.start_recording()
        session.start()
        gate.frame()
        assert entered.wait(timeout=_TIMEOUT)
        notifications.wait_frame(1)
        for index in range(2, 6):
            gate.frame()
            notifications.wait_frame(index)
        gate.wait_request(6)
        assert perceived_latest.wait(timeout=_TIMEOUT), "录屏磁盘阻塞不得阻塞执行 worker"
        assert recorded == [1]
        release.set()
        assert next_recording.wait(timeout=_TIMEOUT)
        assert recorded == [1, 5], "录屏也应丢弃积压帧，避免慢磁盘无限排队"
    finally:
        release.set()
        gate.unblock()
        session.stop()


def test_perceive_exception_does_not_stop_capture_or_execution_worker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch)
    failed = threading.Event()
    recovered = threading.Event()
    seen: list[int] = []
    original = session.engine.perceive

    def flaky_perceive(frame: Frame, *args: Any, **kwargs: Any) -> Any:
        seen.append(frame.index)
        if len(seen) == 1:
            failed.set()
            raise RuntimeError("synthetic recognizer failure")
        result = original(frame, *args, **kwargs)
        recovered.set()
        return result

    monkeypatch.setattr(session.engine, "perceive", flaky_perceive)
    try:
        session.start()
        gate.frame()
        assert failed.wait(timeout=_TIMEOUT)
        notifications.wait_frame(1)
        gate.frame()
        notifications.wait_frame(2)
        assert recovered.wait(timeout=_TIMEOUT), "识别异常不得杀死执行 worker"
        for index in range(3, 6):
            gate.frame()
            notifications.wait_frame(index)
        assert seen[:2] == [1, 2]
        assert notifications.matching("device.failed") == [], "识别失败不是设备截图失败"
    finally:
        gate.unblock()
        session.stop()


def test_slow_run_action_does_not_block_streaming(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch)
    entered = threading.Event()
    release = threading.Event()
    returned = threading.Event()
    errors: list[Exception] = []
    action_thread: threading.Thread | None = None

    def slow_click(*_args: Any, **_kwargs: Any) -> None:
        entered.set()
        assert release.wait(timeout=_TIMEOUT)

    def run_action() -> None:
        try:
            session.run_action({"type": "click", "x": 0.2, "y": 0.3})
        except Exception as error:
            errors.append(error)
        finally:
            returned.set()

    monkeypatch.setattr(session.controller, "touch", None)
    monkeypatch.setattr(session.controller, "click", slow_click)
    try:
        session.start()
        gate.frame()
        notifications.wait_frame(1)
        action_thread = threading.Thread(target=run_action, daemon=True)
        action_thread.start()
        assert entered.wait(timeout=_TIMEOUT)
        for index in range(2, 6):
            gate.frame()
            notifications.wait_frame(index)
        assert not returned.is_set(), "动作仍被门闩阻塞，投屏已经连续交付新帧"
        release.set()
        assert returned.wait(timeout=_TIMEOUT)
        assert errors == []
    finally:
        release.set()
        if action_thread is not None:
            action_thread.join(timeout=_TIMEOUT)
        gate.unblock()
        session.stop()


def test_stop_long_touch_releases_finger_while_streaming_continues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch, flow=True)
    graph = session.graph.to_dict()
    graph["flow"]["steps"][1] = {
        "id": "first",
        "type": "hold",
        "params": {"by": "coord", "x": 0.2, "y": 0.3, "duration_ms": 600_000},
    }
    session.save_graph(graph)
    pressed = threading.Event()
    released = threading.Event()
    phases: list[str] = []
    original_touch = session.controller.touch

    def touch(phase: str, x: float, y: float) -> None:
        # 默认拟人轨迹可含 move，只记录按下/抬起的生命周期。
        if phase != "move":
            phases.append(phase)
        original_touch(phase, x, y)
        if phase == "down":
            pressed.set()
        elif phase == "up":
            released.set()

    monkeypatch.setattr(session.controller, "touch", touch)
    try:
        session.start_run()
        session.start()
        gate.frame()
        assert pressed.wait(timeout=_TIMEOUT)
        for index in range(1, 6):
            if index > 1:
                gate.frame()
            notifications.wait_frame(index)
        assert phases == ["down"], "长按尚未结束时投屏也应连续交付新帧"
        session.stop_run()
        assert released.wait(timeout=_TIMEOUT), "协作停止必须中断长按等待并 finally 抬手"
        assert phases == ["down", "up"]
        assert not session.running
        gate.frame()
        notifications.wait_frame(6)
        assert phases == ["down", "up"], "停止后不得发送后续流程输入"
    finally:
        gate.unblock()
        session.stop()


def test_manual_tap_returns_while_running_flow_perceive_is_blocked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch, flow=True)
    entered = threading.Event()
    release = threading.Event()
    tapped = threading.Event()
    returned = threading.Event()
    errors: list[Exception] = []
    tap_thread: threading.Thread | None = None
    original = session.engine.perceive

    def slow_perceive(frame: Frame, *args: Any, **kwargs: Any) -> Any:
        entered.set()
        assert release.wait(timeout=_TIMEOUT)
        return original(frame, *args, **kwargs)

    def click(*_args: Any, **_kwargs: Any) -> None:
        tapped.set()

    def tap() -> None:
        try:
            session.tap(0.8, 0.9)
        except Exception as error:
            errors.append(error)
        finally:
            returned.set()

    monkeypatch.setattr(session.engine, "perceive", slow_perceive)
    monkeypatch.setattr(session.controller, "click", click)
    try:
        session.start_run()
        session.start()
        gate.frame()
        assert entered.wait(timeout=_TIMEOUT)
        tap_thread = threading.Thread(target=tap, daemon=True)
        tap_thread.start()
        assert returned.wait(timeout=_TIMEOUT), "手动点击不得等待流程的慢识别"
        assert tapped.is_set()
        assert not release.is_set()
        assert errors == []
        gate.frame()
        notifications.wait_frame(2)
    finally:
        release.set()
        if tap_thread is not None:
            tap_thread.join(timeout=_TIMEOUT)
        gate.unblock()
        session.stop()


def test_manual_down_failure_rolls_back_and_automatic_touch_can_continue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch, flow=True)
    automatic_down = threading.Event()
    automatic_up = threading.Event()
    fail_once = True
    original = session.controller.touch

    def touch(phase: str, x: float, y: float) -> None:
        nonlocal fail_once
        if fail_once and phase == "down":
            fail_once = False
            raise RuntimeError("synthetic manual down failure")
        original(phase, x, y)
        if phase == "down":
            automatic_down.set()
        elif phase == "up":
            automatic_up.set()

    monkeypatch.setattr(session.controller, "touch", touch)
    try:
        with pytest.raises(RuntimeError, match="manual down failure"):
            session.touch("down", 0.8, 0.9)
        # 不读取 _manual_touch：真正执行下一条流程输入，验证失败没有遗留占用。
        session.start_run()
        session.start()
        gate.frame()
        notifications.wait_frame(1)
        assert automatic_down.wait(timeout=_TIMEOUT), "手动按下失败后必须恢复自动输入"
        assert automatic_up.wait(timeout=_TIMEOUT)
        assert session.running
    finally:
        gate.unblock()
        session.stop()


def test_manual_touch_owns_gesture_until_up_then_automatic_flow_resumes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch, flow=True)
    frame_five_perceived = threading.Event()
    automatic_down = threading.Event()
    touches: list[tuple[str, float, float]] = []
    original_touch = session.controller.touch
    original_perceive = session.engine.perceive

    def touch(phase: str, x: float, y: float) -> None:
        touches.append((phase, x, y))
        original_touch(phase, x, y)
        if phase == "down" and (x, y) != (0.8, 0.9):
            automatic_down.set()

    def perceive(frame: Frame, *args: Any, **kwargs: Any) -> Any:
        result = original_perceive(frame, *args, **kwargs)
        if frame.index == 5:
            frame_five_perceived.set()
        return result

    monkeypatch.setattr(session.controller, "touch", touch)
    monkeypatch.setattr(session.engine, "perceive", perceive)
    try:
        session.touch("down", 0.8, 0.9)
        session.start_run()
        session.start()
        for index in range(1, 6):
            gate.frame()
            notifications.wait_frame(index)
        assert frame_five_perceived.wait(timeout=_TIMEOUT)
        assert touches == [("down", 0.8, 0.9)], "手动手势未抬起，自动流程不得插入输入"
        assert session.running
        session.touch("up", 0.8, 0.9)
        assert touches == [("down", 0.8, 0.9), ("up", 0.8, 0.9)]
        gate.frame()
        notifications.wait_frame(6)
        assert automatic_down.wait(timeout=_TIMEOUT), "手动抬手后自动流程应恢复"
    finally:
        gate.unblock()
        session.stop()


def test_stop_waits_for_in_progress_start_and_leaves_no_ghost_runner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch, flow=True)
    attaching = threading.Event()
    release = threading.Event()
    stop_called = threading.Event()
    stop_returned = threading.Event()
    errors: list[Exception] = []
    original = session._attach_evidence

    def attach(runner: Any) -> None:
        attaching.set()
        assert release.wait(timeout=_TIMEOUT)
        original(runner)

    def start() -> None:
        try:
            session.start_run()
        except Exception as error:
            errors.append(error)

    def stop() -> None:
        stop_called.set()
        try:
            session.stop_run()
        except Exception as error:
            errors.append(error)
        finally:
            stop_returned.set()

    monkeypatch.setattr(session, "_attach_evidence", attach)
    starting = threading.Thread(target=start, daemon=True)
    stopping = threading.Thread(target=stop, daemon=True)
    try:
        starting.start()
        assert attaching.wait(timeout=_TIMEOUT)
        stopping.start()
        assert stop_called.wait(timeout=_TIMEOUT)
        # 有界等待只检查互斥：stop 不得穿过尚未完成的 start，绝非性能阈值。
        assert not stop_returned.wait(timeout=0.1)
        release.set()
        starting.join(timeout=_TIMEOUT)
        stopping.join(timeout=_TIMEOUT)
        assert not starting.is_alive()
        assert not stopping.is_alive()
        assert errors == []
        assert not session.running
        assert session.runners == {}, "start/stop 交错不得留下未登记的幽灵运行"
        assert len(notifications.matching("run.started")) == 1
        assert [item["result"] for item in notifications.matching("run.stopped")] == ["cancelled"]
    finally:
        release.set()
        if starting.ident is not None:
            starting.join(timeout=_TIMEOUT)
        if stopping.ident is not None:
            stopping.join(timeout=_TIMEOUT)
        gate.unblock()
        session.stop()


def test_concurrent_starts_accept_exactly_one_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch, flow=True)
    attaching = threading.Event()
    release = threading.Event()
    second_called = threading.Event()
    second_returned = threading.Event()
    outcomes: list[str | Exception] = []
    original = session._attach_evidence
    attach_calls = 0

    def attach(runner: Any) -> None:
        nonlocal attach_calls
        attach_calls += 1
        if attach_calls == 1:
            attaching.set()
            assert release.wait(timeout=_TIMEOUT)
        original(runner)

    def start(*, second: bool = False) -> None:
        if second:
            second_called.set()
        try:
            session.start_run()
            outcomes.append("accepted")
        except Exception as error:
            outcomes.append(error)
        finally:
            if second:
                second_returned.set()

    monkeypatch.setattr(session, "_attach_evidence", attach)
    first = threading.Thread(target=start, daemon=True)
    second = threading.Thread(target=lambda: start(second=True), daemon=True)
    try:
        first.start()
        assert attaching.wait(timeout=_TIMEOUT)
        second.start()
        assert second_called.wait(timeout=_TIMEOUT)
        assert not second_returned.wait(timeout=0.1)
        release.set()
        first.join(timeout=_TIMEOUT)
        second.join(timeout=_TIMEOUT)
        assert not first.is_alive()
        assert not second.is_alive()
        assert outcomes.count("accepted") == 1
        rejected = [outcome for outcome in outcomes if isinstance(outcome, Exception)]
        assert len(rejected) == 1
        assert isinstance(rejected[0], RuntimeError)
        assert "已在运行" in str(rejected[0])
        assert attach_calls == 1, "重复开跑不得覆盖首个运行的证据"
        assert len(session.runners) == 1
        assert session.running
        assert len(notifications.matching("run.started")) == 1
    finally:
        release.set()
        if first.ident is not None:
            first.join(timeout=_TIMEOUT)
        if second.ident is not None:
            second.join(timeout=_TIMEOUT)
        gate.unblock()
        session.stop()


def test_start_rejects_successful_engine_until_its_inflight_tick_returns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch, flow=True)
    graph = session.graph.to_dict()
    graph["flow"] = {"steps": [{"id": "trigger", "type": "manual", "params": {}}]}
    session.save_graph(graph)
    engine = session.engine
    finished_inside_tick = threading.Event()
    release = threading.Event()
    original = engine.tick

    def delayed_tick(frame: Frame) -> Any:
        result = original(frame)
        assert engine.result == "success"
        finished_inside_tick.set()
        assert release.wait(timeout=_TIMEOUT)
        return result

    monkeypatch.setattr(engine, "tick", delayed_tick)
    try:
        session.start_run()
        session.start()
        gate.frame()
        assert finished_inside_tick.wait(timeout=_TIMEOUT)
        assert engine.result == "success"
        with pytest.raises(RuntimeError, match="已在运行"):
            session.start_run()
        assert session.engine is engine, "tick 未退出，不得重置或复用其引擎"
        assert engine.result == "success"
        assert len(notifications.matching("run.started")) == 1
    finally:
        release.set()
        gate.unblock()
        session.stop()


def test_recording_restart_does_not_commit_old_inflight_or_pending_frames(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch)
    entered = threading.Event()
    release = threading.Event()
    old_pending_returned = threading.Event()
    new_frame_returned = threading.Event()
    original = session._record_frame
    jobs: list[tuple[int, str | None]] = []

    def record(frame: Frame, *, recording_id: str | None = None) -> None:
        jobs.append((frame.index, recording_id))
        if frame.index == 1:
            entered.set()
            assert release.wait(timeout=_TIMEOUT)
        original(frame, recording_id=recording_id)
        if frame.index == 2:
            old_pending_returned.set()
        elif frame.index == 3:
            new_frame_returned.set()

    monkeypatch.setattr(session, "_record_frame", record)
    try:
        first_id = session.start_recording()["recordingId"]
        session.start()
        gate.frame()
        assert entered.wait(timeout=_TIMEOUT)
        gate.frame()
        notifications.wait_frame(2)
        gate.wait_request(3)
        session.stop_recording(first_id)
        second_id = session.start_recording()["recordingId"]
        assert second_id != first_id
        release.set()
        assert old_pending_returned.wait(timeout=_TIMEOUT)
        assert jobs == [(1, first_id), (2, first_id)], "录屏任务必须携带采集时的 generation"
        assert session.recording_meta(second_id)["indices"] == [], "旧录屏任务不得污染新录屏"
        gate.frame()
        notifications.wait_frame(3)
        assert new_frame_returned.wait(timeout=_TIMEOUT)
        assert session.recording_meta(second_id)["indices"] == [3]
    finally:
        release.set()
        gate.unblock()
        session.stop()


def test_natural_completion_finishes_old_evidence_before_restart_is_accepted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch, flow=True)
    graph = session.graph.to_dict()
    graph["flow"] = {"steps": [{"id": "trigger", "type": "manual", "params": {}}]}
    session.save_graph(graph)
    old_engine = session.engine
    collecting = threading.Event()
    release = threading.Event()
    restart_called = threading.Event()
    restart_returned = threading.Event()
    errors: list[Exception] = []
    collected: list[Any] = []
    original = session._collect_evidence

    def collect(root: str, engine: Any) -> None:
        if engine is old_engine:
            collecting.set()
            assert release.wait(timeout=_TIMEOUT)
        original(root, engine)
        collected.append(engine)

    def restart() -> None:
        restart_called.set()
        try:
            session.start_run()
        except Exception as error:
            errors.append(error)
        finally:
            restart_returned.set()

    monkeypatch.setattr(session, "_collect_evidence", collect)
    restarting = threading.Thread(target=restart, daemon=True)
    try:
        session.start_run()
        session.start()
        gate.frame()
        assert collecting.wait(timeout=_TIMEOUT)
        assert old_engine.result == "success"
        restarting.start()
        assert restart_called.wait(timeout=_TIMEOUT)
        assert not restart_returned.wait(timeout=0.1), "自然完成的证据收尾也是生命周期操作，重启必须等待"
        assert notifications.matching("run.stopped") == []
        release.set()
        assert restart_returned.wait(timeout=_TIMEOUT)
        restarting.join(timeout=_TIMEOUT)
        assert errors == []
        assert collected == [old_engine]
        assert session.engine is not old_engine, "新运行不得复用已经完成的引擎"
        assert old_engine.result == "success"
        assert session.engine.result == "running"
        assert session.running
        assert len(session.runners) == 1
        with notifications.condition:
            lifecycle = [method for method, _ in notifications.events if method in ("run.started", "run.stopped")]
        assert lifecycle == ["run.started", "run.stopped", "run.started"], "旧收尾通知不得迟到覆盖新运行状态"
        assert notifications.matching("run.stopped")[0]["result"] == "success"
    finally:
        release.set()
        if restarting.ident is not None:
            restarting.join(timeout=_TIMEOUT)
        gate.unblock()
        session.stop()


def test_unhandled_capture_error_marks_failed_and_wakes_all_session_workers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch)
    emit_calls = 0

    def broken_emit(_frame: Frame, _detections: list[dict[str, Any]], **_kwargs: Any) -> None:
        nonlocal emit_calls
        emit_calls += 1
        raise RuntimeError("synthetic frame transport failure")

    monkeypatch.setattr(session, "_emit_frame", broken_emit)
    try:
        session.start()
        gate.frame()
        with notifications.condition:
            assert notifications.condition.wait_for(
                lambda: any(method == "device.failed" for method, _ in notifications.events), timeout=_TIMEOUT
            )
        assert session._stop.wait(timeout=_TIMEOUT)
        # 健康状态包括线程退出；join 不代替 stop，以验证 wrapper 自己唤醒空闲 worker。
        for thread in (session._thread, session._worker, session._recorder):
            assert thread is not None
            thread.join(timeout=_TIMEOUT)
            assert not thread.is_alive(), "采集意外退出必须唤醒并终止其余会话线程"
        assert not session.started
        assert emit_calls == 1
        failed = notifications.matching("device.failed")
        assert len(failed) == 1
        assert "synthetic frame transport failure" in failed[0]["error"]
        assert session.capture_error is not None
        assert notifications.matching("engine.frame") == [], "采集失败后不得再有迟到推帧"
        assert notifications.matching("device.recovered") == []
    finally:
        gate.unblock()
        session.stop()


def test_stale_completion_does_not_rearm_automatic_run_after_stop_wins_lifecycle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session, gate, notifications = _session(tmp_path, monkeypatch, flow=True)
    graph = session.graph.to_dict()
    graph["flow"] = {"steps": [{"id": "trigger", "type": "interval", "params": {"every": 30}}]}
    session.save_graph(graph)
    session.start_run()
    runner = next(iter(session.runners.values()))
    assert session._auto_at is not None
    gate.frame()
    frame = Frame(image=session.controller.screenshot(), size=session.controller.resolution, index=1)
    completion_waiting = threading.Event()
    release_completion = threading.Event()
    execution_returned = threading.Event()
    stop_returned = threading.Event()
    errors: list[Exception] = []
    original_lock = session._lifecycle_lock

    class LifecycleGate:
        def __enter__(self) -> Any:
            # 首次进入正好位于 tick finally 的 retired=False 快照之后。
            # 不占底层锁，故 stop 线程可以抢先完成真正的生命周期操作。
            if threading.current_thread() is executing and not completion_waiting.is_set():
                completion_waiting.set()
                assert release_completion.wait(timeout=_TIMEOUT)
            return original_lock.__enter__()

        def __exit__(self, *args: Any) -> Any:
            return original_lock.__exit__(*args)

    def execute() -> None:
        try:
            session._execute_frame(frame)
        except Exception as error:
            errors.append(error)
        finally:
            execution_returned.set()

    def stop() -> None:
        try:
            session.stop_run()
        except Exception as error:
            errors.append(error)
        finally:
            stop_returned.set()

    executing = threading.Thread(target=execute, daemon=True)
    stopping = threading.Thread(target=stop, daemon=True)
    monkeypatch.setattr(session, "_lifecycle_lock", LifecycleGate())
    try:
        executing.start()
        assert completion_waiting.wait(timeout=_TIMEOUT)
        assert runner.engine.result == "success"
        assert not runner.inflight
        assert not runner.cancelled
        assert next(iter(session.runners.values())) is runner
        stopping.start()
        assert stop_returned.wait(timeout=_TIMEOUT), "旧 completion 等门闩时 stop 必须能先完成"
        assert session._auto_at is None
        assert session.runners == {}
        assert not session.running
        release_completion.set()
        assert execution_returned.wait(timeout=_TIMEOUT)
        executing.join(timeout=_TIMEOUT)
        stopping.join(timeout=_TIMEOUT)
        assert errors == []
        assert session._auto_at is None, "旧完成快照已失效，不能重新排期用户明确停止的工作流"
        assert session.runners == {}
        assert not session.running
        assert len(notifications.matching("run.started")) == 1
        assert [event["result"] for event in notifications.matching("run.stopped")] == ["cancelled"]
    finally:
        release_completion.set()
        if executing.ident is not None:
            executing.join(timeout=_TIMEOUT)
        if stopping.ident is not None:
            stopping.join(timeout=_TIMEOUT)
        gate.unblock()
        session.stop()
