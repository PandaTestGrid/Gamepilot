"""会话层测试：Mock 设备上的完整闭环（连上 → 出帧 → 录制 → 运行 → 出事件）。

这是"第一版能不能用"的核心验证：不需要任何真机，用 Mock 走完
连接 / 帧推送 / 录制落盘 / 识别出分 / 状态机点击 / 阈值调参。
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import pytest

from gamepilot.core.geometry import Rect
from gamepilot.devices.mock import BUTTON, LOGO, MockController
from gamepilot.project import Project
from gamepilot.session import DeviceSession


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
    instance.set_stream_fps(20.0)  # 引擎默认不推帧：界面要了才推
    instance.start()
    assert _wait(lambda: instance.index >= 2), "截图循环没跑起来"
    yield instance
    instance.stop()


def test_capture_loop_emits_frames_with_jpeg_and_resolution(session: DeviceSession) -> None:
    frames = [params for method, params in session.notifications if method == "engine.frame"]  # type: ignore[attr-defined]

    assert frames, "至少要推一帧给前端"
    first = frames[0]
    assert first["resolution"] == [1280, 720]
    assert first["jpeg"], "帧必须是 base64 JPEG"
    assert isinstance(first["detections"], list)
    assert first["deviceId"] == "mock:mock-1"


def test_solid_color_region_falls_back_to_color_recognizer(session: DeviceSession) -> None:
    """纯色区域用模板匹配没有判别力，录制时应自动降级成颜色识别器。"""
    result = session.record_template(rect=Rect(*BUTTON), label="hp_bar", node_id="main", node_name="主界面")

    assert result["mode"] == "color"
    spec = session.graph.specs["hp_bar"]
    assert spec["type"] == "color"
    assert session.graph.recognizers["hp_bar"].__class__.__name__ == "ColorRecognizer"
    assert _wait(lambda: session.engine.detections.get("hp_bar") is not None)


def test_textured_region_records_a_template_recognizer(session: DeviceSession) -> None:
    result = session.record_template(rect=Rect(*LOGO), label="logo", node_id="main", node_name="主界面")

    assert result["mode"] == "template"
    assert session.graph.specs["logo"]["type"] == "template"
    assert _wait(lambda: session.engine.detections.get("logo") is not None)
    detection = session.engine.detections["logo"]
    assert detection.score >= 0.9, f"棋盘格目标的匹配分数不该这么低: {detection.score}"


def test_remove_recognizer_deletes_its_template_file(session: DeviceSession, tmp_path: Path) -> None:
    """删除识别器要连素材文件一起删。

    颜色识别器（纯色区域降级来的）的 spec 里**没有** `template` 字段，
    但录制时同样写了 `templates/<label>.png`：只按 spec 删的话，用户点了删除
    还会在 templates/ 里看到它，像没删干净。
    """
    session.record_template(rect=Rect(*LOGO), label="logo")
    session.record_template(rect=Rect(*BUTTON), label="hp_bar")
    assert (tmp_path / "templates" / "logo.png").exists()
    assert (tmp_path / "templates" / "hp_bar.png").exists()
    assert session.graph.specs["hp_bar"]["type"] == "color", "纯色区域应当降级成颜色识别器"

    session.remove_recognizer("logo")
    session.remove_recognizer("hp_bar")

    assert not (tmp_path / "templates" / "logo.png").exists()
    assert not (tmp_path / "templates" / "hp_bar.png").exists()
    assert "logo" not in session.graph.recognizers
    assert "hp_bar" not in session.graph.recognizers


def test_remove_refusal_disambiguates_nodes_with_the_same_name(session: DeviceSession) -> None:
    """拒绝删除的提示里，重名节点必须带 id。

    真实场景：脚本里有两个节点都叫「新界面」（只差 id），删识别器时报
    "界面『新界面』的进入条件" —— 用户根本不知道该去改哪一个（实测反馈）。
    """
    session.record_template(rect=Rect(*LOGO), label="相机", node_id="node_1", node_name="新界面")
    session.record_template(rect=Rect(*BUTTON), label="hp", node_id="node_2", node_name="新界面")

    with pytest.raises(RuntimeError) as info:
        session.remove_recognizer("相机")

    message = str(info.value)
    assert "还在被使用" in message
    assert "『新界面』（node_1）" in message, f"重名节点必须带 id：{message}"
    # 被拒绝 = 什么都没动
    assert "相机" in session.graph.recognizers


def test_record_template_writes_files_and_registers_recognizer(session: DeviceSession, tmp_path: Path) -> None:
    result = session.record_template(
        rect=Rect(*BUTTON),
        label="start_btn",
        threshold=0.8,
        node_id="main",
        node_name="主界面",
    )

    assert os.path.exists(tmp_path / "templates" / "start_btn.png")
    assert os.path.exists(tmp_path / "graph.json")
    stored = json.loads((tmp_path / "graph.json").read_text(encoding="utf-8"))
    assert "start_btn" in stored["recognizers"]
    assert stored["nodes"][0]["enter"] == ["start_btn"]
    assert result["template"] == "templates/start_btn.png"


def test_recorded_template_is_recognized_in_later_frames(session: DeviceSession) -> None:
    session.record_template(rect=Rect(*BUTTON), label="start_btn", threshold=0.8, node_id="main", node_name="主界面")

    assert _wait(lambda: session.engine.detections.get("start_btn") is not None), "录制的模板应该能被后续帧匹配到"
    detection = session.engine.detections["start_btn"]
    assert detection.score >= 0.9, f"固定目标的匹配分数不该这么低: {detection.score}"
    # 归一化坐标应当落在按钮附近
    assert BUTTON[0] - 0.05 <= detection.rect.x <= BUTTON[0] + 0.05


def test_run_state_machine_clicks_the_recorded_button(session: DeviceSession, tmp_path: Path) -> None:
    session.record_template(rect=Rect(*BUTTON), label="start_btn", threshold=0.8, node_id="main", node_name="主界面")
    graph = session.graph.to_dict()
    graph["edges"] = [
        {
            "id": "e_tap",
            "from": "main",
            "when": "start_btn",
            "cooldown_ms": 200,
            "action": {"type": "click", "target": "start_btn"},
        }
    ]
    session.save_graph(graph)

    session.start_run()
    assert session.running

    assert _wait(lambda: _hits(session) > 0, timeout=5.0), "运行后状态机应当点到按钮上"
    assert session.engine.current == "main"
    assert session.engine.stats["actions"] > 0

    session.stop_run()
    assert not session.running


def test_run_requires_a_node(session: DeviceSession) -> None:
    with pytest.raises(RuntimeError, match="还没有节点"):
        session.start_run()


def test_set_threshold_persists_to_graph_file(session: DeviceSession, tmp_path: Path) -> None:
    session.record_template(rect=Rect(*BUTTON), label="start_btn", threshold=0.8, node_id="main", node_name="主界面")
    session.set_threshold("start_btn", 0.95)

    stored = json.loads((tmp_path / "graph.json").read_text(encoding="utf-8"))
    assert stored["recognizers"]["start_btn"]["threshold"] == 0.95
    assert session.graph.specs["start_btn"]["threshold"] == 0.95


def test_status_and_timeline_are_serializable(session: DeviceSession) -> None:
    status = session.status()
    json.dumps(status)  # 必须能过 RPC 序列化
    assert status["deviceId"] == "mock:mock-1"
    assert status["index"] >= 1

    timeline = session.timeline(limit=5)
    json.dumps(timeline)
    assert timeline["frames"]


def _hits(session: DeviceSession) -> int:
    controller = session.controller
    return int(getattr(controller, "hits", 0))
