"""拟人贝塞尔滑动：轨迹生成、参数覆盖、设备下发。"""

from __future__ import annotations

import math
import random
import threading

import pytest

from gamepilot.core.bezier_trajectory import (
    DEFAULT_CLICK_HUMAN,
    DEFAULT_SWIPE_BEZIER,
    ActionCancelledError,
    SwipeBezierConfig,
    execute_swipe,
    execute_tap,
    generate_swipe_track,
    generate_tap_track,
    play_swipe_path,
    play_tap,
    resolve_click_human,
    resolve_swipe_bezier,
)


class RecordingSwipe:
    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []

    def swipe(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        duration: float = 0.3,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        self.calls.append((round(x1, 3), round(y1, 3), round(x2, 3), round(y2, 3), round(duration, 3), path))


def test_resolve_reads_global_only() -> None:
    """拟人参数只有全局一处：节点上写同名字段不生效（老 graph.json 也一样）。"""
    global_cfg = resolve_swipe_bezier({}, {"swipe_bezier": True, "swipe_bezier_order": 5, "swipe_easing": 1})
    assert global_cfg.enabled is True
    assert global_cfg.order == 5
    assert global_cfg.easing == "ease_in"

    off = resolve_swipe_bezier({"bezier": True}, {"swipe_bezier": False, "swipe_bezier_order": 5})
    assert off.enabled is False, "节点不能强制打开"
    assert off.order == 5

    custom = resolve_swipe_bezier(
        {"bezier": False, "bezier_order": 2, "bezier_easing": "ease_out", "bezier_deviation_px": 12},
        {"swipe_bezier": True, "swipe_bezier_order": 8, "swipe_easing": "linear"},
    )
    assert custom.enabled is True
    assert custom.order == 8
    assert custom.easing == "linear"
    assert custom.deviation_px != 12


def test_default_config_matches_human_like_preset() -> None:
    cfg = resolve_swipe_bezier({}, {})
    assert cfg == DEFAULT_SWIPE_BEZIER
    assert cfg.enabled is True
    assert cfg.easing == "ease_in_out"


def test_vertical_swipe_does_not_nan_and_keeps_ends() -> None:
    random.seed(7)
    track = generate_swipe_track(
        (0.5, 0.8),
        (0.5, 0.2),
        duration=0.3,
        config=SwipeBezierConfig(order=4, deviation_px=10, easing="ease_in_out"),
    )
    assert len(track) >= 8
    assert track[0][0] == 0.5 and track[0][1] == 0.8
    assert track[-1][0] == 0.5 and track[-1][1] == 0.2
    assert all(math.isfinite(x) and math.isfinite(y) for x, y in track)
    assert all(0.0 <= x <= 1.0 and 0.0 <= y <= 1.0 for x, y in track)


def test_ease_in_spends_more_samples_near_start() -> None:
    track = generate_swipe_track(
        (0.0, 0.5),
        (1.0, 0.5),
        duration=0.32,
        config=SwipeBezierConfig(order=1, deviation_px=0, easing="ease_in", end_wobble=0),
    )
    mid = track[len(track) // 2]
    assert mid[0] < 0.4


def test_straight_line_stays_on_segment_when_no_deviation() -> None:
    track = generate_swipe_track(
        (0.2, 0.2),
        (0.8, 0.8),
        duration=0.2,
        config=SwipeBezierConfig(order=1, deviation_px=0, easing="linear", end_wobble=0),
    )
    for x, y in track:
        assert y == pytest.approx(x)


def test_end_wobble_adds_extra_points_then_returns() -> None:
    random.seed(3)
    base = generate_swipe_track(
        (0.2, 0.5),
        (0.8, 0.5),
        duration=0.3,
        config=SwipeBezierConfig(order=1, deviation_px=0, easing="linear", end_wobble=0),
    )
    wobble = generate_swipe_track(
        (0.2, 0.5),
        (0.8, 0.5),
        duration=0.3,
        config=SwipeBezierConfig(order=1, deviation_px=0, easing="linear", end_wobble=2, end_wobble_px=20),
    )
    assert len(wobble) > len(base)
    assert wobble[-1] == (0.8, 0.5)


def test_execute_swipe_passes_path_when_enabled() -> None:
    random.seed(1)
    controller = RecordingSwipe()
    execute_swipe(controller, (0.1, 0.2), (0.9, 0.8), 0.2, {"bezier": True}, {})
    assert len(controller.calls) == 1
    x1, y1, x2, y2, duration, path = controller.calls[0]
    assert (x1, y1, x2, y2) == (0.1, 0.2, 0.9, 0.8)
    assert duration == 0.2
    assert path is not None and len(path) >= 8
    assert path[0] == (0.1, 0.2)
    assert path[-1] == (0.9, 0.8)


def test_execute_swipe_skips_path_when_disabled() -> None:
    controller = RecordingSwipe()
    execute_swipe(controller, (0.1, 0.2), (0.9, 0.8), 0.2, {}, {"swipe_bezier": False})
    assert controller.calls[0][-1] is None


class RecordingClick:
    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []

    def click(
        self,
        x: float,
        y: float,
        duration: float = 0.05,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        self.calls.append((round(x, 3), round(y, 3), round(duration, 3), None if not path else len(path)))


def test_tap_track_stays_near_landing_and_returns() -> None:
    random.seed(11)
    track = generate_tap_track((0.4, 0.6), duration=0.08, micro_px=4)
    assert track[0] == pytest.approx((0.4, 0.6))
    assert track[-1] == pytest.approx((0.4, 0.6))
    assert len(track) >= 4
    assert all(abs(x - 0.4) < 0.02 and abs(y - 0.6) < 0.02 for x, y in track)


def test_execute_tap_uses_duration_and_micro_path() -> None:
    random.seed(2)
    controller = RecordingClick()
    execute_tap(
        controller,
        (0.5, 0.5),
        {},
        {"tap_duration_ms": 80, "click_jitter_px": 0, "click_micro_px": 3, "delay_jitter_ms": 0},
    )
    assert len(controller.calls) == 1
    x, y, duration, count = controller.calls[0]
    assert (x, y) == (0.5, 0.5)
    assert duration == pytest.approx(0.08)
    assert isinstance(count, int) and count >= 4


def test_resolve_click_human_defaults_and_global_only() -> None:
    assert resolve_click_human({}, {}) == DEFAULT_CLICK_HUMAN
    # 节点上写的三个拟人字段被忽略，只有全局生效
    cfg = resolve_click_human({"tap_duration_ms": 90, "click_micro_px": 0}, {"click_jitter_px": 8})
    assert cfg.duration_ms == DEFAULT_CLICK_HUMAN.duration_ms
    assert cfg.micro_px == DEFAULT_CLICK_HUMAN.micro_px
    assert cfg.jitter_px == 8


class RecordingTouch(RecordingClick, RecordingSwipe):
    def touch(self, phase: str, x: float, y: float) -> None:
        self.calls.append((phase, x, y))


@pytest.mark.parametrize("action", ["tap", "swipe"])
def test_no_cancel_signal_keeps_synthetic_dispatch(action: str) -> None:
    controller = RecordingTouch()
    defaults = {"click_jitter_px": 0, "click_micro_px": 0, "delay_jitter_ms": 0}
    if action == "tap":
        execute_tap(controller, (0.4, 0.6), defaults=defaults)
        assert controller.calls == [(0.4, 0.6, 0.05, None)]
    else:
        execute_swipe(controller, (0.2, 0.3), (0.7, 0.8), 0.2, defaults={"swipe_bezier": False})
        assert controller.calls == [(0.2, 0.3, 0.7, 0.8, 0.2, None)]


@pytest.mark.parametrize("action", ["tap", "swipe", "drag"])
def test_pre_cancelled_action_sends_no_input(action: str) -> None:
    controller = RecordingTouch()
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(ActionCancelledError):
        if action == "tap":
            execute_tap(controller, (0.4, 0.6), cancel_event=cancel)
        else:
            execute_swipe(
                controller,
                (0.2, 0.3),
                (0.7, 0.8),
                0.2,
                path=[[0.2, 0.3], [0.7, 0.8]] if action == "drag" else None,
                cancel_event=cancel,
            )
    assert controller.calls == []


@pytest.mark.parametrize("micro_px", [0, 2])
def test_cancelled_tap_uses_touch_and_releases_without_second_click(micro_px: int) -> None:
    cancel = threading.Event()

    class CancelTouch(RecordingTouch):
        def touch(self, phase: str, x: float, y: float) -> None:
            super().touch(phase, x, y)
            if phase == "down":
                cancel.set()

    controller = CancelTouch()
    with pytest.raises(ActionCancelledError):
        execute_tap(
            controller,
            (0.4, 0.6),
            defaults={"click_jitter_px": 0, "click_micro_px": micro_px, "delay_jitter_ms": 0},
            duration_ms=10000,
            count=2,
            cancel_event=cancel,
        )
    assert controller.calls == [("down", 0.4, 0.6), ("up", 0.4, 0.6)]


def test_swipe_cancelled_during_move_releases_at_last_position() -> None:
    cancel = threading.Event()
    calls: list[tuple[str, float, float]] = []

    def touch(phase: str, x: float, y: float) -> None:
        calls.append((phase, x, y))
        if phase == "move":
            cancel.set()

    with pytest.raises(ActionCancelledError):
        play_swipe_path(touch, [(0.1, 0.2), (0.3, 0.4), (0.7, 0.8)], 10, hold=10, cancel_event=cancel)
    assert calls == [("down", 0.1, 0.2), ("move", 0.3, 0.4), ("up", 0.3, 0.4)]


@pytest.mark.parametrize("action", ["tap", "single_point", "swipe"])
def test_touch_error_still_releases(action: str) -> None:
    phases: list[str] = []

    def touch(phase: str, _x: float, _y: float) -> None:
        phases.append(phase)
        if phase == ("move" if action == "swipe" else "down"):
            raise RuntimeError("touch failed")

    with pytest.raises(RuntimeError, match="touch failed"):
        if action == "tap":
            play_tap(touch, (0.1, 0.2), 0.1)
        else:
            points = [(0.1, 0.2)] if action == "single_point" else [(0.1, 0.2), (0.3, 0.4)]
            play_swipe_path(touch, points, 0.1)
    assert phases[-1] == "up"


def test_swipe_endpoint_hold_can_be_cancelled(monkeypatch: pytest.MonkeyPatch) -> None:
    cancel = threading.Event()
    waits: list[float | None] = []
    calls: list[tuple[str, float, float]] = []

    def wait(timeout: float | None = None) -> bool:
        waits.append(timeout)
        if timeout == 10:
            cancel.set()
            return True
        return False

    monkeypatch.setattr(cancel, "wait", wait)
    with pytest.raises(ActionCancelledError):
        play_swipe_path(
            lambda phase, x, y: calls.append((phase, x, y)),
            [(0.1, 0.2), (0.3, 0.4)],
            0.1,
            hold=10,
            cancel_event=cancel,
        )
    assert waits == [pytest.approx(0.1), 10]
    assert calls == [("down", 0.1, 0.2), ("move", 0.3, 0.4), ("up", 0.3, 0.4)]


def test_double_click_gap_can_be_cancelled(monkeypatch: pytest.MonkeyPatch) -> None:
    cancel = threading.Event()
    controller = RecordingClick()

    def stop_wait(_timeout: float | None = None) -> bool:
        cancel.set()
        return True

    monkeypatch.setattr(cancel, "wait", stop_wait)
    with pytest.raises(ActionCancelledError):
        execute_tap(controller, (0.4, 0.6), count=2, cancel_event=cancel)
    assert len(controller.calls) == 1


@pytest.mark.parametrize("action", ["tap", "swipe"])
def test_cancel_after_legacy_signature_error_never_retries(action: str) -> None:
    cancel = threading.Event()
    calls: list[str] = []

    class LegacyController:
        def click(self, *_args: object, **_kwargs: object) -> None:
            calls.append("click")
            cancel.set()
            raise TypeError("legacy signature")

        def swipe(self, *_args: object, **_kwargs: object) -> None:
            calls.append("swipe")
            cancel.set()
            raise TypeError("legacy signature")

    with pytest.raises(ActionCancelledError):
        if action == "tap":
            execute_tap(LegacyController(), (0.4, 0.6), cancel_event=cancel)
        else:
            execute_swipe(LegacyController(), (0.2, 0.3), (0.7, 0.8), 0.2, cancel_event=cancel)
    assert calls == [action if action == "swipe" else "click"]
