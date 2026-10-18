"""连续滑动（ADR 0002）：轨迹归一化、按弧长分配时序、末端保持、摇杆降级。"""

from __future__ import annotations

import time

import pytest

from gamepilot.core.actions import Action
from gamepilot.core.bezier_trajectory import (
    execute_drag,
    execute_swipe,
    normalize_path,
    play_swipe_path,
)


class TouchRecorder:
    """只有实时触控通道的控制器（scrcpy / HID / CGEvent 那一路）。"""

    def __init__(self) -> None:
        self.events: list[tuple[str, float, float]] = []

    def touch(self, phase: str, x: float, y: float) -> None:
        self.events.append((phase, x, y))


class SwipeOnlyController:
    """没有 touch 的合成通道（adb 兜底那一路）。"""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def swipe(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        duration: float = 0.3,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        self.calls.append({"from": (x1, y1), "to": (x2, y2), "duration": duration, "path": path})


@pytest.fixture
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    recorded: list[float] = []
    monkeypatch.setattr(time, "sleep", lambda seconds: recorded.append(seconds))
    return recorded


# ------------------------------------------------------------------ 轨迹归一化


def test_normalize_path_accepts_lists_and_dicts() -> None:
    assert normalize_path([[0.1, 0.2], [0.3, 0.4]]) == [(0.1, 0.2), (0.3, 0.4)]
    assert normalize_path([{"x": 0.1, "y": 0.2}, {"x": 0.3, "y": 0.4}]) == [(0.1, 0.2), (0.3, 0.4)]


def test_normalize_path_clamps_and_drops_duplicates() -> None:
    assert normalize_path([[-1.0, 2.0], [-1.0, 2.0], [0.5, 0.5]]) == [(0.0, 1.0), (0.5, 0.5)]


@pytest.mark.parametrize(
    "raw",
    [
        None,
        [],
        [[0.1, 0.2]],
        [[0.1, 0.2], [0.3, 0.4], [0.3, 0.4]],  # 去重后只剩两个 → 仍合法，见下
        [[0.1, 0.2], ["a", "b"]],
        [[0.1, 0.2], [True, False]],
        {"x": 0.1, "y": 0.2},
    ],
)
def test_normalize_path_rejects_bad_input(raw: object) -> None:
    if raw == [[0.1, 0.2], [0.3, 0.4], [0.3, 0.4]]:
        assert normalize_path(raw) is not None
        return
    assert normalize_path(raw) is None


# ------------------------------------------------------------------ 动作解析


def test_swipe_action_derives_endpoints_from_path() -> None:
    action = Action.parse({"type": "swipe", "path": [[0.2, 0.8], [0.4, 0.8], [0.6, 0.7]], "hold_ms": 1500})
    assert action.x == pytest.approx(0.2)
    assert action.y == pytest.approx(0.8)
    assert action.to_x == pytest.approx(0.6)
    assert action.to_y == pytest.approx(0.7)
    assert action.hold_ms == 1500
    assert action.path is not None and len(action.path) == 3
    assert "连续滑动 3 点" in action.describe()
    assert "按住 1500ms" in action.describe()


def test_swipe_action_keeps_explicit_endpoints() -> None:
    action = Action.parse(
        {"type": "swipe", "x": 0.1, "y": 0.1, "to_x": 0.9, "to_y": 0.9, "path": [[0.2, 0.2], [0.8, 0.8]]}
    )
    assert action.x == pytest.approx(0.1)
    assert action.y == pytest.approx(0.1)
    assert action.to_x == pytest.approx(0.9)
    assert action.to_y == pytest.approx(0.9)


def test_swipe_action_roundtrips_path() -> None:
    spec = {"type": "swipe", "path": [[0.1, 0.2], [0.3, 0.4]], "duration_ms": 800, "hold_ms": 300}
    dumped = Action.parse(spec).to_dict()
    assert dumped["path"] == [[0.1, 0.2], [0.3, 0.4]]
    assert dumped["hold_ms"] == 300
    assert Action.parse(dumped).path == ((0.1, 0.2), (0.3, 0.4))


def test_swipe_action_bad_path_still_needs_terminal() -> None:
    # 坏 path 不抛，但不能因此丢掉"必须有终点"的校验
    with pytest.raises(ValueError, match="需要终点"):
        Action.parse({"type": "swipe", "x": 0.1, "y": 0.1, "path": [[0.1, 0.1]]})


def test_swipe_action_rejects_negative_hold() -> None:
    with pytest.raises(ValueError, match="hold_ms"):
        Action.parse({"type": "swipe", "x": 0.1, "y": 0.1, "to_x": 0.2, "to_y": 0.2, "hold_ms": -1})


# ------------------------------------------------------------------ 时序


def test_play_swipe_path_paces_by_arc_length(sleeps: list[float]) -> None:
    controller = TouchRecorder()
    # 第一段 0.1、第二段 0.9：均分的话两段都会是 0.5
    play_swipe_path(controller.touch, [(0.0, 0.0), (0.1, 0.0), (0.1, 0.9)], 1.0)
    assert [event[0] for event in controller.events] == ["down", "move", "move", "up"]
    assert sleeps[0] == pytest.approx(0.1, abs=1e-6)
    assert sleeps[1] == pytest.approx(0.9, abs=1e-6)


def test_play_swipe_path_holds_before_release(sleeps: list[float]) -> None:
    controller = TouchRecorder()
    play_swipe_path(controller.touch, [(0.15, 0.8), (0.25, 0.8)], 0.2, hold=2.0)
    assert controller.events[0] == ("down", 0.15, 0.8)
    assert controller.events[-1] == ("up", 0.25, 0.8)
    assert sum(sleeps) == pytest.approx(2.2, abs=1e-6)


def test_play_swipe_path_downsamples_dense_paths(sleeps: list[float]) -> None:
    controller = TouchRecorder()
    points = [(index / 400, 0.5) for index in range(401)]
    play_swipe_path(controller.touch, points, 0.2)
    # 每段至少 2ms → 0.2s 只能容纳 100 段左右，不能把 400 段全发出去
    assert len(controller.events) - 2 <= 110
    assert controller.events[0][0] == "down" and controller.events[-1][0] == "up"


# ------------------------------------------------------------------ 下发


def test_execute_drag_uses_realtime_touch(sleeps: list[float]) -> None:
    controller = TouchRecorder()
    execute_drag(controller, [(0.2, 0.8), (0.4, 0.8)], 0.1, 500)
    assert [event[0] for event in controller.events] == ["down", "move", "up"]
    assert sleeps[-1] == pytest.approx(0.5, abs=1e-6)


def test_execute_drag_folds_hold_into_synthetic_swipe() -> None:
    controller = SwipeOnlyController()
    execute_drag(controller, [(0.2, 0.8), (0.4, 0.8)], 0.2, 500)
    assert len(controller.calls) == 1
    call = controller.calls[0]
    assert call["duration"] == pytest.approx(0.7)
    assert call["path"] == [(0.2, 0.8), (0.4, 0.8)]


def test_execute_drag_rejects_single_point() -> None:
    with pytest.raises(ValueError, match="两个"):
        execute_drag(TouchRecorder(), [(0.2, 0.8)], 0.1)


def test_execute_swipe_routes_explicit_path_through_drag(sleeps: list[float]) -> None:
    controller = TouchRecorder()
    execute_swipe(
        controller,
        (0.1, 0.1),
        (0.9, 0.9),
        0.2,
        {"bezier": True},
        {},
        path=[[0.1, 0.1], [0.5, 0.2], [0.9, 0.9]],
        hold_ms=0,
    )
    assert [event[0] for event in controller.events] == ["down", "move", "move", "up"]


def test_execute_swipe_without_path_keeps_legacy_call() -> None:
    controller = SwipeOnlyController()
    execute_swipe(controller, (0.1, 0.1), (0.9, 0.9), 0.2, {"bezier": False}, {})
    assert len(controller.calls) == 1
    assert controller.calls[0]["path"] is None
