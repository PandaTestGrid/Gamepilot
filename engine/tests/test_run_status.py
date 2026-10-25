"""Authoritative run snapshots survive lost lifecycle notifications and view switches."""

from __future__ import annotations

import io
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from gamepilot.core.flow_engine import FlowEngine
from gamepilot.core.frame import Frame
from gamepilot.core.graph import Graph
from gamepilot.devices.synthetic_test import SyntheticController
from gamepilot.project import Project
from gamepilot.rpc.stdio import RpcServer
from gamepilot.session import DeviceSession, WorkflowRunner


@pytest.fixture()
def setup(tmp_path: Path) -> Iterator[tuple[RpcServer, DeviceSession, list[dict[str, Any]]]]:
    controller = SyntheticController()
    controller.connect()
    events: list[dict[str, Any]] = []
    session = DeviceSession(
        "synthetic:run-status",
        controller,
        Project(root=str(tmp_path / "viewed")).ensure(),
        lambda method, params: events.append(params) if method == "engine.frame" else None,
    )
    server = RpcServer(io.StringIO(), io.StringIO())
    server.sessions.sessions[session.device_id] = session
    try:
        yield server, session, events
    finally:
        session.stop()


def _runner(
    session: DeviceSession, root: Path, *, result: str, waiting: bool = False, inflight: bool = False
) -> WorkflowRunner:
    graph = Graph.empty(str(root))
    engine = FlowEngine(graph, session.controller)
    engine.result = result
    if waiting:
        engine.wait_for_subflow(str(root / "child"))
    runner = WorkflowRunner(session._root_key(str(root)), graph, engine)
    runner.inflight = inflight
    session.runners[runner.root] = runner
    return runner


def _snapshot(server: RpcServer, session: DeviceSession) -> dict[str, Any]:
    return server._handlers["run.status"]({"deviceId": session.device_id})


def test_status_is_authoritative_and_excludes_idle_runners(setup: Any, tmp_path: Path) -> None:
    server, session, _events = setup
    _runner(session, tmp_path / "idle", result="idle")
    _runner(session, tmp_path / "done", result="success")
    active = _runner(session, tmp_path / "background", result="running")
    waiting = _runner(session, tmp_path / "parent", result="running", waiting=True)
    inflight = _runner(session, tmp_path / "finishing", result="cancelled", inflight=True)
    session.running = False  # Cached flags are not an authoritative root inventory.
    payload = _snapshot(server, session)
    assert payload == {
        "deviceId": session.device_id,
        "workflowRoot": session._root_key(session.project.root),
        "runningWorkflowRoots": [active.root, waiting.root, inflight.root],
        "runRevision": 0,
        "running": True,
    }
    with session.lock:
        session.runners.clear()
    session.running = True
    assert _snapshot(server, session)["runningWorkflowRoots"] == []
    assert _snapshot(server, session)["running"] is False


def test_frame_and_status_expose_same_background_roots_after_view_switch(setup: Any, tmp_path: Path) -> None:
    server, session, events = setup
    active = _runner(session, tmp_path / "running-original", result="running")
    _runner(session, tmp_path / "idle", result="idle")
    session.project = Project(root=str(tmp_path / "other-view")).ensure()
    frame = Frame(np.zeros((8, 16, 3), dtype=np.uint8), size=(16, 8), index=4, ts=1.0)
    session._emit_frame(frame, [])
    snapshot = _snapshot(server, session)
    assert events[-1]["workflowRoot"] == snapshot["workflowRoot"] == session._root_key(session.project.root)
    assert events[-1]["runningWorkflowRoots"] == snapshot["runningWorkflowRoots"] == [active.root]
    assert events[-1]["running"] is snapshot["running"] is True
    with session.lock:
        session.runners.clear()
    session._emit_frame(frame, [])
    assert events[-1]["runningWorkflowRoots"] == []
    assert events[-1]["running"] is False


