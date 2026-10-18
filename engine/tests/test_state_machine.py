"""状态机语义测试：用合成的两块"界面"验证迁移、动作、recovery 优先级。

不碰真机、不碰 stdio —— 只测 DESIGN.md §7 写下的运行语义。
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from gamepilot.core.frame import Frame
from gamepilot.core.graph import Edge, Graph, Node
from gamepilot.core.state_machine import Engine
from gamepilot.devices.base import Controller, Size

W, H = 400, 200
MAIN_BUTTON = (40, 60, 80, 30)  # x, y, w, h（像素）
BATTLE_BUTTON = (260, 60, 80, 30)
POPUP_BUTTON = (160, 140, 80, 30)


def _canvas() -> np.ndarray:
    return np.full((H, W, 3), 24, dtype=np.uint8)


def _rect(image: np.ndarray, box: tuple[int, int, int, int], color: tuple[int, int, int]) -> None:
    x, y, w, h = box
    image[y : y + h, x : x + w] = color


def _crop(image: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    x, y, w, h = box
    return image[y : y + h, x : x + w]


def _patterned(image: np.ndarray, box: tuple[int, int, int, int], cell: int, dark: int, light: int) -> None:
    """带纹理的目标：模板匹配需要非恒定像素（纯色模板的 NCC 是退化的）。"""
    x, y, w, h = box
    yy, xx = np.mgrid[0:h, 0:w]
    mask = ((xx // cell + yy // cell) % 2 == 0)[:, :, None]
    patch = np.where(mask, np.array([light] * 3, np.uint8), np.array([dark] * 3, np.uint8)).astype(np.uint8)
    image[y : y + h, x : x + w] = patch


def _frame(image: np.ndarray, index: int = 1) -> Frame:
    return Frame(image=image, size=(W, H), index=index)


class ScriptedController(Controller):
    """两个界面 + 一个弹窗，点击真实改变"屏幕"。"""

    scheme = "Scripted"
    description = "测试用"

    def __init__(self) -> None:
        super().__init__("scripted")
        self.screen = "main"
        self.popup = False
        self.clicks: list[tuple[float, float]] = []

    def connect(self) -> None:
        self._connected = True

    @property
    def resolution(self) -> Size:
        return (W, H)

    def screenshot(self) -> np.ndarray:
        image = _canvas()
        if self.screen == "main":
            _patterned(image, MAIN_BUTTON, 5, 60, 235)
        else:
            _patterned(image, BATTLE_BUTTON, 3, 40, 210)
        if self.popup:
            _patterned(image, POPUP_BUTTON, 2, 80, 250)
        return image

    def click(self, x: float, y: float) -> None:
        self.clicks.append((x, y))
        px, py = int(x * W), int(y * H)
        if self.popup and _inside((px, py), POPUP_BUTTON):
            self.popup = False
            return
        if self.screen == "main" and _inside((px, py), MAIN_BUTTON):
            self.screen = "battle"


def _inside(point: tuple[int, int], box: tuple[int, int, int, int]) -> bool:
    x, y = point
    bx, by, bw, bh = box
    return bx <= x <= bx + bw and by <= y <= by + bh


@pytest.fixture()
def graph(tmp_path: Path) -> Graph:
    """三份模板 + 两个节点 + 一条普通边 + 一条 recovery 边。"""
    main = _canvas()
    _patterned(main, MAIN_BUTTON, 5, 60, 235)
    battle = _canvas()
    _patterned(battle, BATTLE_BUTTON, 3, 40, 210)
    popup = _canvas()
    _patterned(popup, POPUP_BUTTON, 2, 80, 250)

    for name, image, box in (
        ("main_start", main, MAIN_BUTTON),
        ("battle_settle", battle, BATTLE_BUTTON),
        ("popup_close", popup, POPUP_BUTTON),
    ):
        cv2.imwrite(str(tmp_path / f"{name}.png"), _crop(image, box))

    result = Graph.empty(str(tmp_path))
    result.add_recognizer("main_start", {"type": "template", "template": "main_start.png", "threshold": 0.9})
    result.add_recognizer("battle_settle", {"type": "template", "template": "battle_settle.png", "threshold": 0.9})
    result.add_recognizer("popup_close", {"type": "template", "template": "popup_close.png", "threshold": 0.9})
    result.upsert_node(Node(id="main", name="主界面", enter=["main_start"]))
    result.upsert_node(Node(id="battle", name="战斗中", enter=["battle_settle"]))
    result.add_edge(
        Edge(
            id="e_start", when="main_start", src="main", dst="battle", action={"type": "click", "target": "main_start"}
        )
    )
    result.add_edge(
        Edge(
            id="r_popup",
            when="popup_close",
            kind="recovery",
            priority=100,
            action={"type": "click", "target": "popup_close"},
        )
    )
    result.validate()
    return result


@pytest.fixture()
def engine(graph: Graph) -> tuple[Engine, ScriptedController]:
    controller = ScriptedController()
    controller.connect()
    return Engine(graph, controller, vote=1), controller


def test_resolves_node_from_frame(engine: tuple[Engine, ScriptedController]) -> None:
    machine, controller = engine
    machine.tick(_frame(controller.screenshot()))

    assert machine.current == "main"
    assert machine.detections["main_start"].state == "confirmed"


def test_edge_fires_then_transition_confirms_next_tick(engine: tuple[Engine, ScriptedController]) -> None:
    machine, controller = engine
    machine.tick(_frame(controller.screenshot()))  # 进入 main

    events = machine.tick(_frame(controller.screenshot()))  # 触发 e_start
    types = [event.type for event in events]
    assert types[0] == "edge_matched", types
    assert "action_executed" in types, types
    assert controller.clicks, "动作必须真的点到设备上"
    assert machine.pending is not None, "动作后要挂起 pending 转换"

    # 控制器已切到 battle：下一帧确认迁移
    machine.tick(_frame(controller.screenshot()))
    assert machine.current == "battle"
    assert machine.stats["transitions"] == 1


def test_recovery_edge_wins_over_normal_edge(engine: tuple[Engine, ScriptedController]) -> None:
    machine, controller = engine
    machine.tick(_frame(controller.screenshot()))
    machine.tick(_frame(controller.screenshot()))
    machine.tick(_frame(controller.screenshot()))
    assert machine.current == "battle"

    controller.popup = True
    events = machine.tick(_frame(controller.screenshot()))
    types = [event.type for event in events]
    assert types[0] == "recovery_matched", types
    assert "action_executed" in types, types
    assert controller.popup is False, "recovery 动作应把弹窗关掉"
    assert machine.stats["recoveries"] == 1

    # 弹窗消失后 settle 完成，并回到原来的界面
    events = machine.tick(_frame(controller.screenshot()))
    assert "recovery_done" in [event.type for event in events]
    assert machine.current == "battle"


def test_min_score_blocks_edge(engine: tuple[Engine, ScriptedController]) -> None:
    """识别到了（≥ 识别器阈值），但边要求更高分：不该触发。"""
    machine, controller = engine
    machine.tick(_frame(controller.screenshot()))

    frame = controller.screenshot()
    noisy = np.clip(
        frame.astype(np.int16) + np.random.default_rng(7).integers(-14, 15, frame.shape, dtype=np.int16),
        0,
        255,
    ).astype(np.uint8)
    machine.graph.edges[0].min_score = 0.999  # e_start 要求几乎完美匹配

    events = machine.tick(_frame(noisy))

    detection = machine.detections.get("main_start")
    assert detection is not None and detection.score < 0.999, "这一帧要能识别到、但分数不够完美，断言才有意义"
    assert [event.type for event in events] == []
    assert controller.clicks == []
    assert machine.pending is None


def test_unknown_screen_keeps_state_and_relocates(engine: tuple[Engine, ScriptedController]) -> None:
    machine, controller = engine
    machine.tick(_frame(controller.screenshot()))
    assert machine.current == "main"

    # 画面变成什么都没有（例如加载中）：不迁移、不报错
    blank = _canvas()
    events = machine.tick(_frame(blank))
    assert events == []
    assert machine.current == "main"

    # 回到主界面后依然能识别
    machine.tick(_frame(controller.screenshot()))
    assert machine.current == "main"


def test_run_action_resolves_variables(engine: tuple[Engine, ScriptedController]) -> None:
    """「单独执行这一步」必须先求值，和其他执行路径同一套。

    单步执行须先 resolve 变量再 Action.parse。
    """
    machine, _controller = engine
    machine.variables.set("时长", 120)

    described = machine.run_action({"type": "click", "x": 0.5, "y": 0.5, "duration_ms": {"$var": "时长"}})

    assert described.startswith("点击"), described


def test_run_action_supports_set_action(engine: tuple[Engine, ScriptedController]) -> None:
    """赋值动作（set）也要能"单独执行" —— 它不在 Action 的类型表里，以前报"未支持的动作类型"。"""
    machine, _controller = engine

    described = machine.run_action({"type": "set", "name": "计数", "value": 3})

    assert described == "设置变量 计数 = 3"
    assert machine.variables.get("计数") == 3


def test_run_action_reports_undefined_variable(engine: tuple[Engine, ScriptedController]) -> None:
    """变量没定义：直接报给用户（能改的错），不要静默执行成别的动作。"""
    machine, _controller = engine

    with pytest.raises(ValueError, match="变量未定义"):
        machine.run_action({"type": "wait", "seconds": {"$var": "没定义过"}})
