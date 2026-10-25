"""AI edit saves a new display label and material in one graph commit."""

from __future__ import annotations

import base64
import io
import threading
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pytest

from gamepilot.core.flow_engine import FlowEngine
from gamepilot.core.graph import Graph
from gamepilot.devices.synthetic_test import SyntheticController
from gamepilot.project import Project
from gamepilot.rpc.stdio import RpcServer
from gamepilot.session import DeviceSession, WorkflowRunner


def _session(tmp_path: Path) -> DeviceSession:
    project = Project(root=str(tmp_path)).ensure()
    cv2.imwrite(str(tmp_path / "templates" / "old_ai0.png"), np.zeros((8, 8, 3), dtype=np.uint8))
    Graph.from_dict(
        {
            "recognizers": {
                "old": {
                    "type": "yolo",
                    "classes": ["internal"],
                    "examples": [{"template": "templates/old_ai0.png", "rect": [0, 0, 1, 1], "label": "internal"}],
                }
            },
            "flow": {
                "steps": [
                    {"id": "start", "type": "manual", "params": {}},
                    {"id": "click", "type": "click", "params": {"rec": "old"}},
                ]
            },
        },
        str(tmp_path),
        path=project.graph_path,
    ).save()
    controller = SyntheticController()
    controller.connect()
    return DeviceSession("test:rename", controller, project, lambda *_: None)


def _spec() -> dict[str, Any]:
    return {"threshold": 0.6, "examples": [{"rect": [0.1, 0.1, 0.5, 0.5], "label": "internal"}]}


def test_update_renames_live_runner_once_and_can_edit_again(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    session = _session(tmp_path)
    engine = FlowEngine(session.graph, session.controller)
    engine.result = "running"
    engine.cursor = 1
    root = session._root_key(str(tmp_path))
    runner = WorkflowRunner(root, session.graph, engine)
    session.engine = engine
    session.runners[root] = runner
    session.running = True
    saves: list[bool] = []
    original = Graph.save

    def save(self: Graph, path: str | None = None) -> str:
        saves.append(True)
        return original(self, path)

    monkeypatch.setattr(Graph, "save", save)
    try:
        result = session.recognizer_update("old", _spec(), "new")
        assert result["label"] == "new"
        assert result["refs"]["flowSteps"] == 1
        assert saves == [True]
        assert session.engine is engine and engine.cursor == 1
        assert session.runners[root] is runner
        assert engine.graph.flow is not None
        assert engine.graph.flow["steps"][1]["params"]["rec"] == "new"
        assert engine.graph.recognizers["new"].label == "new"
        assert engine.graph.specs["new"]["classes"] == ["internal"]
        assert engine.graph.specs["new"]["examples"][0]["label"] == "internal"
        session.recognizer_update("new", _spec())
        persisted = Graph.load(session.project.graph_path)
        assert persisted.specs["new"]["examples"][0]["template"] == "templates/old_ai0.png"
        assert (tmp_path / "templates" / "old_ai0.png").is_file()
    finally:
        session.stop()


@pytest.mark.parametrize("shared", [False, True])
def test_renamed_new_image_cleans_only_unreferenced_old_file(tmp_path: Path, shared: bool) -> None:
    session = _session(tmp_path)
    if shared:
        graph = Graph.load(session.project.graph_path)
        graph.add_recognizer("shared", dict(graph.specs["old"]))
        graph.save()
    ok, encoded = cv2.imencode(".png", np.ones((8, 8, 3), dtype=np.uint8))
    assert ok
    spec = _spec()
    spec["examples"][0]["image"] = "data:image/png;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")
    try:
        result = session.recognizer_update("old", spec, "new")
        assert result["label"] == "new"
        assert (tmp_path / "templates" / "new_ai0.png").is_file()
        assert (tmp_path / "templates" / "old_ai0.png").exists() is shared
    finally:
        session.stop()


def test_conflict_rejected_before_template_write_or_save(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    session = _session(tmp_path)
    graph = Graph.load(session.project.graph_path)
    graph.add_recognizer("occupied", {"type": "color"})
    graph.save()
    before = Path(session.project.graph_path).read_bytes()
    calls: list[bool] = []
    monkeypatch.setattr(cv2, "imwrite", lambda *_: calls.append(True))
    try:
        with pytest.raises(ValueError, match="同名"):
            session.recognizer_update("old", _spec(), "occupied")
        assert not calls
        assert Path(session.project.graph_path).read_bytes() == before
        assert "old" in session.graph.specs
    finally:
        session.stop()


def test_rpc_update_and_rename_are_serialized(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    session = _session(tmp_path)
    server = RpcServer(io.StringIO(), io.StringIO())
    server.sessions.project = session.project
    server.sessions.sessions[session.device_id] = session
    entered = threading.Event()
    release = threading.Event()
    rename_started = threading.Event()
    rename_done = threading.Event()
    errors: list[BaseException] = []
    original = session.recognizer_update

    def update(*args: Any, **kwargs: Any) -> dict[str, Any]:
        result = original(*args, **kwargs)
        entered.set()
        assert release.wait(3)
        return result

    monkeypatch.setattr(session, "recognizer_update", update)

    def run_update() -> None:
        try:
            server._handlers["recognizer.update"](
                {"deviceId": session.device_id, "label": "old", "newLabel": "new", "spec": _spec()}
            )
        except BaseException as error:
            errors.append(error)

    def run_rename() -> None:
        rename_started.set()
        try:
            server._handlers["recognizer.rename"]({"deviceId": session.device_id, "label": "new", "to": "final"})
        except BaseException as error:
            errors.append(error)
        finally:
            rename_done.set()

    updating = threading.Thread(target=run_update)
    renaming = threading.Thread(target=run_rename)
    updating.start()
    try:
        assert entered.wait(3)
        renaming.start()
        assert rename_started.wait(3)
        assert not rename_done.wait(0.05)
        release.set()
        updating.join(3)
        renaming.join(3)
        assert not errors
        assert "final" in session.graph.specs
        assert session.graph.to_dict() == Graph.load(session.project.graph_path).to_dict()
    finally:
        release.set()
        updating.join(3)
        if renaming.ident is not None:
            renaming.join(3)
        session.stop()


def test_rpc_update_new_label_syncs_second_same_root_session(tmp_path: Path) -> None:
    first = _session(tmp_path)
    controller = SyntheticController()
    controller.connect()
    second = DeviceSession("test:second", controller, first.project, lambda *_: None)
    server = RpcServer(io.StringIO(), io.StringIO())
    server.sessions.sessions[first.device_id] = first
    server.sessions.sessions[second.device_id] = second
    try:
        result = server._handlers["recognizer.update"](
            {"deviceId": first.device_id, "label": "old", "newLabel": "new", "spec": _spec()}
        )
        assert result["label"] == "new"
        assert "new" in second.graph.specs and "old" not in second.graph.specs
    finally:
        first.stop()
        second.stop()
