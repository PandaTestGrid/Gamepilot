"""判断条件与基础操作：解析、校验、求值语义。"""

from __future__ import annotations

import pytest

from gamepilot.core.actions import ACTION_TYPES, Action
from gamepilot.core.conditions import Condition, ConditionTimer


class FakeDetection:
    def __init__(self, score: float = 0.9, state: str = "confirmed") -> None:
        self.score = score
        self.state = state


def detections(**items: FakeDetection) -> dict[str, FakeDetection]:
    return dict(items)


# ---------------------------------------------------------------- 条件


def test_condition_defaults_to_when_label() -> None:
    condition = Condition.parse(None, fallback="main")
    assert condition.all_of == ("main",)
    assert condition.describe() == "main"


def test_condition_parses_all_forms() -> None:
    condition = Condition.parse(
        {"all_of": "home", "any_of": ["a", "b"], "none_of": "popup", "min_score": 0.8, "within_ms": 5000}
    )
    assert condition.all_of == ("home",)
    assert condition.any_of == ("a", "b")
    assert condition.none_of == ("popup",)
    assert condition.min_score == pytest.approx(0.8)
    assert condition.within_ms == 5000
    assert set(condition.labels) == {"home", "a", "b", "popup"}
    assert "限时 5000ms" in condition.describe()

    # 字符串写法 = all_of
    assert Condition.parse("battle").all_of == ("battle",)


def test_condition_rejects_broken_spec() -> None:
    with pytest.raises(ValueError):
        Condition.parse({"min_score": "高"})
    with pytest.raises(ValueError):
        Condition.parse({"all_of": 123})
    with pytest.raises(ValueError):
        Condition.parse({"min_score": 0.5})  # 一个标签都没有


def test_all_of_needs_every_label() -> None:
    condition = Condition.parse({"all_of": ["a", "b"]})
    assert condition.matches(detections(a=FakeDetection(), b=FakeDetection()))
    assert not condition.matches(detections(a=FakeDetection()))


def test_any_of_needs_one_label() -> None:
    condition = Condition.parse({"any_of": ["a", "b"]})
    assert condition.matches(detections(b=FakeDetection()))
    assert not condition.matches(detections(c=FakeDetection()))


def test_none_of_blocks_and_can_stand_alone() -> None:
    blocked = Condition.parse({"all_of": ["a"], "none_of": ["popup"]})
    assert not blocked.matches(detections(a=FakeDetection(), popup=FakeDetection()))
    assert blocked.matches(detections(a=FakeDetection()))

    # 只有 none_of：没出现就算成立（"没有弹窗就一直走"）
    only_not = Condition.parse({"none_of": ["popup"]})
    assert only_not.matches(detections())
    assert not only_not.matches(detections(popup=FakeDetection()))


def test_min_score_and_confirmed_requirement() -> None:
    condition = Condition.parse({"all_of": ["a"], "min_score": 0.9})
    assert condition.matches(detections(a=FakeDetection(score=0.95)))
    assert not condition.matches(detections(a=FakeDetection(score=0.5)))
    # 没投票确认的（pending）不算命中
    assert not condition.matches(detections(a=FakeDetection(score=0.99, state="pending")))
    assert condition.matches(detections(a=FakeDetection(score=0.99, state="pending")), require_confirmed=False)


def test_condition_timer_wait_then_timeout() -> None:
    timer = ConditionTimer()
    timer.arm("home", 100.0)

    # 限时 1 秒：窗口内是 wait，超过 1 秒是 timeout
    assert timer.check("home", "e1", 1000, 100.0) == "wait"
    assert timer.check("home", "e1", 1000, 100.5) == "wait"
    assert timer.check("home", "e1", 1000, 101.1) == "timeout"
    assert "home:e1" in timer.timed_out

    # 重新进入节点：计时清零（超时记录也清掉）
    timer.arm("home", 200.0)
    assert timer.check("home", "e1", 1000, 200.2) == "wait"

    # within_ms=0 表示不限时
    assert timer.check("home", "e2", 0, 999.0) == "ok"


# ---------------------------------------------------------------- 动作


def test_action_types_cover_basic_operations() -> None:
    assert set(ACTION_TYPES) == {"click", "long_press", "swipe", "wait", "key", "text"}


def test_click_forms() -> None:
    assert Action.parse({"type": "click", "target": "start"}).describe() == "点击 start"
    assert Action.parse({"type": "click", "rect": [0.1, 0.2, 0.3, 0.4]}).describe() == "点击 矩形中心"
    assert Action.parse({"type": "click", "x": 0.5, "y": 0.5}).describe() == "点击 (0.50, 0.50)"
    # 老写法：只有 type，目标从 when 兜底
    assert Action.parse({"type": "click"}, fallback_target="home").target == "home"


def test_click_without_position_is_rejected() -> None:
    with pytest.raises(ValueError, match="点击位置"):
        Action.parse({"type": "click"})


def test_long_press_and_swipe() -> None:
    press = Action.parse({"type": "long_press", "target": "icon", "duration_ms": 1200})
    assert press.duration_ms == 1200
    assert "长按 icon" in press.describe()

    swipe = Action.parse({"type": "swipe", "x": 0.5, "y": 0.8, "to_x": 0.5, "to_y": 0.2, "duration_ms": 400})
    assert swipe.to_y == pytest.approx(0.2)
    assert "滑动" in swipe.describe() and "400ms" in swipe.describe()

    with pytest.raises(ValueError, match="终点"):
        Action.parse({"type": "swipe", "x": 0.5, "y": 0.8})


def test_wait_key_text_validation() -> None:
    assert Action.parse({"type": "wait", "seconds": 2}).describe() == "等待 2s"
    with pytest.raises(ValueError, match="seconds"):
        Action.parse({"type": "wait", "seconds": 0})

    assert Action.parse({"type": "key", "value": "back"}).describe() == "按键 back"
    with pytest.raises(ValueError, match=r"key\.value"):
        Action.parse({"type": "key", "value": "回车"})

    assert Action.parse({"type": "text", "value": "hello"}).describe() == "输入「hello」"
    with pytest.raises(ValueError, match="不能为空"):
        Action.parse({"type": "text"})


def test_unknown_action_type_lists_supported() -> None:
    with pytest.raises(ValueError, match="未支持的动作类型"):
        Action.parse({"type": "jump"})


def test_action_round_trip() -> None:
    original = {"type": "swipe", "target": "from", "to_target": "to", "duration_ms": 250}
    parsed = Action.parse(original)
    assert Action.parse(parsed.to_dict()).to_dict() == parsed.to_dict()
