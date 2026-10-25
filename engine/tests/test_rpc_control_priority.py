"""Stop must get dispatched while all eight ordinary RPC workers are occupied."""

from __future__ import annotations

import io
import json
import threading
from pathlib import Path
from typing import Any

import pytest

from gamepilot.rpc.stdio import RpcServer


def test_stop_and_ping_bypass_saturated_rpc_pool(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    monkeypatch.setenv("GAMEPILOT_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("GAMEPILOT_CONFIG_DIR", str(tmp_path))
    release = threading.Event()
    saturated = threading.Event()
    stopped = threading.Event()
    pinged = threading.Event()
    count = 0
    lock = threading.Lock()

    def request(method: str, index: int) -> str:
        return json.dumps({"jsonrpc": "2.0", "id": index, "method": method, "params": {}}) + "\n"

    def incoming() -> Any:
        for index in range(8):
            yield request("test.blocked", index)
        assert saturated.wait(2), "ordinary worker pool did not saturate"
        yield request("run.stop", 10)
        yield request("engine.ping", 11)
        assert stopped.wait(1), "stop queued behind slow ordinary RPCs"
        assert pinged.wait(1), "ping queued behind slow ordinary RPCs"
        release.set()

    server = RpcServer(io.StringIO(), io.StringIO())
    server._stdin = incoming()

    def blocked(params: dict[str, Any]) -> dict[str, Any]:
        nonlocal count
        with lock:
            count += 1
            if count == 8:
                saturated.set()
        release.wait(5)
        return {}

    def stop(params: dict[str, Any]) -> dict[str, Any]:
        stopped.set()
        return {"ok": True}

    def ping(params: dict[str, Any]) -> dict[str, Any]:
        pinged.set()
        return {"pong": True}

    server._handlers["test.blocked"] = blocked
    server._handlers["run.stop"] = stop
    server._handlers["engine.ping"] = ping
    try:
        assert server.serve_forever() == 0
    finally:
        release.set()


@pytest.mark.parametrize("start_root", ["explicit", "omitted", "whitespace", "relative", "null", "number"])
def test_priority_stop_invalidates_queued_real_start(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, start_root: str
) -> None:
    monkeypatch.setenv("GAMEPILOT_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("GAMEPILOT_CONFIG_DIR", str(tmp_path))
    server = RpcServer(io.StringIO(), io.StringIO())
    release = threading.Event()
    saturated = threading.Event()
    stopped = threading.Event()
    count = 0
    count_lock = threading.Lock()

    class Session:
        def __init__(self) -> None:
            self._lifecycle_lock = threading.RLock()
            self.runners: dict[str, Any] = {}
            self.running = False
            self.project = type("Project", (), {"root": str(tmp_path)})()

        def _root_key(self, root: str) -> str:
            return root

        def _subflow_descendants(self, root: str) -> list[str]:
            return []

        def start_run(self, **kwargs: Any) -> None:
            self.running = True

        def stop_run(self, root: str | None) -> None:
            self.running = False
            stopped.set()

    session = Session()
    monkeypatch.setattr(server.sessions, "get", lambda _: session)

    def blocked(params: dict[str, Any]) -> dict[str, Any]:
        nonlocal count
        with count_lock:
            count += 1
            if count == 8:
                saturated.set()
        release.wait(5)
        return {}

    def request(method: str, index: int) -> str:
        return (
            json.dumps(
                {
                    "id": index,
                    "jsonrpc": "2.0",
                    "method": method,
                    "params": {"deviceId": "device", "workflowRoot": str(tmp_path)},
                }
            )
            + "\n"
        )

    def incoming() -> Any:
        for index in range(8):
            yield request("test.blocked", index)
        assert saturated.wait(2)
        params: dict[str, Any] = {"deviceId": "device"}
        if start_root == "explicit":
            params["workflowRoot"] = str(tmp_path)
        elif start_root == "whitespace":
            params["workflowRoot"] = f"  {tmp_path}  "
        elif start_root == "relative":
            monkeypatch.chdir(tmp_path)
            params["workflowRoot"] = "."
        elif start_root == "null":
            params["workflowRoot"] = None
        elif start_root == "number":
            params["workflowRoot"] = 123
        yield json.dumps({"id": 20, "jsonrpc": "2.0", "method": "run.start", "params": params}) + "\n"
        yield request("run.stop", 21)
        assert stopped.wait(1)
        release.set()

    server._handlers["test.blocked"] = blocked
    server._stdin = incoming()
    try:
        server.serve_forever()
    finally:
        release.set()
    assert not session.running, "start queued before stop must not resurrect the runner"
    assert not server._run_commands
