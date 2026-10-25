"""Event-gated RPC ordering regressions; no capture workers or timing thresholds."""

from __future__ import annotations

import io
import json
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from gamepilot.core.flow_engine import FlowEngine
from gamepilot.core.graph import Graph
from gamepilot.devices.synthetic_test import SyntheticController
from gamepilot.rpc import stdio
from gamepilot.rpc.stdio import RpcServer

_TIMEOUT = 5.0


class _Session:
    """Minimal lifecycle state; actual registered handlers and FlowEngine cancellation."""

    def __init__(self, root: str) -> None:
        self.project = SimpleNamespace(root=root)
        self._lifecycle_lock = threading.RLock()
        self.controller = SyntheticController()
        self.runners: dict[str, Any] = {}
        self.running = True
        self.calls: list[tuple[str, Any]] = []
        self.runners[root] = self.new_runner()

    def new_runner(self) -> Any:
        return SimpleNamespace(engine=FlowEngine(Graph.empty(self.project.root), self.controller))

    def _root_key(self, root: str) -> str:
        return root

    def _subflow_descendants(self, _root: str) -> list[str]:
        return []

    def stop_run(self, workflow_root: str | None = None) -> None:
        root = workflow_root or self.project.root
        previous = self.runners.pop(root, None)
        self.calls.append(("stop", previous))
        self.running = False

    def start_run(self, from_step_id: str | None = None, workflow_root: str | None = None) -> None:
        root = workflow_root or self.project.root
        if root in self.runners:
            raise RuntimeError("旧 runner 尚未回收")
        runner = self.new_runner()
        self.runners[root] = runner
        self.calls.append(("start", (runner, from_step_id)))
        self.running = True


def _setup(tmp_path: Path) -> tuple[RpcServer, _Session, tuple[str, str]]:
    server = RpcServer(io.StringIO(), io.StringIO())
    session = _Session(str(tmp_path))
    server.sessions.sessions["test:ordering"] = session  # type: ignore[assignment]
    return server, session, ("test:ordering", str(tmp_path))


def _stop_thread(
    server: RpcServer, key: tuple[str, str], token: object
) -> tuple[threading.Thread, list[Any], list[BaseException]]:
    results: list[Any] = []
    errors: list[BaseException] = []

    def stop() -> None:
        server._run_context.command = (key, token)
        try:
            results.append(server._handlers["run.stop"]({"deviceId": key[0], "workflowRoot": key[1]}))
        except BaseException as error:
            errors.append(error)
        finally:
            server._run_context.command = None

    thread = threading.Thread(target=stop, name="old-stop")
    thread.start()
    return thread, results, errors


def test_new_start_retires_old_runner_after_stop_signal_before_stop_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    server, session, key = _setup(tmp_path)
    old = session.runners[key[1]]
    signalled = threading.Event()
    release = threading.Event()
    request_stop = old.engine.request_stop

    def stop_then_block() -> None:
        request_stop()
        if threading.current_thread().name == "old-stop":
            signalled.set()
            assert release.wait(_TIMEOUT)

    monkeypatch.setattr(old.engine, "request_stop", stop_then_block)
    old_token = object()
    server._run_commands[key] = old_token
    thread, results, errors = _stop_thread(server, key, old_token)
    try:
        assert signalled.wait(_TIMEOUT)
        assert old.engine._stop_requested.is_set()
        new_token = object()
        with server._run_commands_lock:
            server._run_commands[key] = new_token
        server._run_context.command = (key, new_token)
        result = server._handlers["run.start"]({"deviceId": key[0], "workflowRoot": key[1], "stepId": "resume-here"})
        new = session.runners[key[1]]
        assert new is not old
        assert not new.engine._stop_requested.is_set()
        assert result["running"] is True
        assert session.calls == [("stop", old), ("start", (new, "resume-here"))]
        release.set()
        thread.join(_TIMEOUT)
        assert not thread.is_alive()
        assert not errors
        assert results[0]["superseded"] is True
        assert session.runners[key[1]] is new
        assert not new.engine._stop_requested.is_set()
        assert session.running
    finally:
        release.set()
        thread.join(_TIMEOUT)
        server._run_context.command = None


