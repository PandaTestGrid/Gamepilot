"""拟人贝塞尔滑动：轨迹生成、参数覆盖、设备下发。"""

from __future__ import annotations

import math
import random

import pytest

from gamepilot.core.bezier_trajectory import (
    DEFAULT_CLICK_HUMAN,
    DEFAULT_SWIPE_BEZIER,
    SwipeBezierConfig,
    execute_swipe,
    execute_tap,
    generate_swipe_track,
    generate_tap_track,
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


def test_resolve_follows_global_then_step_override() -> None:
    global_cfg = resolve_swipe_bezier({}, {"swipe_bezier": True, "swipe_bezier_order": 5, "swipe_easing": 1})
    assert global_cfg.enabled is True
    assert global_cfg.order == 5
    assert global_cfg.easing == "ease_in"

    off = resolve_swipe_bezier({"bezier": False}, {"swipe_bezier": True, "swipe_bezier_order": 5})
    assert off.enabled is False
    assert off.order == 5

    custom = resolve_swipe_bezier(
        {"bezier": True, "bezier_order": 2, "bezier_easing": "ease_out", "bezier_deviation_px": 12},
        {"swipe_bezier": False, "swipe_bezier_order": 8},
    )
    assert custom.enabled is True
    assert custom.order == 2
    assert custom.easing == "ease_out"
    assert custom.deviation_px == 12


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
    execute_swipe(controller, (0.1, 0.2), (0.9, 0.8), 0.2, {"bezier": False}, {"swipe_bezier": True})
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
        {"tap_duration_ms": 80, "click_jitter_px": 0, "click_micro_px": 3, "delay_jitter_ms": 0},
        {},
    )
    assert len(controller.calls) == 1
    x, y, duration, count = controller.calls[0]
    assert (x, y) == (0.5, 0.5)
    assert duration == pytest.approx(0.08)
    assert isinstance(count, int) and count >= 4


def test_resolve_click_human_defaults_and_override() -> None:
    assert resolve_click_human({}, {}) == DEFAULT_CLICK_HUMAN
    cfg = resolve_click_human({"tap_duration_ms": 90, "click_micro_px": 0}, {"click_jitter_px": 8})
    assert cfg.duration_ms == 90
    assert cfg.micro_px == 0
    assert cfg.jitter_px == 8
