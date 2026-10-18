"""会话层测试：Mock 设备上的完整闭环（连上 → 出帧 → 录制 → 运行 → 出事件）。

这是"第一版能不能用"的核心验证：不需要任何真机，用 Mock 走完
连接 / 帧推送 / 录制落盘 / 识别出分 / 状态机点击 / 阈值调参。
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from gamepilot.core.geometry import Rect
from gamepilot.core.recognizer import OcrRecognizer, TemplateRecognizer
from gamepilot.devices.synthetic_test import BUTTON, LOGO, SyntheticController
from gamepilot.project import Project
from gamepilot.session import DeviceSession


def _wait(predicate: Any, timeout: float = 5.0, interval: float = 0.05) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def test_capture_failure_notifies_once_then_recovers(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    controller = SyntheticController()
    controller.connect()
    original = controller.screenshot
    calls = 0

    def flaky_screenshot() -> Any:
        nonlocal calls
        calls += 1
        if calls <= 3:
            raise RuntimeError("暂时没有画面")
        return original()

    monkeypatch.setattr(controller, "screenshot", flaky_screenshot)
    events: list[tuple[str, dict[str, Any]]] = []
    session = DeviceSession(
        "synthetic:test-1",
        controller,
        Project(root=str(tmp_path)).ensure(),
        lambda method, params: events.append((method, params)),
        fps=20.0,
    )
    try:
        session.start()
        assert _wait(lambda: session.index > 0)
        assert [method for method, _ in events].count("device.failed") == 1
        assert [method for method, _ in events].count("device.recovered") == 1
        assert session.capture_error is None
    finally:
        session.stop()


def test_disconnect_ignores_late_capture_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    controller = SyntheticController()
    controller.connect()
    entered = threading.Event()
    release = threading.Event()

    def delayed_failure() -> Any:
        entered.set()
        release.wait(timeout=5)
        raise RuntimeError("连接已关闭")

    monkeypatch.setattr(controller, "screenshot", delayed_failure)
    events: list[str] = []
    session = DeviceSession(
        "synthetic:test-1",
        controller,
        Project(root=str(tmp_path)).ensure(),
        lambda method, _params: events.append(method),
        fps=20.0,
    )
    session.start()
    assert entered.wait(timeout=2)
    stopping = threading.Thread(target=session.stop)
    stopping.start()
    assert _wait(session._stop.is_set)
    release.set()
    stopping.join(timeout=3)

    assert not stopping.is_alive()
    assert "device.failed" not in events
    assert "device.recovered" not in events


@pytest.fixture()
def session(tmp_path: Path) -> Any:
    notifications: list[tuple[str, dict[str, Any]]] = []
    controller = SyntheticController()
    controller.connect()
    project = Project(root=str(tmp_path)).ensure()
    instance = DeviceSession(
        device_id="synthetic:test-1",
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
    assert first["deviceId"] == "synthetic:test-1"


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


def test_record_new_node_never_reuses_a_living_node_id(session: DeviceSession) -> None:
    """「录一个新界面」时 id 由引擎分配：界面传下来的 `node_N` 是本地序号，重启就重号。

    客户端本地序号重启会重号，须由引擎分配 id，避免覆盖已有节点。
    """
    first = session.record_template(
        rect=Rect(*LOGO),
        label="界面一",
        node_id="node_1",
        node_name="新界面",
        allocate_node_id=True,
    )
    assert first["nodeId"] == "n_1"

    # 重启应用后本地序号又从 node_1 开始：引擎必须另给一个 id，不能顶掉 n_1
    second = session.record_template(
        rect=Rect(*BUTTON),
        label="界面二",
        node_id="node_1",
        node_name="新界面",
        allocate_node_id=True,
    )

    assert second["nodeId"] == "n_2"
    assert set(session.graph.nodes) == {"n_1", "n_2"}
    assert session.graph.nodes["n_1"].enter == ["界面一"]
    assert session.graph.nodes["n_2"].enter == ["界面二"]


def test_record_into_existing_node_still_targets_that_node(session: DeviceSession) -> None:
    """录到**已有**界面上（targetMode=existing）时 id 照旧生效：那条路不该被"分配 id"改掉。"""
    session.record_template(rect=Rect(*LOGO), label="主界面", node_id="main", node_name="主界面")

    again = session.record_template(rect=Rect(*BUTTON), label="血条", node_id="main")

    assert again["nodeId"] == "main"
    assert set(session.graph.nodes) == {"main"}
    assert session.graph.nodes["main"].enter == ["主界面", "血条"]


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
    错误信息须指明被哪条 enter/边引用。
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


def test_record_ocr_registers_an_ocr_recognizer(session: DeviceSession, tmp_path: Path) -> None:
    result = session.record_ocr(
        rect=Rect(*BUTTON),
        label="金币",
        text="金币",
        node_id="main",
        node_name="主界面",
    )

    assert result["mode"] == "ocr"
    stored = json.loads((tmp_path / "graph.json").read_text(encoding="utf-8"))
    spec = stored["recognizers"]["金币"]
    assert spec["type"] == "ocr"
    assert spec["text"] == "金币"
    assert spec["mode"] == "contains"
    assert spec["roi"], "OCR 必须记住框选范围，否则全屏读字又慢又乱"
    assert spec["threshold"] == pytest.approx(0.6)

    recognizer = session.graph.recognizers["金币"]
    assert isinstance(recognizer, OcrRecognizer)
    assert recognizer.text == "金币"
    # 证据截图照样留一张：告诉用户"这段文字对应屏幕哪块"；登记成 template，
    # 界面取缩略图（template.image）和删识别器清文件才都能找到它
    assert os.path.exists(tmp_path / "templates" / "金币.png")
    assert spec["template"] == "templates/金币.png"


def test_record_ocr_keeps_the_matching_mode(session: DeviceSession, tmp_path: Path) -> None:
    session.record_ocr(rect=Rect(*BUTTON), label="等级", text="Lv.12", mode="equals", threshold=0.8)

    stored = json.loads((tmp_path / "graph.json").read_text(encoding="utf-8"))
    assert stored["recognizers"]["等级"]["mode"] == "equals"
    assert stored["recognizers"]["等级"]["threshold"] == pytest.approx(0.8)


def test_record_ocr_requires_text(session: DeviceSession) -> None:
    with pytest.raises(ValueError, match="要识别的文字"):
        session.record_ocr(rect=Rect(*BUTTON), label="空", text="   ")


def test_record_ocr_survives_a_reload(session: DeviceSession) -> None:
    session.record_ocr(rect=Rect(*BUTTON), label="每日奖励", text="每日奖励")
    session.reload_graph()

    recognizer = session.graph.recognizers["每日奖励"]
    assert isinstance(recognizer, OcrRecognizer)
    assert recognizer.text == "每日奖励"


def test_recorded_template_remembers_the_capture_size(session: DeviceSession, tmp_path: Path) -> None:
    """录制时记下那一帧的像素尺寸：换分辨率后靠它自动缩放模板（见 test_resolution_scales.py）。"""
    session.record_template(rect=Rect(*LOGO), label="logo", threshold=0.8)

    stored = json.loads((tmp_path / "graph.json").read_text(encoding="utf-8"))
    assert stored["recognizers"]["logo"]["recorded_size"] == [1280, 720]


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


def test_record_template_full_search_persists_and_recognizes(session: DeviceSession, tmp_path: Path) -> None:
    """录制时勾「全屏查找」：spec 里落 search=full，roi 保留，后续帧能认到 LOGO。"""
    result = session.record_template(
        rect=Rect(*LOGO),
        label="logo",
        threshold=0.8,
        node_id="main",
        node_name="主界面",
        search="full",
    )

    assert result["mode"] == "template"
    assert result["search"] == "full"
    stored = json.loads((tmp_path / "graph.json").read_text(encoding="utf-8"))
    assert stored["recognizers"]["logo"]["search"] == "full"
    assert "roi" in stored["recognizers"]["logo"], "roi 要留着：切回 region 时还要用"
    recognizer = session.graph.recognizers["logo"]
    assert isinstance(recognizer, TemplateRecognizer)
    assert recognizer.search == "full"
    assert _wait(lambda: session.engine.detections.get("logo") is not None), "全屏搜索应该能认到 LOGO"


def test_set_recognizer_search_toggles_and_persists(session: DeviceSession, tmp_path: Path) -> None:
    session.record_template(rect=Rect(*LOGO), label="logo", node_id="main", node_name="主界面")
    assert "search" not in session.graph.specs["logo"], "默认 region 不落盘"

    session.set_recognizer_search("logo", "full")
    stored = json.loads((tmp_path / "graph.json").read_text(encoding="utf-8"))
    assert stored["recognizers"]["logo"]["search"] == "full"
    recognizer = session.graph.recognizers["logo"]
    assert isinstance(recognizer, TemplateRecognizer)
    assert recognizer.search == "full"

    session.set_recognizer_search("logo", "region")
    stored = json.loads((tmp_path / "graph.json").read_text(encoding="utf-8"))
    assert "search" not in stored["recognizers"]["logo"]
    recognizer = session.graph.recognizers["logo"]
    assert isinstance(recognizer, TemplateRecognizer)
    assert recognizer.search == "region"


def test_full_search_on_solid_color_stays_region(session: DeviceSession) -> None:
    """纯色区域会降级成颜色识别器：颜色识别不支持整帧搜索，search 不能生效。"""
    result = session.record_template(
        rect=Rect(*BUTTON),
        label="hp_bar",
        search="full",
        node_id="main",
        node_name="主界面",
    )
    assert result["mode"] == "color"
    assert result["search"] == "region"
    assert "search" not in session.graph.specs["hp_bar"]


def test_status_and_timeline_are_serializable(session: DeviceSession) -> None:
    status = session.status()
    json.dumps(status)  # 必须能过 RPC 序列化
    assert status["deviceId"] == "synthetic:test-1"
    assert status["index"] >= 1

    timeline = session.timeline(limit=5)
    json.dumps(timeline)
    assert timeline["frames"]


def test_manual_tap_does_not_hold_session_lock(tmp_path: Path) -> None:
    """adb 点击可能要 1 秒；锁不能罩住这段 I/O，否则状态查询/停跑会把界面卡死。"""
    started = threading.Event()
    release = threading.Event()
    controller = SyntheticController()
    controller.connect()

    def slow_click(_x: float, _y: float) -> None:
        started.set()
        assert release.wait(timeout=5)

    controller.click = slow_click  # type: ignore[method-assign]
    session = DeviceSession(
        "synthetic:test-1",
        controller,
        Project(root=str(tmp_path)).ensure(),
        lambda _method, _params: None,
        fps=5.0,
    )
    worker = threading.Thread(target=lambda: session.tap(0.5, 0.5), daemon=True)
    worker.start()
    assert started.wait(timeout=2)
    began = time.perf_counter()
    session.status()
    elapsed = time.perf_counter() - began
    release.set()
    worker.join(timeout=3)
    assert elapsed < 0.25, f"status 被点击 I/O 堵住了: {elapsed:.3f}s"


def test_workflow_click_does_not_hold_session_lock(tmp_path: Path) -> None:
    """工作流执行点击时，截图线程也不能握着锁不放。"""
    started = threading.Event()
    release = threading.Event()
    controller = SyntheticController()
    controller.connect()

    def slow_click(_x: float, _y: float) -> None:
        started.set()
        assert release.wait(timeout=5)

    controller.click = slow_click  # type: ignore[method-assign]
    session = DeviceSession(
        "synthetic:test-1",
        controller,
        Project(root=str(tmp_path)).ensure(),
        lambda _method, _params: None,
        fps=20.0,
    )
    graph = session.graph.to_dict()
    graph["flow"] = {
        "steps": [
            {"id": "t", "type": "manual", "params": {}},
            {"id": "c", "type": "click", "params": {"by": "坐标", "x": 0.5, "y": 0.5}},
        ]
    }
    session.save_graph(graph)
    session.start()
    try:
        session.start_run()
        assert started.wait(timeout=5), "工作流点击没执行"
        began = time.perf_counter()
        session.status()
        elapsed = time.perf_counter() - began
        assert elapsed < 0.25, f"执行中 status 被锁住了: {elapsed:.3f}s"
    finally:
        release.set()
        session.stop()


def _hits(session: DeviceSession) -> int:
    controller = session.controller
    return int(getattr(controller, "hits", 0))
