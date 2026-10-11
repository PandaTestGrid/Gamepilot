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


def test_positioned_action_keeps_its_coordinates() -> None:
    """有坐标的动作不该被塞兜底 target：否则"点这里"会被执行成"点识别器中心"。"""
    action = Action.parse({"type": "click", "x": 0.5, "y": 0.8}, fallback_target="home")
    assert action.target is None
    assert (action.x, action.y) == (0.5, 0.8)

    # 完全没给位置时才兜底到识别器
    fallback = Action.parse({"type": "click"}, fallback_target="home")
    assert fallback.target == "home"

    # 给了 rect 也不该兜底
    rect = Action.parse({"type": "click", "rect": [0.1, 0.2, 0.3, 0.4]}, fallback_target="home")
    assert rect.target is None and rect.rect is not None


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


# ---------------------------------------------------------------- 边的序列化


def test_edge_round_trip_keeps_always_condition() -> None:
    """always 条件必须写进文件：丢了它再读回来会变成"叫 always 的识别器标签"。"""
    from gamepilot.core.graph import Edge

    edge = Edge.from_dict(
        {
            "id": "e_rec_1",
            "when": "always",
            "from": "main",
            "cooldown_ms": 600,
            "condition": {"always": True},
            "action": {"type": "click", "x": 0.5, "y": 0.8, "duration_ms": 300},
        }
    )
    assert edge.condition.always

    payload = edge.to_dict()
    assert payload["condition"] == {"always": True}, payload

    again = Edge.from_dict(payload)
    assert again.condition.always, "往返后仍应是无条件"
    assert again.condition.labels == (), "不该多出一个假的识别器标签"
    assert again.action_fallback_target is None, "无条件边的动作不能用 when 兜底目标"


def test_edge_round_trip_keeps_multi_label_condition() -> None:
    from gamepilot.core.graph import Edge

    edge = Edge.from_dict(
        {
            "id": "e1",
            "when": "home",
            "condition": {
                "all_of": ["home"],
                "any_of": ["a"],
                "none_of": ["popup"],
                "min_score": 0.8,
                "within_ms": 3000,
            },
            "action": {"type": "wait", "seconds": 1},
        }
    )
    again = Edge.from_dict(edge.to_dict())
    assert again.condition.any_of == ("a",)
    assert again.condition.none_of == ("popup",)
    assert again.condition.within_ms == 3000
    assert again.condition.min_score == pytest.approx(0.8)


def test_default_condition_is_omitted_from_file() -> None:
    from gamepilot.core.graph import Edge

    edge = Edge.from_dict({"id": "e1", "when": "home", "action": {"type": "click", "target": "home"}})
    payload = edge.to_dict()
    assert "condition" not in payload, "默认条件（就是 when）不用写进文件，保持 graph.json 干净"


# ---------------------------------------------------------------- 变量（黑板）


def test_parse_variables_accepts_shorthand_and_types() -> None:
    from gamepilot.core.variables import parse_variables

    parsed = parse_variables(
        {
            "点击X": 0.5,  # 简写 = number
            "目标模板": {"type": "key", "value": "icon"},
            "坏类型": {"type": "unknown", "value": 1},  # 不认识 → 按 number
            "": 1,  # 空名字丢掉
        }
    )
    assert parsed["点击X"].value == 0.5
    assert parsed["点击X"].type == "number"
    assert parsed["目标模板"].value == "icon"
    assert parsed["坏类型"].type == "number"
    assert "" not in parsed


def test_resolve_spec_replaces_var_and_expr() -> None:
    from gamepilot.core.variables import Variable, VariableStore, resolve_spec

    store = VariableStore({"点击X": Variable("点击X", "number", 0.5), "次数": Variable("次数", "number", 2)})
    resolved = resolve_spec(
        {"type": "click", "x": {"$var": "点击X"}, "y": 0.8, "duration_ms": {"$expr": "次数 * 100"}},
        store,
    )
    assert resolved["x"] == 0.5
    assert resolved["y"] == 0.8
    assert resolved["duration_ms"] == 200.0


def test_resolve_spec_rejects_unknown_variable() -> None:
    from gamepilot.core.variables import VariableStore, resolve_spec

    with pytest.raises(ValueError, match="变量未定义"):
        resolve_spec({"type": "click", "x": {"$var": "不存在"}}, VariableStore({}))


def test_variable_store_set_keeps_type_and_resets() -> None:
    from gamepilot.core.variables import Variable, VariableStore

    store = VariableStore({"次数": Variable("次数", "number", 0)})
    store.set("次数", "3")  # 数字变量收到字符串 → 转成数字
    assert store.get("次数") == 3.0
    store.set("次数", "不是数字")  # 转不了就忽略，不炸
    assert store.get("次数") == 3.0
    store.reset()
    assert store.get("次数") == 0  # 重置回默认值
    store.set("新变量", 7)  # 没定义过的变量直接新增
    assert store.get("新变量") == 7


def test_expression_rejects_dangerous_input() -> None:
    from gamepilot.core.variables import VariableStore, evaluate_expr

    # 危险表达式必须被挡住（要么字符集不允许，要么求值时报未定义）
    with pytest.raises(ValueError):
        evaluate_expr("__import__('os').system('ls')", VariableStore({}))
    with pytest.raises(ValueError, match="不支持的字符"):
        evaluate_expr("a; import os", VariableStore({}))


def test_graph_validates_variable_references() -> None:
    """引用未定义变量要在保存时报错（和识别器标签一个待遇）。"""
    from gamepilot.core.graph import Edge, Graph

    graph = Graph()
    graph.add_edge(Edge.from_dict({"id": "e1", "action": {"type": "click", "x": {"$var": "没定义"}, "y": 0.8}}))
    with pytest.raises(ValueError, match="未定义的变量"):
        graph.validate()

    graph.edges[0].action["x"] = {"$var": "点击X"}
    graph.variables = {
        "点击X": __import__("gamepilot.core.variables", fromlist=["Variable"]).Variable("点击X", "number", 0.5)
    }
    graph.validate()  # 定义过就通过了


def test_graph_validates_set_action_target() -> None:
    from gamepilot.core.graph import Edge, Graph

    graph = Graph()
    graph.add_edge(
        Edge.from_dict({"id": "e1", "action": {"type": "set", "name": "次数", "value": {"$expr": "次数 + 1"}}})
    )
    with pytest.raises(ValueError, match="未定义的变量"):
        graph.validate()
