"""stdio JSON-RPC 服务：Tauri 壳通过子进程 stdin/stdout 与本模块通信。

信封与分帧（docs/rpc.md）：
- 请求：{"jsonrpc":"2.0","id":<int>,"method":"engine.ping","params":{...}}
- 响应：{"jsonrpc":"2.0","id":<int>,"result":{...}} | {"jsonrpc":"2.0","id":<int>,"error":{...}}
- 通知：{"jsonrpc":"2.0","method":"engine.ready","params":{...}}   ← 无 id

**铁律**：stdout 只能出现协议帧。任何调试输出、第三方库日志一律走 stderr，
否则前端会解析失败。日志用 `logging` 且 handler 指向 stderr。
"""

from __future__ import annotations

import json
import logging
import os
import platform
import sys
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import IO, Any

from .. import __version__
from ..protocol import (
    INTERNAL_ERROR,
    INVALID_REQUEST,
    METHOD_INFO,
    METHOD_NOT_FOUND,
    METHOD_PING,
    METHOD_SHUTDOWN,
    NOTIFY_READY,
    PARSE_ERROR,
    PROTOCOL_VERSION,
)
from . import logs

logger = logging.getLogger("gamepilot.rpc")

Handler = Callable[[dict[str, Any]], dict[str, Any]]


class RpcServer:
    """极简 JSON-RPC 2.0（NDJSON）服务端，只实现本项目需要的子集。"""

    def __init__(self, stdin: IO[str], stdout: IO[str]) -> None:
        self._stdin = stdin
        self._stdout = stdout
        self._write_lock = threading.Lock()  # 截图线程也会推通知，必须串行写
        self._handlers: dict[str, Handler] = {}
        self._stopping = False
        self._register_builtin()
        # 延迟导入：devices 方法模块需要 RpcServer 的类型，反过来运行时依赖 stdio
        from . import devices as device_methods
        from . import projects as project_methods
        from . import session as session_methods

        device_methods.register(self)
        self.sessions = session_methods.register(self)
        # project.* 集中在 projects 模块里（脚本库的库操作），显式传入 manager 而不是全局
        project_methods.register(self, self.sessions)

    # ------------------------------------------------------------------ #
    # 注册与分发
    # ------------------------------------------------------------------ #

    def method(self, name: str) -> Callable[[Handler], Handler]:
        """装饰器：注册一个 RPC 方法。"""

        def wrapper(func: Handler) -> Handler:
            if name in self._handlers:
                raise ValueError(f"RPC 方法重复注册: {name}")
            self._handlers[name] = func
            return func

        return wrapper

    def _register_builtin(self) -> None:
        @self.method(METHOD_PING)
        def _ping(params: dict[str, Any]) -> dict[str, Any]:
            _ = params
            return {"pong": True, "version": __version__, "protocol": PROTOCOL_VERSION, "ts": time.time()}

        @self.method(METHOD_INFO)
        def _info(params: dict[str, Any]) -> dict[str, Any]:
            _ = params
            return {
                "name": "gamepilot-engine",
                "version": __version__,
                "protocol": PROTOCOL_VERSION,
                "python": platform.python_version(),
                "platform": platform.platform(),
                "pid": os.getpid(),
                "methods": sorted(self._handlers),
            }

        @self.method(METHOD_SHUTDOWN)
        def _shutdown(params: dict[str, Any]) -> dict[str, Any]:
            _ = params
            self._stopping = True
            return {"ok": True}

    # ------------------------------------------------------------------ #
    # 收发
    # ------------------------------------------------------------------ #

    def _write(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        with self._write_lock:
            self._stdout.write(line)
            self._stdout.flush()

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        """主动推送通知（无 id）。"""
        self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def _error(self, request_id: Any, code: int, message: str, data: Any = None) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self._write({"jsonrpc": "2.0", "id": request_id, "error": error})

    def handle_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            self._error(None, PARSE_ERROR, f"JSON 解析失败: {exc}")
            return
        if not isinstance(request, dict):
            self._error(None, INVALID_REQUEST, "请求必须是 JSON 对象")
            return

        request_id = request.get("id")
        method = request.get("method")
        raw_params = request.get("params") or {}
        if not isinstance(method, str):
            self._error(request_id, INVALID_REQUEST, "缺少 method")
            return
        if not isinstance(raw_params, dict):
            self._error(request_id, INVALID_REQUEST, "params 必须是对象")
            return

        handler = self._handlers.get(method)
        if handler is None:
            self._error(request_id, METHOD_NOT_FOUND, f"未知方法: {method}", data={"known": sorted(self._handlers)})
            return
        try:
            result = handler(raw_params)
        except Exception as exc:  # 任何 handler 异常都不能打死服务
            logger.exception("RPC 方法执行失败: %s", method)
            self._error(request_id, INTERNAL_ERROR, f"{type(exc).__name__}: {exc}")
            return

        if request_id is None:  # 通知：不需要响应
            return
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    # ------------------------------------------------------------------ #
    # 主循环
    # ------------------------------------------------------------------ #

    def serve_forever(self) -> int:
        self.notify(
            NOTIFY_READY,
            {
                "version": __version__,
                "protocol": PROTOCOL_VERSION,
                "pid": os.getpid(),
                "methods": sorted(self._handlers),
            },
        )
        # 并发派发：单个慢 handler（比如 device.connect 要等首帧）不能堵死整个控制面。
        # 之前是串行处理，前端一个重试循环就能让引擎几十分钟不响应。
        with ThreadPoolExecutor(max_workers=8, thread_name_prefix="rpc") as pool:
            for line in self._stdin:
                pool.submit(self.handle_line, line)
                if self._stopping:
                    break
        # shutdown 后主线程原本还阻塞在 stdin 的 readline 上（客户端不再发消息就永远不退出，
        # 留下孤儿进程）。这里给响应留出 flush 时间后强制退出。
        if self._stopping:
            time.sleep(0.2)
            logger.info("引擎退出（shutdown）")
            os._exit(0)
        logger.info("引擎退出")
        return 0


def _install_stack_dump() -> None:
    """GAMEPILOT_STACK_DUMP=<秒> 时，定时把所有线程的 Python 栈打到 stderr。

    排查"引擎不响应/不推帧"这类卡死问题时，这是唯一能直接看到卡在哪一行的手段
    （py-spy 在 macOS 上要 root）。平时不设置这个变量就完全不生效。
    """
    import faulthandler

    seconds = os.environ.get("GAMEPILOT_STACK_DUMP")
    if not seconds:
        return
    try:
        faulthandler.dump_traceback_later(float(seconds), repeat=True, file=sys.stderr)
    except ValueError:
        logger.warning("GAMEPILOT_STACK_DUMP 需要是秒数，收到: %s", seconds)


def main() -> int:
    """stdio 入口：stdout 归协议，所有日志进 stderr。"""
    logging.basicConfig(
        level=os.environ.get("GAMEPILOT_LOG_LEVEL", "INFO").upper(),
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    _install_stack_dump()
    server = RpcServer(sys.stdin, sys.stdout)
    # 额外通道：日志照旧进 stderr，同时限频推 engine.log 给界面的「日志」抽屉
    logs.install(server)
    return server.serve_forever()


if __name__ == "__main__":
    raise SystemExit(main())
