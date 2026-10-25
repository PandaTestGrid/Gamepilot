"""stdio JSON-RPC 契约测试：不依赖任何真实设备，纯子进程往返。

这些测试是「前后端契约」的守门人：Rust 侧与 TS 侧都按 docs/rpc.md 实现，
一旦信封/分帧被改坏，这里必须先红。
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from typing import Any

import pytest

MODULE = "gamepilot.rpc"


def _spawn() -> subprocess.Popen[str]:
    # 当前脚本与工作区都指到临时目录：子进程绝不能碰仓库里的 workspaces/
    scratch = tempfile.mkdtemp(prefix="gamepilot-stdio-")
    return subprocess.Popen(
        [sys.executable, "-m", MODULE],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
        env={
            **os.environ,
            "GAMEPILOT_LOG_LEVEL": "WARNING",
            "GAMEPILOT_PROJECT_DIR": os.path.join(scratch, "default"),
            "GAMEPILOT_WORKSPACE_DIR": os.path.join(scratch, "workspaces", "默认"),
            "GAMEPILOT_CONFIG_DIR": os.path.join(scratch, "config"),
        },
    )


@contextlib.contextmanager
def engine_process() -> Iterator[subprocess.Popen[str]]:
    """拉起引擎并在退出时干净地关掉管道（否则 pytest 会把 ResourceWarning 当错误）。"""
    proc = _spawn()
    try:
        yield proc
    finally:
        with contextlib.suppress(Exception):
            if proc.stdin:
                proc.stdin.close()
        with contextlib.suppress(Exception):
            proc.wait(timeout=2)
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        for stream in (proc.stdout, proc.stderr):
            with contextlib.suppress(Exception):
                if stream:
                    stream.close()


def _send(proc: subprocess.Popen[str], payload: dict[str, Any]) -> None:
    assert proc.stdin is not None
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()


def _recv(proc: subprocess.Popen[str]) -> dict[str, Any]:
    assert proc.stdout is not None
    line = proc.stdout.readline()
    assert line, "引擎没有输出（进程可能已退出）"
    payload = json.loads(line)
    assert isinstance(payload, dict), f"协议帧必须是 JSON 对象: {line!r}"
    return payload


@pytest.fixture()
def engine() -> Iterator[subprocess.Popen[str]]:
    with engine_process() as proc:
        ready = _recv(proc)  # 启动即推送 engine.ready 通知
        assert ready["method"] == "engine.ready"
        assert ready["params"]["protocol"] >= 1
        yield proc


def test_ready_notification_has_no_id() -> None:
    """engine.ready 是通知：无 id，前端不请求也能收到「引擎已就绪」。"""
    with engine_process() as proc:
        ready = _recv(proc)
        assert ready["jsonrpc"] == "2.0"
        assert ready["method"] == "engine.ready"
        assert "id" not in ready


def test_ping_roundtrip(engine: subprocess.Popen[str]) -> None:
    _send(engine, {"jsonrpc": "2.0", "id": 1, "method": "engine.ping", "params": {}})
    response = _recv(engine)
    assert response["id"] == 1
    assert response["result"]["pong"] is True
    assert response["result"]["protocol"] >= 1


def test_info_lists_methods(engine: subprocess.Popen[str]) -> None:
    _send(engine, {"jsonrpc": "2.0", "id": 2, "method": "engine.info", "params": {}})
    result = _recv(engine)["result"]
    assert "engine.ping" in result["methods"]
    assert result["pid"] > 0
    assert result["protocol"] >= 1


def test_unknown_method_returns_method_not_found(engine: subprocess.Popen[str]) -> None:
    _send(engine, {"jsonrpc": "2.0", "id": 3, "method": "no.such.method", "params": {}})
    response = _recv(engine)
    assert response["id"] == 3
    assert response["error"]["code"] == -32601
    assert "engine.ping" in response["error"]["data"]["known"]


def test_bad_json_returns_parse_error(engine: subprocess.Popen[str]) -> None:
    assert engine.stdin is not None
    engine.stdin.write("{not json}\n")
    engine.stdin.flush()
    response = _recv(engine)
    assert response["error"]["code"] == -32700


def test_non_object_request_is_invalid(engine: subprocess.Popen[str]) -> None:
    assert engine.stdin is not None
    engine.stdin.write("[1, 2, 3]\n")
    engine.stdin.flush()
    assert _recv(engine)["error"]["code"] == -32600


def test_shutdown_exits_cleanly() -> None:
    with engine_process() as proc:
        assert _recv(proc)["method"] == "engine.ready"
        _send(proc, {"jsonrpc": "2.0", "id": 9, "method": "engine.shutdown", "params": {}})
        assert _recv(proc)["result"] == {"ok": True}
        assert proc.wait(timeout=5) == 0


def test_stdout_carries_only_protocol_frames(engine: subprocess.Popen[str]) -> None:
    """stdout 只能有协议帧：任何日志混进来都会让前端解析失败。"""
    assert engine.stdout is not None
    lines: list[str] = []
    for index in range(5):
        _send(engine, {"jsonrpc": "2.0", "id": 100 + index, "method": "engine.ping", "params": {}})
        lines.append(engine.stdout.readline())
    for line in lines:
        parsed = json.loads(line)  # 解析失败即测试失败
        assert parsed["jsonrpc"] == "2.0"
        assert "id" in parsed
