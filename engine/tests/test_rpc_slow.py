"""引擎的"慢/卡住"自曝：别人电脑上只看到"超时"，看不到原因 —— 这里守住两条。

1. 慢请求（默认 ≥3s）写一条 WARNING，带上方法名与耗时；
2. 还卡着的请求（默认 ≥10s）自动 dump **所有线程栈** 到 stderr（Rust 壳会转进应用日志）——
   这是"卡在哪一行"唯一直接的手段。

阈值都能用环境变量压低（GAMEPILOT_SLOW_RPC_MS / GAMEPILOT_STUCK_RPC_MS），这里靠 monkeypatch。
"""

from __future__ import annotations

import json
import sys
import time
from typing import Any

import pytest

from gamepilot.rpc import stdio


def _server(handler_body: Any) -> stdio.RpcServer:
    server = stdio.RpcServer(sys.stdin, sys.stdout)

    @server.method("test.slow")
    def _slow(params: dict[str, Any]) -> dict[str, Any]:
        _ = params
        handler_body()
        return {"ok": True}

    return server


def test_slow_request_logs_warning(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setattr(stdio, "SLOW_RPC_MS", 30)
    monkeypatch.setattr(stdio, "STUCK_RPC_MS", 0)  # 这条只测慢请求
    server = _server(lambda: time.sleep(0.1))

    with caplog.at_level("WARNING", logger="gamepilot.rpc"):
        server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "test.slow", "params": {}}))

    messages = [record.getMessage() for record in caplog.records]
    assert any("慢请求" in message and "test.slow" in message for message in messages), messages


def test_stuck_request_dumps_thread_stacks(monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(stdio, "SLOW_RPC_MS", 0)
    monkeypatch.setattr(stdio, "STUCK_RPC_MS", 50)  # 50ms 就当成"卡住"
    monkeypatch.setattr(stdio, "STUCK_REPEAT_MS", 1000)
    server = _server(lambda: time.sleep(0.35))

    server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "test.slow", "params": {}}))

    captured = capfd.readouterr()
    # faulthandler 直接写 fd，capfd 抓得到；栈里必须点名卡在哪个函数
    assert "test.slow" in captured.err
    assert "test_rpc_slow.py" in captured.err
    # 真正卡住的帧要在里面（handler 叫 _slow，lambda 是它的 body）
    assert "_slow" in captured.err


def test_fast_request_stays_quiet(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setattr(stdio, "SLOW_RPC_MS", 500)
    monkeypatch.setattr(stdio, "STUCK_RPC_MS", 5000)
    server = _server(lambda: None)

    with caplog.at_level("WARNING", logger="gamepilot.rpc"):
        server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 3, "method": "test.slow", "params": {}}))

    assert not [record for record in caplog.records if "慢请求" in record.getMessage()]
