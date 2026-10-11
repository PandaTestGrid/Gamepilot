"""引擎日志 → 界面的通知通道（`engine.log`）。

契约（docs/rpc.md 通知表）：`engine.log` 的 params =
`{level, logger, message, ts}`，`level` 是 `DEBUG` / `INFO` / `WARNING` / `ERROR`。
日志**照旧进 stderr**（`stdio.main` 里的 basicConfig 不动），这条通知只是额外通道，
给界面的「日志」抽屉用 —— 不带 `id`，也不期待任何响应。

三条硬约束：

1. **限频**：同 `(level, logger, message)` 在 200ms 内只发一次（CONVENTIONS §11.4：
   高频通知必须限频或聚合）；
2. **绝不能反过来搞挂主流程**：handler 内部任何异常都吞掉；也不会在本 handler 里
   再写日志（否则一条日志能引出无限递归）；
3. 不引入第三方依赖，只用 stdlib。
"""

from __future__ import annotations

import contextlib
import logging
import os
import threading
import time
from typing import TYPE_CHECKING, Any, Protocol

from ..protocol import NOTIFY_LOG

if TYPE_CHECKING:  # 避免循环导入
    from .stdio import RpcServer

# 同一条日志的限频窗口（秒）
THROTTLE_SECONDS = 0.2
# 限频表的容量上限：满了顺手清掉过期项，长跑时不会无限增长
_MAX_TRACKED = 512


class Notifier(Protocol):
    """能把通知写出去的东西（真实实现是 `RpcServer`，测试里可以用假对象）。"""

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None: ...


class NotifyLogHandler(logging.Handler):
    """把日志记录转成 `engine.log` 通知（限频 + 全异常吞掉 + 防递归）。"""

    def __init__(self, server: Notifier, *, throttle: float = THROTTLE_SECONDS) -> None:
        super().__init__()
        self._server = server
        self._throttle = throttle
        self._last: dict[tuple[str, str, str], float] = {}
        self._lock = threading.Lock()
        # 防递归：notify 期间（写协议流）又产生的日志不再往下发
        self._local = threading.local()

    def emit(self, record: logging.LogRecord) -> None:
        with contextlib.suppress(Exception):  # 推日志失败绝不能影响调用方
            self._notify(record)

    def _notify(self, record: logging.LogRecord) -> None:
        if getattr(self._local, "busy", False):
            return
        self._local.busy = True
        try:
            message = record.getMessage()
            if not self._allow(record.levelname, record.name, message):
                return
            self._server.notify(
                NOTIFY_LOG,
                {
                    "level": record.levelname,
                    "logger": record.name,
                    "message": message,
                    "ts": time.time(),
                },
            )
        finally:
            self._local.busy = False

    def _allow(self, level: str, logger_name: str, message: str) -> bool:
        """限频：同 `(level, logger, message)` 在窗口内只放行一次。"""
        now = time.monotonic()
        key = (level, logger_name, message)
        with self._lock:
            previous = self._last.get(key)
            if previous is not None and now - previous < self._throttle:
                return False
            if len(self._last) >= _MAX_TRACKED:
                cutoff = now - self._throttle
                for stale in [item for item, seen in self._last.items() if seen < cutoff]:
                    del self._last[stale]
            self._last[key] = now
            return True


def _env_level() -> int:
    """`GAMEPILOT_LOG_LEVEL`（与 stderr 日志同一档），缺省 INFO。"""
    raw = os.environ.get("GAMEPILOT_LOG_LEVEL", "INFO").strip().upper()
    value = logging.getLevelNamesMapping().get(raw)
    return value if isinstance(value, int) else logging.INFO


def install(server: RpcServer, *, level: int | None = None) -> NotifyLogHandler:
    """把 `NotifyLogHandler` 挂到 root logger 上，返回它（测试里可 `removeHandler` 卸载）。

    level 默认取 `GAMEPILOT_LOG_LEVEL`；handler 的 limit 与 stderr 日志同一档，
    所以界面看到的就是 stderr 里那些行（额外多一层限频）。
    """
    handler = NotifyLogHandler(server)
    handler.setLevel(_env_level() if level is None else level)
    logging.getLogger().addHandler(handler)
    return handler


__all__ = ["THROTTLE_SECONDS", "Notifier", "NotifyLogHandler", "install"]
