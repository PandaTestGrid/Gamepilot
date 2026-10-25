"""Persisted recognition switches do not delete materials or reset live runners."""

from __future__ import annotations

import io
import threading
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from gamepilot.core.conditions import Condition
from gamepilot.core.flow_engine import FlowEngine
from gamepilot.core.frame import Detection, Frame
from gamepilot.core.geometry import Rect
from gamepilot.core.graph import Graph
from gamepilot.core.recognizer import VoteFilter, build_recognizer, perceive
from gamepilot.devices.synthetic_test import SyntheticController
from gamepilot.project import Project
from gamepilot.rpc.stdio import RpcServer
from gamepilot.session import DeviceSession, WorkflowRunner


@pytest.mark.parametrize(
    "spec",
    [
        {"type": "template", "template": "not-read.png"},
        {"type": "ocr", "text": "hello"},
        {"type": "yolo", "classes": ["button"]},
        {"type": "color", "target_bgr": [0, 0, 0]},
    ],
)
def test_disabled_recognizers_never_call_detect_and_reset_only_their_vote(
    spec: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    recognizer = build_recognizer("target", {**spec, "enabled": False}, "")
    calls: list[bool] = []
    monkeypatch.setattr(recognizer, "detect", lambda *_args, **_kwargs: calls.append(True))
    vote = VoteFilter(2)
    vote.update("target", True)
    vote.update("other", True)
    frame = Frame(np.zeros((8, 8, 3), dtype=np.uint8), size=(8, 8), index=1)
    hits = perceive({"target": recognizer}, frame, vote)
    assert hits == {}
    assert Condition(none_of=("target",)).matches(hits)
    assert not calls
    assert vote.snapshot()["target"] == 0


def test_old_detect_cannot_return_hit_after_disable_then_reenable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    graph = Graph.from_dict({"recognizers": {"target": {"type": "color"}}}, str(tmp_path))
    previous = graph.recognizers["target"]
    entered = threading.Event()
    release = threading.Event()
    results: list[Any] = []

    def detect(_frame: Frame) -> list[Detection]:
        entered.set()
        assert release.wait(3)
        return [Detection("target", Rect(0, 0, 1, 1), score=1)]

    monkeypatch.setattr(previous, "detect", detect)
    frame = Frame(np.zeros((8, 8, 3), dtype=np.uint8), size=(8, 8), index=1)
    thread = threading.Thread(target=lambda: results.append(perceive(graph.recognizers, frame, VoteFilter(1))))
    thread.start()
    try:
        assert entered.wait(3)
        graph.set_recognizer_enabled("target", False)
        graph.set_recognizer_enabled("target", True)
        release.set()
        thread.join(3)
        assert not thread.is_alive()
        assert results == [{}]
    finally:
        release.set()
        thread.join(3)


def test_completed_raw_hit_is_invalidated_while_another_recognizer_blocks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    graph = Graph.from_dict({"recognizers": {"target": {"type": "color"}, "other": {"type": "color"}}}, str(tmp_path))
    entered = threading.Event()
    release = threading.Event()
    results: list[Any] = []
    monkeypatch.setattr(graph.recognizers["target"], "detect", lambda _: [Detection("target", Rect(0, 0, 1, 1))])

    def detect(_frame: Frame) -> list[Detection]:
        entered.set()
        assert release.wait(3)
        return []

    monkeypatch.setattr(graph.recognizers["other"], "detect", detect)
    frame = Frame(np.zeros((8, 8, 3), dtype=np.uint8), size=(8, 8))
    thread = threading.Thread(target=lambda: results.append(perceive(graph.recognizers, frame, VoteFilter(1))))
    thread.start()
    try:
        assert entered.wait(3)
        graph.set_recognizer_enabled("target", False)
        graph.set_recognizer_enabled("target", True)
        release.set()
        thread.join(3)
        assert results == [{}]
    finally:
        release.set()
        thread.join(3)


def test_scope_refresh_cannot_call_disabled_template(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    graph = Graph.from_dict(
        {"recognizers": {"target": {"type": "template", "template": "absent.png", "enabled": False}}}, str(tmp_path)
    )
    engine = FlowEngine(graph, SyntheticController())
    recognizer = graph.recognizers["target"]
    calls: list[bool] = []
    monkeypatch.setattr(recognizer, "detect", lambda *_args, **_kwargs: calls.append(True))
    engine.detections["target"] = Detection("target", Rect(0, 0, 1, 1), state="confirmed")
    frame = Frame(np.zeros((8, 8, 3), dtype=np.uint8), size=(8, 8))
    engine._ensure_scope(frame, "target", "full")
    assert not calls
    assert not engine._hit("target")
    assert "target" not in engine.detections


@pytest.mark.parametrize("enabled", [None, 0, 1, "false", [], {}])
def test_enabled_is_strict_boolean(enabled: Any) -> None:
    with pytest.raises(ValueError, match="enabled"):
        Graph.from_dict({"recognizers": {"target": {"type": "color", "enabled": enabled}}}, "")


def test_default_enabled_and_persistence_preserve_references(tmp_path: Path) -> None:
    graph = Graph.from_dict(
        {"recognizers": {"target": {"type": "color"}}, "nodes": [{"id": "main", "enter": ["target"]}]},
        str(tmp_path),
        path=str(tmp_path / "graph.json"),
    )
    assert graph.recognizers["target"].enabled is True  # type: ignore[attr-defined]
    graph.set_recognizer_enabled("target", False)
    graph.save()
    loaded = Graph.load(str(tmp_path / "graph.json"))
    assert loaded.specs["target"]["enabled"] is False
    assert loaded.nodes["main"].enter == ["target"]
    loaded.set_recognizer_enabled("target", True)
    assert loaded.recognizers["target"].enabled is True  # type: ignore[attr-defined]


def test_explicit_workflow_root_does_not_toggle_newly_selected_project(tmp_path: Path) -> None:
    first = Project(root=str(tmp_path / "a")).ensure()
    second = Project(root=str(tmp_path / "b")).ensure()
    for project in (first, second):
        Graph.from_dict({"recognizers": {"target": {"type": "color"}}}, project.root, path=project.graph_path).save()
    server = RpcServer(io.StringIO(), io.StringIO())
    server.sessions.project = second
    result = server._handlers["recognizer.enabled"]({"workflowRoot": first.root, "label": "target", "enabled": False})
    assert result["enabled"] is False
    assert Graph.load(first.graph_path).specs["target"]["enabled"] is False
    assert Graph.load(second.graph_path).specs["target"].get("enabled", True) is True


@pytest.mark.parametrize("with_device", [True, False])
def test_rpc_toggle_running_graph_is_in_place_and_clears_old_hits(tmp_path: Path, with_device: bool) -> None:
    controller = SyntheticController()
    controller.connect()
    project = Project(root=str(tmp_path)).ensure()
    graph = Graph.from_dict(
        {"recognizers": {"target": {"type": "color"}, "other": {"type": "color"}}},
        str(tmp_path),
        path=project.graph_path,
    )
    graph.save()
    session = DeviceSession("synthetic:enabled", controller, project, lambda *_: None)
    server = RpcServer(io.StringIO(), io.StringIO())
    server.sessions.project = project
    server.sessions.sessions[session.device_id] = session
    engine = FlowEngine(session.graph, controller)
    engine.result = "running"
    engine.cursor = 17
    engine.detections["target"] = Detection("target", Rect(0, 0, 1, 1), score=1)
    engine._vote.update("target", True)
    engine._vote.update("other", True)
    runner = WorkflowRunner(session._root_key(project.root), session.graph, engine)
    session.runners[runner.root] = runner
    session.engine = engine
    session.running = True
    params: dict[str, Any] = {"label": "target", "enabled": False}
    if with_device:
        params["deviceId"] = session.device_id
    try:
        result = server._handlers["recognizer.enabled"](params)
        assert result["enabled"] is False
        assert result["graph"]["recognizers"]["target"]["enabled"] is False
        assert session.runners[runner.root] is runner
        assert session.engine is engine and engine.cursor == 17 and engine.result == "running"
        assert "target" not in engine.detections
        assert engine._vote.snapshot()["target"] == 0
        assert engine._vote.snapshot()["other"] == 1
        assert Graph.load(project.graph_path).specs["target"]["enabled"] is False
        params["enabled"] = True
        server._handlers["recognizer.enabled"](params)
        assert engine.graph.recognizers["target"].enabled is True  # type: ignore[attr-defined]
        assert session.engine is engine and engine.cursor == 17
    finally:
        session.stop()
