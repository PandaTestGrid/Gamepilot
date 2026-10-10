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

    def swipe(self, x1: float, y1: float, x2: float, y2: float, duration: float = 0.3) -> None:
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
            edge("e_long", {"type": "long_press", "target": "main_start", "duration_ms": 120}, 3),
        ],
        nodes=[Node(id="main", name="主界面", enter=["main_start"])],
    )

    engine.tick(_frame(controller.screenshot()))  # 1: 定位
    for _ in range(4):  # 引擎一帧只走一条边，四条边要四帧
        engine.tick(_frame(controller.screenshot()))

    assert controller.swipes and controller.swipes[0][4] == pytest.approx(0.4), "滑动时长应来自 duration_ms"
    assert controller.keys == ["back"], "功能键应走 press（scrcpy 控制通道）"
    assert controller.texts == ["hello"]
    assert [phase for phase, _, _ in controller.touches] == ["down", "up"], "长按应按下-抬起"


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