def test_status_does_not_wait_for_lifecycle_or_execution_lock(setup: Any) -> None:
    server, session, _events = setup
    entered = threading.Event()
    finished = threading.Event()
    errors: list[BaseException] = []

    def status() -> None:
        entered.set()
        try:
            assert _snapshot(server, session)["running"] is False
        except BaseException as error:
            errors.append(error)
        finally:
            finished.set()

    with session._lifecycle_lock, session._execution_lock:
        thread = threading.Thread(target=status)
        thread.start()
        assert entered.wait(3)
        completed_without_execution = finished.wait(3)
    thread.join(3)
    assert completed_without_execution, "run.status must not wait for lifecycle/execution I/O"
    assert not thread.is_alive()
    assert not errors


def _prepare_flow(session: DeviceSession) -> None:
    graph = Graph.empty(session.project.root, path=session.project.graph_path)
    graph.flow = {
        "steps": [
            {"id": "start", "type": "manual", "params": {}},
            {"id": "wait", "type": "delay", "params": {"ms": 10000}},
        ]
    }
    graph.defaults["evidence"] = False
    graph.save()
    session.reload_graph()


def test_revisions_increase_for_start_stop_restart_and_natural_completion(setup: Any) -> None:
    server, session, _events = setup
    _prepare_flow(session)
    notifications: list[tuple[str, dict[str, Any]]] = []
    session.emit = lambda method, params: notifications.append((method, params))
    assert _snapshot(server, session)["runRevision"] == 0
    session.start_run()
    root = session._root_key(session.project.root)
    first = session.runners[root]
    assert notifications[-1][0] == "run.started"
    assert notifications[-1][1]["runRevision"] == 1
    session.stop_run()
    assert notifications[-1][0] == "run.stopped"
    assert notifications[-1][1]["runRevision"] == 2
    session.stop_run()  # No state change means no revision or duplicate event.
    assert _snapshot(server, session)["runRevision"] == 2
    session.start_run()
    assert notifications[-1][1]["runRevision"] == 3
    current = session.runners[root]
    assert current is not first
    session._complete_run(root, "success", expected=first)
    assert _snapshot(server, session)["runRevision"] == 3
    session._complete_run(root, "success", expected=current)
    payload = _snapshot(server, session)
    assert payload["runRevision"] == 4
    assert payload["runningWorkflowRoots"] == []
    assert notifications[-1][1]["runRevision"] == 4


def test_frame_retains_matching_old_revision_when_delivery_is_delayed_past_stop(setup: Any) -> None:
    server, session, _events = setup
    _prepare_flow(session)
    session.start_run()
    captured = threading.Event()
    release = threading.Event()
    delivered: list[tuple[str, dict[str, Any]]] = []
    errors: list[BaseException] = []

    def emit(method: str, params: dict[str, Any]) -> None:
        if method == "engine.frame":
            captured.set()
            assert release.wait(3)
        delivered.append((method, params))

    session.emit = emit
    frame = Frame(np.zeros((8, 16, 3), dtype=np.uint8), size=(16, 8), index=1, ts=1.0)

    def publish() -> None:
        try:
            session._emit_frame(frame, [])
        except BaseException as error:
            errors.append(error)

    thread = threading.Thread(target=publish)
    thread.start()
    try:
        assert captured.wait(3)
        # Frame has released the short state lock before entering delivery. Stop
        # commits and emits independently; the delayed frame must keep revision 1.
        session.stop_run()
        stopped = delivered[-1][1]
        assert stopped["runRevision"] == 2
        release.set()
        thread.join(3)
        assert not thread.is_alive()
        assert not errors
        delayed = delivered[-1][1]
        assert delivered[-1][0] == "engine.frame"
        assert delayed["runRevision"] == 1
        assert delayed["runningWorkflowRoots"] == [session._root_key(session.project.root)]
        assert _snapshot(server, session)["runRevision"] == 2
        assert _snapshot(server, session)["runningWorkflowRoots"] == []
    finally:
        release.set()
        thread.join(3)
