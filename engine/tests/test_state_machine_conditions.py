"""状态机集成：判断条件（all_of / any_of / none_of / 限时等待）与基础操作真的被执行。"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import pytest

from gamepilot.core.conditions import Condition
from gamepilot.core.graph import Edge, Graph, Node
from gamepilot.core.state_machine import Engine
from test_state_machine import (
    BATTLE_BUTTON,
    MAIN_BUTTON,
    POPUP_BUTTON,
    ScriptedController,
    _canvas,
    _crop,
    _frame,
    _patterned,
)


class RecordingController(ScriptedController):
    """在 ScriptedController 上补记滑动 / 按键 / 文本 / 触控。"""

    def __init__(self) -> None:
        super().__init__()
        self.swipes: list[tuple[float, float, float, float, float]] = []
        self.keys: list[str] = []
        self.texts: list[str] = []
        self.touches: list[tuple[str, float, float]] = []

    def swipe(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        duration: float = 0.3,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        self.swipes.append((x1, y1, x2, y2, duration))

    def press(self, name: str) -> None:
        self.keys.append(name)

    def text(self, value: str) -> None:
        self.texts.append(value)

    def touch(self, phase: str, x: float, y: float) -> None:
        self.touches.append((phase, x, y))


@dataclass
class StubDetection:
    """只给条件求值用的假命中。"""

    score: float = 0.9
    state: str = "confirmed"


def build_graph(tmp_path: Path, *, edges: list[Edge], nodes: list[Node]) -> Graph:
    """两个模板（main_start / battle_settle），节点与边由调用方给。"""
    main = _canvas()
    _patterned(main, MAIN_BUTTON, 5, 60, 235)
    battle = _canvas()
    _patterned(battle, BATTLE_BUTTON, 3, 40, 210)
    popup = _canvas()
    _patterned(popup, POPUP_BUTTON, 2, 80, 250)

    graph = Graph.empty(str(tmp_path))
    for label, image, box in (
        ("main_start", main, MAIN_BUTTON),
        ("battle_settle", battle, BATTLE_BUTTON),
        ("popup_close", popup, POPUP_BUTTON),
    ):
        path = tmp_path / f"{label}.png"
        cv2.imwrite(str(path), image[box[1] : box[1] + box[3], box[0] : box[0] + box[2]])
        graph.add_recognizer(label, {"mode": "template", "template": str(path), "threshold": 0.7})
    for node in nodes:
        graph.upsert_node(node)
    for edge in edges:
        graph.add_edge(edge)
    graph.validate()
    return graph


def machine(tmp_path: Path, edges: list[Edge], nodes: list[Node]) -> tuple[Engine, RecordingController]:
    controller = RecordingController()
    controller.connect()
    graph = build_graph(tmp_path, edges=edges, nodes=nodes)
    return Engine(graph, controller, vote=1), controller


NODES = [Node(id="main", name="主界面", enter=["main_start"]), Node(id="battle", name="战斗", enter=["battle_settle"])]


def enter_node(engine: Engine, controller: RecordingController) -> None:
    """第一帧只做"我在哪"的定位；选边执行发生在下一帧（引擎的非阻塞设计）。"""
    engine.tick(_frame(controller.screenshot()))
    engine.tick(_frame(controller.screenshot()))


def test_any_of_edge_fires_on_either_label(tmp_path: Path) -> None:
    engine, controller = machine(
        tmp_path,
        edges=[
            Edge(
                id="e_any",
                when="main_start",
                src="main",
                dst="battle",
                condition=Condition(any_of=("main_start", "battle_settle")),
                action={"type": "click", "target": "main_start"},
            )
        ],
        nodes=NODES,
    )
    enter_node(engine, controller)

    assert engine.current in ("main", "battle")
    assert controller.clicks, "any_of 有一个命中就该执行动作"
    assert controller.screen == "battle"


def test_none_of_blocks_edge_while_popup_visible(tmp_path: Path) -> None:
    """弹窗还在时走不了这条边；弹窗关掉后才走（真实画面，不是假数据）。"""
    engine, controller = machine(
        tmp_path,
        edges=[
            Edge(
                id="e_wait_popup",
                when="main_start",
                src="main",
                dst="battle",
                condition=Condition(all_of=("main_start",), none_of=("popup_close",)),
                action={"type": "click", "target": "main_start"},
            )
        ],
        nodes=NODES,
    )
    controller.popup = True  # 画面上有弹窗
    engine.tick(_frame(controller.screenshot()))  # 1: 定位到 main
    engine.tick(_frame(controller.screenshot()))  # 2: 被 none_of 挡住
    assert not controller.clicks, "弹窗还在时不该点下去"

    controller.popup = False  # 弹窗关掉（recovery 边在真实脚本里负责关它）
    engine.tick(_frame(controller.screenshot()))  # 3: 条件成立
    assert controller.clicks, "弹窗消失后才该继续"


def test_within_ms_reports_timeout_once(tmp_path: Path) -> None:
    engine, controller = machine(
        tmp_path,
        edges=[
            Edge(
                id="e_never",
                when="battle_settle",  # 永远不出现（我们停在 main）
                src="main",
                dst="battle",
                condition=Condition(all_of=("battle_settle",), within_ms=120),
                action={"type": "click", "target": "main_start"},
            )
        ],
        nodes=NODES,
    )
    events: list[str] = []
    engine.on_event = lambda event: events.append(event.type)

    engine.tick(_frame(controller.screenshot()))  # 1: 进入 main（限时从这里开始计时）
    time.sleep(0.15)
    engine.tick(_frame(controller.screenshot()))  # 2: 已超时
    engine.tick(_frame(controller.screenshot()))  # 3: 只该报一次

    assert events.count("edge_timeout") == 1, f"超时只该报一次，实际: {events}"
    assert engine.current == "main"
    assert not controller.clicks, "条件没满足就不该执行动作"


def test_basic_actions_are_executed(tmp_path: Path) -> None:
    def edge(edge_id: str, action: dict[str, object], priority: int) -> Edge:
        return Edge(
            id=edge_id,
            when="main_start",
            src="main",
            dst=None,
            priority=priority,
            condition=Condition(all_of=("main_start",)),
            action=action,
        )

    engine, controller = machine(
        tmp_path,
        edges=[
            edge("e_swipe", {"type": "swipe", "x": 0.5, "y": 0.8, "to_x": 0.5, "to_y": 0.2, "duration_ms": 400}, 0),
            edge("e_press", {"type": "key", "value": "back"}, 1),
            edge("e_text", {"type": "text", "value": "hello"}, 2),
            edge("e_long", {"type": "long_press", "x": 0.05, "y": 0.05, "duration_ms": 120}, 3),
        ],
        nodes=[Node(id="main", name="主界面", enter=["main_start"])],
    )

    engine.tick(_frame(controller.screenshot()))  # 1: 定位
    for _ in range(4):  # 引擎一帧只走一条边，四条边要四帧
        engine.tick(_frame(controller.screenshot()))

    assert controller.swipes and controller.swipes[0][4] == pytest.approx(0.4), "滑动时长应来自 duration_ms"
    assert controller.keys == ["back"], "功能键应走 press（scrcpy 控制通道）"
    assert controller.texts == ["hello"]
    assert controller.clicks and abs(controller.clicks[0][0] - 0.05) < 0.02, "长按应落到指定坐标"


def test_wait_action_sleeps(tmp_path: Path) -> None:
    engine, controller = machine(
        tmp_path,
        edges=[
            Edge(
                id="e_wait",
                when="main_start",
                src="main",
                dst=None,
                condition=Condition(all_of=("main_start",)),
                action={"type": "wait", "seconds": 0.08},
            )
        ],
        nodes=[Node(id="main", name="主界面", enter=["main_start"])],
    )
    engine.tick(_frame(controller.screenshot()))  # 定位
    started = time.perf_counter()
    engine.tick(_frame(controller.screenshot()))  # 执行 wait
    assert time.perf_counter() - started >= 0.07, "wait 应该真的等"


def test_fired_edge_does_not_report_timeout_later(tmp_path: Path) -> None:
    """触发过的边，过了限时窗口也不该再报"等待超时"（真机跑脚本时踩到过）。"""
    engine, controller = machine(
        tmp_path,
        edges=[
            Edge(
                id="e_fire_once",
                when="main_start",
                src="main",
                dst=None,
                condition=Condition(all_of=("main_start",), within_ms=100),
                action={"type": "click", "target": "main_start"},
            )
        ],
        nodes=[Node(id="main", name="主界面", enter=["main_start"])],
    )
    events: list[str] = []
    engine.on_event = lambda event: events.append(event.type)

    engine.tick(_frame(controller.screenshot()))  # 1: 定位
    engine.tick(_frame(controller.screenshot()))  # 2: 条件成立 → 执行
    assert controller.clicks, "第二次 tick 应该已经点过了"

    time.sleep(0.15)  # 超过 100ms 限时窗口
    engine.tick(_frame(controller.screenshot()))
    engine.tick(_frame(controller.screenshot()))

    assert "edge_timeout" not in events, f"已经执行过的边不该再报超时: {events}"
    assert len(controller.clicks) == 1, "一次访问只点一次"


def test_variables_apply_at_runtime() -> None:
    """变量（黑板）：动作参数引用变量、赋值动作改变量、重置回默认值。"""
    controller = RecordingController()
    graph = Graph.from_dict(
        {
            "nodes": [{"id": "main", "name": "主界面", "enter": ["home"]}],
            "recognizers": {"home": {"type": "template", "template": "templates/home.png", "threshold": 0.7}},
            "defaults": {"click_jitter_px": 0, "click_micro_px": 0, "delay_jitter_ms": 0},
            "variables": {"点X": {"type": "number", "value": 0.25}, "次数": {"type": "number", "value": 0}},
            "edges": [
                {
                    "id": "e_click",
                    "when": "home",
                    "from": "main",
                    "action": {"type": "click", "x": {"$var": "点X"}, "y": 0.9},
                },
                {
                    "id": "e_count",
                    "when": "home",
                    "from": "main",
                    "priority": -1,
                    "action": {"type": "set", "name": "次数", "value": {"$expr": "次数 + 1"}},
                },
            ],
        },
        base_dir=".",
    )
    graph.validate()
    assert graph.variables["点X"].value == 0.25

    engine = Engine(graph, controller)
    engine.reset_variables()

    # 先执行一次点击边（不走 tick，避免脚本控制器的界面切换影响判断）
    engine._execute(graph.edges[0])
    assert controller.clicks and controller.clicks[0][0] == pytest.approx(0.25), (
        f"点击 X 应该来自变量，实际 {controller.clicks[:1]}"
    )

    # 赋值动作：次数 + 1
    engine._execute(graph.edges[1])
    assert float(engine.variables.get("次数") or 0) == pytest.approx(1.0)

    # 重置后回到默认值（每次 run.start 都会重置）
    engine.reset_variables()
    assert float(engine.variables.get("次数") or 0) == 0.0


def test_variable_reference_missing_at_runtime_is_reported() -> None:
    """运行期变量被删了也要给可读错误，而不是崩掉。"""
    controller = RecordingController()
    graph = Graph.from_dict(
        {
            "nodes": [{"id": "main", "name": "主界面", "enter": ["home"]}],
            "recognizers": {"home": {"type": "template", "template": "templates/home.png", "threshold": 0.7}},
            "variables": {"点X": {"type": "number", "value": 0.25}},
            "edges": [
                {
                    "id": "e_click",
                    "when": "home",
                    "from": "main",
                    "action": {"type": "click", "x": {"$var": "点X"}, "y": 0.9},
                }
            ],
        },
        base_dir=".",
    )
    engine = Engine(graph, controller)
    # 模拟"跑之前变量被删了/图换了"：运行期没有任何变量
    from gamepilot.core.variables import VariableStore

    engine.variables = VariableStore({})
    engine._execute(graph.edges[0])
    assert not controller.clicks, "引用不到的变量不该瞎点"
    assert engine.stats["failed"] >= 1


def test_breakpoint_pauses_then_resumes(tmp_path: Path) -> None:
    """断点：走到指定边时暂停（不执行动作），恢复后继续且不会卡在同一处。"""
    import os

    import cv2

    controller = RecordingController()
    frame_img = _canvas()
    _patterned(frame_img, MAIN_BUTTON, 4, 40, 220)
    os.makedirs(tmp_path / "templates", exist_ok=True)
    cv2.imwrite(str(tmp_path / "templates" / "home.png"), _crop(frame_img, MAIN_BUTTON))

    graph = Graph.from_dict(
        {
            "nodes": [{"id": "main", "name": "主界面", "enter": ["home"]}],
            "recognizers": {"home": {"type": "template", "template": "templates/home.png", "threshold": 0.7}},
            "edges": [
                {"id": "e_click", "when": "home", "from": "main", "action": {"type": "click", "x": 0.5, "y": 0.5}}
            ],
        },
        base_dir=str(tmp_path),
    )
    graph.validate()
    engine = Engine(graph, controller)
    engine.breakpoints.add("e_click")

    for index in range(1, 20):
        engine.tick(_frame(frame_img, index))
        if engine.paused:
            break
    assert engine.paused and engine.paused_at == "e_click", "断点应该命中"
    assert not controller.clicks, "断点命中时不该执行动作"

    engine.resume()
    for index in range(20, 34):
        engine.tick(_frame(frame_img, index))
        if controller.clicks:
            break
    assert not engine.paused, "恢复后不该又停在同一处"
    assert controller.clicks, "恢复后应该真的执行"


def test_step_runs_one_edge_then_pauses_before_the_next(tmp_path: Path) -> None:
    """单步：放行刚停住的那条边，执行完、在下一条边之前再停。"""
    controller = RecordingController()
    graph = Graph.from_dict(
        {
            "nodes": [{"id": "main", "name": "主界面"}],
            # when 留空 = 恒成立：两条边依次可执行，正好拿来数"走了几步"
            "edges": [
                {"id": "e_a", "when": "", "from": "main", "action": {"type": "click", "x": 0.2, "y": 0.2}},
                {"id": "e_b", "when": "", "from": "main", "action": {"type": "click", "x": 0.8, "y": 0.8}},
            ],
        },
        base_dir=str(tmp_path),
    )
    graph.validate()
    engine = Engine(graph, controller, start_node="main")
    engine.breakpoints.add("e_a")

    frame_img = _canvas()
    for index in range(1, 5):
        engine.tick(_frame(frame_img, index))
        if engine.paused:
            break
    assert engine.paused_at == "e_a"
    assert not controller.clicks, "断点命中时不该执行动作"

    engine.step()
    engine.tick(_frame(frame_img, 10))
    assert not engine.paused, "单步放行的那一条要先真的执行"
    assert len(controller.clicks) == 1, "单步只应该走一步"

    engine.tick(_frame(frame_img, 11))
    assert engine.paused_at == "e_b", "执行完这一步，下一条边之前再停"
    assert len(controller.clicks) == 1, "暂停时不该继续执行"


def test_score_data_source_resolves_live_score() -> None:
    """$score：把识别器当前得分当参数用（数据源）。"""
    from gamepilot.core.variables import VariableStore, resolve_spec

    resolved = resolve_spec(
        {"type": "click", "x": {"$score": "icon"}, "y": 0.5},
        VariableStore({}),
        {"icon": 0.937},
    )
    assert resolved["x"] == pytest.approx(0.937)
    # 没识别到就是 0（不是崩）
    assert resolve_spec({"x": {"$score": "nope"}}, VariableStore({}), {})["x"] == 0.0


def test_graph_validates_score_references() -> None:
    """$score 引用的识别器也必须在保存时校验。"""
    from gamepilot.core.graph import Edge, Graph

    graph = Graph()
    graph.add_edge(Edge.from_dict({"id": "e1", "action": {"type": "click", "x": {"$score": "没这个"}, "y": 0.5}}))
    with pytest.raises(ValueError, match="未定义的识别器"):
        graph.validate()
