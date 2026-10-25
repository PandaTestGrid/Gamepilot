"""stdio JSON-RPC 服务：Tauri 壳通过子进程 stdin/stdout 与本模块通信。

信封与分帧（docs/rpc.md）：
- 请求：{"jsonrpc":"2.0","id":<int>,"method":"engine.ping","params":{...}}
- 响应：{"jsonrpc":"2.0","id":<int>,"result":{...}} | {"jsonrpc":"2.0","id":<int>,"error":{...}}
- 通知：{"jsonrpc":"2.0","method":"engine.ready","params":{...}}   ← 无 id

**铁律**：stdout 只能出现协议帧。任何调试输出、第三方库日志一律走 stderr，
否则前端会解析失败。日志用 `logging` 且 handler 指向 stderr。
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import platform
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import IO, Any

from .. import __version__
from ..protocol import (
    INTERNAL_ERROR,
    INVALID_REQUEST,
    METHOD_DIAGNOSTICS,
    METHOD_EVENTS_SUBSCRIBE,
    METHOD_INFO,
    METHOD_NOT_FOUND,
    METHOD_PING,
    METHOD_SHUTDOWN,
    NOTIFY_READY,
    PARSE_ERROR,
    PROTOCOL_VERSION,
)
from . import logs
from .event_notifications import EventNotifications
from .frame_notifications import FrameNotifications

logger = logging.getLogger("gamepilot.rpc")

Handler = Callable[[dict[str, Any]], dict[str, Any]]

#: 超过这个毫秒数就记一条 WARNING（正常 RPC 是毫秒级，几秒就是异常）。
#: 现场可调：GAMEPILOT_SLOW_RPC_MS=1000（排查时把门槛压低，看得更细）
SLOW_RPC_MS = int(os.environ.get("GAMEPILOT_SLOW_RPC_MS", "3000"))
#: 请求跑超过这个毫秒数就 dump 一次**所有线程栈** —— 这是"引擎卡在哪一行"唯一直接的手段
#: （以前只在设了 GAMEPILOT_STACK_DUMP 时才有，默认没有；现在默认就有）。
STUCK_RPC_MS = int(os.environ.get("GAMEPILOT_STUCK_RPC_MS", "10000"))
#: 还在卡着的请求，隔多久再 dump 一次栈
STUCK_REPEAT_MS = int(os.environ.get("GAMEPILOT_STUCK_REPEAT_MS", "30000"))


def dump_thread_stacks(reason: str) -> None:
    """把所有线程的 Python 栈打到 stderr（Rust 壳会转进应用日志）。

    "引擎 timeout / 不响应"这类问题，栈是唯一能直接指出卡在哪一行（哪个 adb 调用、哪个锁）的证据；
    py-spy 在 macOS 上要 root，所以用 stdlib 的 faulthandler 自曝。
    """
    import faulthandler

    stream = sys.stderr
    try:
        stream.write(f"\n=== {reason} ===\n")
        stream.flush()
    except Exception:
        stream = sys.__stderr__
    try:
        faulthandler.dump_traceback(file=stream)
    except Exception as exc:  # dump 失败不能影响主流程
        logger.warning("线程栈 dump 失败: %s", exc)


class RpcServer:
    """极简 JSON-RPC 2.0（NDJSON）服务端，只实现本项目需要的子集。"""

    def __init__(self, stdin: IO[str], stdout: IO[str]) -> None:
        self._stdin = stdin
        self._stdout = stdout
        self._write_lock = threading.Lock()  # 截图线程也会推通知，必须串行写
        self._handlers: dict[str, Handler] = {}
        self._stopping = False
        self._frame_notifications: FrameNotifications | None = None
        self._event_notifications: EventNotifications | None = None
        self._run_commands_lock = threading.Lock()
        self._run_commands: dict[tuple[str, str], object] = {}
        self._run_stop_intents: set[tuple[str, str]] = set()
        self._run_context = threading.local()
        self._register_builtin()
        # 延迟导入：devices 方法模块需要 RpcServer 的类型，反过来运行时依赖 stdio
        from . import devices as device_methods
        from . import session as session_methods
        from . import workflows as workflow_methods

        self.discovery = device_methods.register(self)
        self.sessions = session_methods.register(self)
        # workspace.* / workflow.* / project.get|set 集中在 workflows 模块里，
        # 显式传入 manager 而不是全局
        workflow_methods.register(self, self.sessions)

    def method(self, name: str) -> Callable[[Handler], Handler]:
        """装饰器：注册一个 RPC 方法。"""

        def wrapper(func: Handler) -> Handler:
            if name in self._handlers:
                raise ValueError(f"RPC 方法重复注册: {name}")
            self._handlers[name] = func
            return func

        return wrapper

    def _register_builtin(self) -> None:
        @self.method(METHOD_EVENTS_SUBSCRIBE)
        def _subscribe_events(params: dict[str, Any]) -> dict[str, Any]:
            if self._event_notifications is not None:
                self._event_notifications.enable_batches()
            return {"ok": True}

        @self.method(METHOD_PING)
        def _ping(params: dict[str, Any]) -> dict[str, Any]:
            _ = params
            return {"pong": True, "version": __version__, "protocol": PROTOCOL_VERSION, "ts": time.time()}

        @self.method(METHOD_DIAGNOSTICS)
        def _diagnostics(params: dict[str, Any]) -> dict[str, Any]:
            """跑不起来时先要这一份：引擎自己 + 这台机器的 adb 环境。

            别人的电脑上"引擎 timeout、日志什么都没有"几乎都在 adb 这一层（自带 adb 被杀软拦、
            5037 被模拟器/Android Studio 占、手机没授权、没有 USB 驱动）—— 这里一次问全。
            """
            _ = params
            from gamepilot.devices.env_report import adb_report
            from gamepilot.runtime_paths import (
                build_identity,
                bundled_adb_dir,
                frozen_bundle_root,
                vendor_scrcpy_server,
            )

            root = frozen_bundle_root()
            return {
                "engine": {
                    "version": __version__,
                    **build_identity(),
                    "protocol": PROTOCOL_VERSION,
                    "python": platform.python_version(),
                    "platform": platform.platform(),
                    "pid": os.getpid(),
                    "frozen": root is not None,
                    "bundleRoot": str(root) if root else None,
                },
                "adb": adb_report(),
                "paths": {
                    "adbDir": str(bundled_adb_dir()),
                    "scrcpyServer": str(vendor_scrcpy_server()),
                    "ocrModelDir": os.environ.get("GAMEPILOT_OCR_MODEL_DIR") or None,
                    "tempDir": tempfile.gettempdir(),
                    "cwd": os.getcwd(),
                },
            }

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
            # 兜底硬退：`serve_forever` 的主线程正卡在 stdin 的读上，而它只在读完一行之后
            # 才回头看这个标志 —— 标志可能是在那之后才被置上的（这条以前是靠竞态碰运气过的）。
            # 0.5s 足够把 {"ok": true} 响应写出去，然后**一定**退出。
            timer = threading.Timer(0.5, _exit_now, args=(self,))
            timer.daemon = True
            timer.start()
            return {"ok": True}

    def _write(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        with self._write_lock:
            self._stdout.write(line)
            self._stdout.flush()

    def _write_frame(self, payload: dict[str, Any], current: Callable[[], bool]) -> None:
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        with self._write_lock:
            if current():
                self._stdout.write(line)
                self._stdout.flush()

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        """主动推送通知（无 id）；运行时帧元数据只保留每设备最新一份。"""
        if self._frame_notifications is not None:
            if method == "engine.frame":
                self._frame_notifications.submit(params or {})
                return
            if method in ("device.disconnected", "device.connected", "device.failed"):
                self._frame_notifications.invalidate(str((params or {}).get("deviceId") or ""))
        if (
            self._event_notifications is not None
            and not self._event_notifications.batched
            and method == "engine.event"
            and str((params or {}).get("type", "")) in ("manual_input", "action_manual", "node_auto_created")
        ):
            self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})
            return
        if self._event_notifications is not None and method in (
            "engine.event",
            "device.connecting",
            "device.connected",
            "device.recovered",
            "run.started",
            "run.stopped",
            "run.resumed",
            "device.disconnected",
            "device.failed",
        ):
            self._event_notifications.submit(method, params or {})
            return
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
        started = time.monotonic()
        # 卡住看门狗：还在跑就先 dump 栈（会重复几次），这样壳那边报"超时"时，
        # 日志里已经有"卡在哪一行"的现场 —— 不用再等下一次复现
        stuck_watch: list[threading.Timer] = []
        watch_done = threading.Event()
        if STUCK_RPC_MS > 0:
            interval = STUCK_RPC_MS / 1000.0
            repeat = max(1.0, STUCK_REPEAT_MS / 1000.0)

            def _on_stuck() -> None:
                dump_thread_stacks(
                    f"RPC {method} 已跑 {time.monotonic() - started:.1f}s 还没返回（看下面哪个线程/哪一行在等）"
                )
                if not watch_done.is_set():
                    timer = threading.Timer(repeat, _on_stuck)
                    timer.daemon = True
                    stuck_watch.append(timer)
                    timer.start()

            first = threading.Timer(interval, _on_stuck)
            first.daemon = True
            stuck_watch.append(first)
            first.start()
        try:
            result = handler(raw_params)
        except Exception as exc:  # 任何 handler 异常都不能打死服务
            logger.exception("RPC 方法执行失败: %s", method)
            self._error(request_id, INTERNAL_ERROR, f"{type(exc).__name__}: {exc}")
            return
        finally:
            watch_done.set()
            for timer in stuck_watch:
                timer.cancel()
        elapsed_ms = (time.monotonic() - started) * 1000
        if SLOW_RPC_MS > 0 and elapsed_ms >= SLOW_RPC_MS:
            logger.warning("慢请求: %s 用了 %.1fs（正常是毫秒级；超时/卡死先看它）", method, elapsed_ms / 1000)

        if request_id is None:  # 通知：不需要响应
            return
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def run_command_current(self) -> bool:
        command = getattr(self._run_context, "command", None)
        if command is None:
            return True  # Direct handle_line calls (tests/embedded use) are synchronous.
        key, token = command
        with self._run_commands_lock:
            return self._run_commands.get(key) is token

    def take_run_stop_intent(self) -> bool:
        command = getattr(self._run_context, "command", None)
        if command is None:
            return False
        key, token = command
        with self._run_commands_lock:
            if self._run_commands.get(key) is not token:
                return False
            pending = key in self._run_stop_intents
            self._run_stop_intents.discard(key)
            return pending

    def _handle_queued_line(self, line: str, command: tuple[tuple[str, str], object] | None) -> None:
        self._run_context.command = command
        try:
            self.handle_line(line)
        finally:
            self._run_context.command = None
            if command is not None:
                key, token = command
                with self._run_commands_lock:
                    if self._run_commands.get(key) is token:
                        del self._run_commands[key]
                        self._run_stop_intents.discard(key)

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
        self._frame_notifications = FrameNotifications(self._write, guarded_write=self._write_frame)
        self._event_notifications = EventNotifications(self._write)
        # 停止不能排在推理预览/组件扫描/设备连接的共享队列后面。
        # 独立控制池只接收轻量控制方法；handler 仍走同一套协议校验/错误处理。
        with (
            ThreadPoolExecutor(max_workers=8, thread_name_prefix="rpc") as pool,
            ThreadPoolExecutor(max_workers=2, thread_name_prefix="rpc-control") as control,
        ):
            for line in self._stdin:
                target = pool
                command = None
                try:
                    envelope = json.loads(line)
                    if isinstance(envelope, dict):
                        method = envelope.get("method")
                        if method in ("run.stop", METHOD_PING):
                            target = control
                        params = envelope.get("params")
                        if method in ("run.start", "run.stop") and isinstance(params, dict):
                            device = params.get("deviceId")
                            root = params.get("workflowRoot", "")
                            if isinstance(device, str):
                                root = root.strip() if isinstance(root, str) else ""
                                if not root:
                                    with contextlib.suppress(ValueError):
                                        root = self.sessions.get(device).project.root
                                normalized = os.path.realpath(os.path.abspath(os.path.expanduser(root))) if root else ""
                                key = (device.strip(), os.path.normcase(normalized))
                                token = object()
                                with self._run_commands_lock:
                                    self._run_commands[key] = token
                                    if method == "run.stop":
                                        self._run_stop_intents.add(key)
                                command = (key, token)
                except (ValueError, TypeError):
                    pass  # handle_line 负责返回原有解析错误
                target.submit(self._handle_queued_line, line, command)
                if self._stopping:
                    break
        self._frame_notifications.close()
        # shutdown 后主线程原本还阻塞在 stdin 的 readline 上（客户端不再发消息就永远不退出，
        # 留下孤儿进程）。这里给响应留出 flush 时间后强制退出。
        # 退出前收掉设备会话：`os._exit` 不会跑任何清理，scrcpy 子进程会变成孤儿进程
        # （客户端窗口被杀、stdin 直接断开时也会走到这里）。
        self.discovery.stop()
        with contextlib.suppress(Exception):
            self.sessions.stop_all()
        self._event_notifications.close()
        self._event_notifications = None
        self._frame_notifications = None
        if self._stopping:
            time.sleep(0.2)
            logger.info("引擎退出（shutdown）")
            os._exit(0)
        logger.info("引擎退出")
        return 0


def _exit_now(server: RpcServer) -> None:
    """shutdown 的兜底出口：收掉设备会话（否则 scrcpy 子进程变孤儿）后硬退。"""
    server.discovery.stop()
    with contextlib.suppress(Exception):
        server.sessions.stop_all()
    logger.info("引擎退出（shutdown 兜底）")
    os._exit(0)


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
    from gamepilot.runtime_paths import configure_frozen_environment, configure_stdio_encoding

    configure_stdio_encoding()
    configure_frozen_environment()
    logging.basicConfig(
        level=os.environ.get("GAMEPILOT_LOG_LEVEL", "INFO").upper(),
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    _install_stack_dump()
    # 一行"我这一份引擎是谁"：装完新版还跑着旧引擎时（旧 exe 被占用导致安装跳过了它），看这行
    from gamepilot.runtime_paths import build_identity

    identity = build_identity()
    logger.info("引擎启动: %s（%s, %s）", identity["exePath"], identity["exeSize"], identity["exeMtime"])
    server = RpcServer(sys.stdin, sys.stdout)
    # 额外通道：日志照旧进 stderr，同时限频推 engine.log 给界面的「日志」抽屉
    logs.install(server)
    return server.serve_forever()


if __name__ == "__main__":
    raise SystemExit(main())