def test_stale_stop_snapshot_cannot_cancel_replacement_runner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    server, session, key = _setup(tmp_path)
    old = session.runners[key[1]]
    checked = threading.Event()
    release = threading.Event()
    original_current = server.run_command_current
    checks = 0

    def check_then_block() -> bool:
        nonlocal checks
        current = original_current()
        if threading.current_thread().name == "old-stop":
            checks += 1
            if checks == 1:
                checked.set()
                assert release.wait(_TIMEOUT)
        return current

    monkeypatch.setattr(server, "run_command_current", check_then_block)
    old_token = object()
    server._run_commands[key] = old_token
    thread, results, errors = _stop_thread(server, key, old_token)
    try:
        assert checked.wait(_TIMEOUT)
        # The old stop has taken its runner snapshot and checked its token. A newer
        # generation replaces that runner before the old stop performs cancellation.
        new = session.new_runner()
        with server._run_commands_lock:
            server._run_commands[key] = object()
        with session._lifecycle_lock:
            session.runners[key[1]] = new
        release.set()
        thread.join(_TIMEOUT)
        assert not thread.is_alive()
        assert not errors
        assert results[0]["superseded"] is True
        assert old.engine._stop_requested.is_set()
        assert not new.engine._stop_requested.is_set()
        assert session.runners[key[1]] is new
        assert session.calls == []
    finally:
        release.set()
        thread.join(_TIMEOUT)


def test_stdio_new_start_consumes_stop_intent_before_old_stop_can_signal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Queue both actual stdio envelopes, then deterministically execute ordinary
    # pool start before control-pool stop. No sleeps or worker scheduling guesses.
    server, session, _key = _setup(tmp_path)
    old = session.runners[str(tmp_path)]
    queued: dict[str, list[tuple[Any, tuple[Any, ...]]]] = {"rpc": [], "rpc-control": []}
    responses: list[dict[str, Any]] = []

    class DeferredPool:
        def __init__(self, *, max_workers: int, thread_name_prefix: str) -> None:
            self.name = thread_name_prefix

        def __enter__(self) -> DeferredPool:
            return self

        def __exit__(self, *_args: Any) -> None:
            pass

        def submit(self, function: Any, *args: Any) -> None:
            queued[self.name].append((function, args))

    def request(request_id: int, method: str) -> str:
        return (
            json.dumps(
                {
                    "id": request_id,
                    "method": method,
                    "params": {"deviceId": "test:ordering", "workflowRoot": str(tmp_path)},
                }
            )
            + "\n"
        )

    def input_lines() -> Any:
        yield request(1, "run.stop")
        yield request(2, "run.start")
        assert len(queued["rpc-control"]) == len(queued["rpc"]) == 1
        assert not old.engine._stop_requested.is_set(), "stop is queued but has not executed"
        function, args = queued["rpc"].pop()
        function(*args)
        assert session.runners[str(tmp_path)] is not old
        assert session.running
        function, args = queued["rpc-control"].pop()
        function(*args)

    monkeypatch.setattr(stdio, "ThreadPoolExecutor", DeferredPool)
    monkeypatch.setattr(server, "_write", responses.append)
    monkeypatch.setattr(server.discovery, "stop", lambda: None)
    monkeypatch.setattr(server.sessions, "stop_all", lambda: None)
    server._stdin = input_lines()
    assert server.serve_forever() == 0
    by_id = {item["id"]: item for item in responses if "id" in item}
    assert "error" not in by_id[2], by_id[2]
    assert by_id[2]["result"]["running"] is True
    assert by_id[1]["result"]["superseded"] is True
    new = session.runners[str(tmp_path)]
    assert session.calls == [("stop", old), ("start", (new, None))]
    assert not new.engine._stop_requested.is_set()
    assert not server._run_stop_intents
    assert not server._run_commands
