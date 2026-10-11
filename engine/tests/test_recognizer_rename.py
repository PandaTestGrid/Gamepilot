"""识别器改名：标签 + **所有引用**必须一起改。

为什么这个测试值得单独写一份：改名看起来只是"换个键名"，实际上标签同时出现在
节点进入条件、边的 when / condition（all_of / any_of / none_of）、动作的 target /
to_target、动作里 `$score` 的深层引用里。少改一处，`validate()` 就会在保存时报
"引用了未定义的识别器" —— 而且是在用户点下"改名"之后才炸。
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest

from gamepilot.core.conditions import ALWAYS_LABEL, Condition
from gamepilot.core.geometry import Rect
from gamepilot.core.graph import Edge, Graph, Node, validate_recognizer_label
from gamepilot.devices.mock import BUTTON, LOGO, MockController
from gamepilot.project import Project
from gamepilot.session import DeviceSession

SPEC = {"type": "color", "target_bgr": [10, 20, 30], "tolerance": 30, "min_pixels": 60}


def _graph_with_references(tmp_path: Path) -> Graph:
    """一份把 old_label 用在**所有能引用的地方**的状态图。"""
    graph = Graph.empty(str(tmp_path))
    graph.add_recognizer("old_label", dict(SPEC))
    graph.add_recognizer("other", dict(SPEC))
    graph.upsert_node(Node(id="main", name="主界面", enter=["old_label", "other"]))
    graph.upsert_node(Node(id="next", name="下一屏"))
    graph.add_edge(
        Edge(
            id="e1",
            when="old_label",
            src="main",
            dst="next",
            action={"type": "click", "target": "old_label"},
        )
    )
    graph.add_edge(
        Edge(
            id="e2",
            when="old_label",
            src="main",
            dst="next",
            action={"type": "click", "target": "other", "to_target": "old_label"},
            condition=Condition(all_of=("old_label",), any_of=("old_label", "other"), none_of=("old_label",)),
        )
    )
    graph.add_edge(
        Edge(
            id="e3",
            when="other",
            src="main",
            dst="next",
            # $score 的深层引用：动作参数里嵌了两层
            action={"type": "wait", "seconds": {"$score": "old_label"}, "extra": [{"$score": "old_label"}]},
        )
    )
    return graph


def test_rename_updates_every_reference(tmp_path: Path) -> None:
    graph = _graph_with_references(tmp_path)

    refs = graph.rename_recognizer("old_label", "开始按钮")

    assert refs == {"nodes": 1, "edges": 3, "scores": 2}
    # 键换了，识别器实例跟着重建
    assert "开始按钮" in graph.specs and "old_label" not in graph.specs
    assert "开始按钮" in graph.recognizers and "old_label" not in graph.recognizers
    # 节点进入条件
    assert graph.nodes["main"].enter == ["开始按钮", "other"]
    # 边：when / condition 三个列表 / 动作 target·to_target
    assert graph.edges[0].when == "开始按钮"
    assert graph.edges[0].action["target"] == "开始按钮"
    assert graph.edges[1].when == "开始按钮"
    assert graph.edges[1].action["to_target"] == "开始按钮"
    assert graph.edges[1].condition.all_of == ("开始按钮",)
    assert graph.edges[1].condition.any_of == ("开始按钮", "other")
    assert graph.edges[1].condition.none_of == ("开始按钮",)
    # $score 的深层引用（两层嵌套都要改）
    assert graph.edges[2].action["seconds"] == {"$score": "开始按钮"}
    assert graph.edges[2].action["extra"] == [{"$score": "开始按钮"}]
    # 校验必须通过：这正是"少改一处"会炸的地方
    graph.validate()


def test_rename_keeps_order_and_template_path(tmp_path: Path) -> None:
    graph = Graph.empty(str(tmp_path))
    graph.add_recognizer("first", dict(SPEC))
    graph.add_recognizer("old_label", {"type": "template", "template": "templates/old_label.png"})
    graph.add_recognizer("last", dict(SPEC))

    graph.rename_recognizer("old_label", "middle")

    # 顺序不动：识别读数列表不该因为改名而跳位置
    assert list(graph.specs) == ["first", "middle", "last"]
    # 模板文件不跟着改名（spec 里存的是路径，文件叫什么对匹配没影响）
    assert graph.specs["middle"]["template"] == "templates/old_label.png"


def test_rename_round_trips_through_json(tmp_path: Path) -> None:
    graph = _graph_with_references(tmp_path)
    graph.rename_recognizer("old_label", "开始按钮")
    path = str(tmp_path / "graph.json")

    graph.save(path)
    reloaded = Graph.load(path)

    assert reloaded.specs.keys() == graph.specs.keys()
    reloaded.validate()
    assert reloaded.nodes["main"].enter == ["开始按钮", "other"]
    assert reloaded.edges[0].when == "开始按钮"


def test_rename_to_same_name_is_a_noop(tmp_path: Path) -> None:
    graph = _graph_with_references(tmp_path)

    assert graph.rename_recognizer("old_label", "old_label") == {"nodes": 0, "edges": 0, "scores": 0}
    assert "old_label" in graph.specs


def test_rename_without_references_reports_zero(tmp_path: Path) -> None:
    graph = Graph.empty(str(tmp_path))
    graph.add_recognizer("lonely", dict(SPEC))

    assert graph.rename_recognizer("lonely", "solo") == {"nodes": 0, "edges": 0, "scores": 0}
    assert list(graph.specs) == ["solo"]


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        ("missing", "whatever", "识别器不存在"),
        ("old_label", "other", "已经有同名识别器"),
    ],
)
def test_rename_rejects_unknown_or_taken(tmp_path: Path, old: str, new: str, message: str) -> None:
    graph = _graph_with_references(tmp_path)

    with pytest.raises((KeyError, ValueError), match=message):
        graph.rename_recognizer(old, new)

    # 失败必须**什么都没改**（不能留下半改状态）
    assert list(graph.specs) == ["old_label", "other"]


@pytest.mark.parametrize(
    ("label", "message"),
    [
        ("", "不能为空"),
        ("   ", "不能为空"),
        ("a" * 49, "太长"),
        ("bad/name", "不能带"),
        ("bad\\name", "不能带"),
        ("bad\x00name", "控制字符"),
        (ALWAYS_LABEL, "保留名"),
    ],
)
def test_label_validation_rejects_bad_names(label: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        validate_recognizer_label(label)


def test_label_validation_trims_and_allows_chinese_and_spaces() -> None:
    assert validate_recognizer_label("  开始 按钮  ") == "开始 按钮"
    assert validate_recognizer_label("start_btn_2") == "start_btn_2"


# ------------------------------------------------------------------ 会话层


def _wait(predicate: Any, timeout: float = 5.0, interval: float = 0.05) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


@pytest.fixture()
def session(tmp_path: Path) -> Any:
    notifications: list[tuple[str, dict[str, Any]]] = []
    controller = MockController()
    controller.connect()
    project = Project(root=str(tmp_path)).ensure()
    instance = DeviceSession(
        device_id="mock:mock-1",
        controller=controller,
        project=project,
        emit=lambda method, params: notifications.append((method, params)),
        fps=20.0,
        jpeg_width=320,
    )
    instance.notifications = notifications  # type: ignore[attr-defined]
    instance.set_stream_fps(20.0)
    instance.start()
    assert _wait(lambda: instance.index >= 2), "截图循环没跑起来"
    yield instance
    instance.stop()


def test_session_rename_saves_and_reloads_engine(session: DeviceSession) -> None:
    """改名要落盘 + 热重载：否则引擎里跑的还是旧标签的识别器。"""
    session.record_template(rect=Rect(*LOGO), label="logo", node_id="main", node_name="主界面")
    assert _wait(lambda: session.engine.detections.get("logo") is not None)

    result = session.rename_recognizer("logo", "游戏标题")

    assert result["from"] == "logo"
    assert result["to"] == "游戏标题"
    assert result["refs"]["nodes"] == 1
    # 返回的图里新标签已经在
    assert "游戏标题" in result["graph"]["recognizers"]
    # 落盘
    saved = json.loads(Path(session.project.graph_path).read_text(encoding="utf-8"))
    assert "游戏标题" in saved["recognizers"]
    assert saved["nodes"][0]["enter"] == ["游戏标题"]
    # 热重载后引擎按新标签出分
    assert _wait(lambda: session.engine.detections.get("游戏标题") is not None)


def test_session_rename_rejects_taken_name_and_leaves_file_alone(session: DeviceSession) -> None:
    session.record_template(rect=Rect(*LOGO), label="logo", node_id="main", node_name="主界面")
    session.record_template(rect=Rect(*BUTTON), label="hp_bar", node_id="main", node_name="主界面")
    before = Path(session.project.graph_path).read_text(encoding="utf-8")

    with pytest.raises(ValueError, match="已经有同名识别器"):
        session.rename_recognizer("logo", "hp_bar")

    assert Path(session.project.graph_path).read_text(encoding="utf-8") == before
