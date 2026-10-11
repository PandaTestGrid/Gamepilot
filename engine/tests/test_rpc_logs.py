"""`engine.log` 通知：引擎日志进界面的「日志」抽屉。

覆盖三件事（docs/rpc.md 通知表 + CONVENTIONS §11.4）：
1. 记录 → `{level, logger, message, ts}` 通知；
2. **限频**：同 `(level, logger, message)` 窗口内只发一次；
3. **绝不反过来搞挂主流程**：handler 内部任何异常都吞掉。
"""

from __future__ import annotations

import io
import json
import logging
import time
from pathlib import Path
from typing import Any

import pytest

from gamepilot.protocol import NOTIFY_LOG
from gamepilot.rpc import logs
from gamepilot.rpc.stdio import RpcServer


class FakeServer:
    """假的 RPC server：只记账，不写任何流（真实实现是 `RpcServer`）。"""

    def __init__(self, *, explode: bool = False) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.explode = explode

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        if self.explode:
            raise RuntimeError("写协议流失败")
        self.calls.append((method, params or {}))


def _record(
    message: str, *, level: int = logging.INFO, name: str = "gamepilot.test", args: tuple[Any, ...] = ()
) -> logging.LogRecord:
    return logging.LogRecord(name=name, level=level, pathname=__file__, lineno=1, msg=message, args=args, exc_info=None)


def test_emit_pushes_structured_engine_log() -> None:
    server = FakeServer()
    handler = logs.NotifyLogHandler(server)

    before = time.time()
    handler.emit(_record("切换脚本目录: /tmp/alpha", level=logging.WARNING))
    after = time.time()

    assert len(server.calls) == 1
    method, params = server.calls[0]
    assert method == NOTIFY_LOG
    assert params["level"] == "WARNING"
    assert params["logger"] == "gamepilot.test"
    assert params["message"] == "切换脚本目录: /tmp/alpha"
    assert before <= params["ts"] <= after


def test_emit_formats_percent_args() -> None:
    server = FakeServer()
    logs.NotifyLogHandler(server).emit(_record("切到 %s（%d 个脚本）", args=("beta", 2)))

    assert server.calls[0][1]["message"] == "切到 beta（2 个脚本）"


def test_emit_throttles_same_message() -> None:
    server = FakeServer()
    handler = logs.NotifyLogHandler(server, throttle=0.05)

    handler.emit(_record("同一条"))
    handler.emit(_record("同一条"))
    assert len(server.calls) == 1, "窗口内同一条日志只发一次"

    # 不同 message / level / logger 各算一条
    handler.emit(_record("另一条"))
    handler.emit(_record("同一条", level=logging.ERROR))
    handler.emit(_record("同一条", name="gamepilot.other"))
    assert len(server.calls) == 4

    time.sleep(0.08)
    handler.emit(_record("同一条"))
    assert len(server.calls) == 5, "过了窗口可以再发"


def test_handler_never_raises() -> None:
    """写协议流失败、参数格式化失败……都不能把调用方（RPC / 截图线程）搞挂。"""
    handler = logs.NotifyLogHandler(FakeServer(explode=True))
    handler.emit(_record("写失败也不能抛"))
    handler.emit(_record("%d", args=("不是数字",)))  # getMessage() 会抛 TypeError，同样吞掉


def test_install_attaches_to_root_logger_and_pushes_to_the_protocol_stream(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GAMEPILOT_PROJECT_DIR", str(tmp_path / "default"))
    # 工作区与配置目录也隔离：测试不碰仓库 workspaces/、也不碰用户真实配置
    monkeypatch.setenv("GAMEPILOT_WORKSPACE_DIR", str(tmp_path / "workspaces" / "默认"))
    monkeypatch.setenv("GAMEPILOT_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("GAMEPILOT_LOG_LEVEL", "WARNING")
    out = io.StringIO()
    server = RpcServer(io.StringIO(), out)
    handler = logs.install(server)
    try:
        assert handler in logging.getLogger().handlers
        assert handler.level == logging.WARNING, "level 默认取 GAMEPILOT_LOG_LEVEL"

        logging.getLogger("gamepilot.test").warning("引擎说话了")

        payload = json.loads(out.getvalue().strip().splitlines()[-1])
    finally:
        logging.getLogger().removeHandler(handler)

    assert payload["jsonrpc"] == "2.0"
    assert "id" not in payload, "engine.log 是通知，不带 id"
    assert payload["method"] == NOTIFY_LOG
    assert payload["params"]["level"] == "WARNING"
    assert payload["params"]["logger"] == "gamepilot.test"
    assert payload["params"]["message"] == "引擎说话了"
