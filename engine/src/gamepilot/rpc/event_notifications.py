"""Bounded event batching: preserve trace order without one GUI IPC per step."""

from __future__ import annotations

import threading
from collections import deque
from collections.abc import Callable
from typing import Any


class EventNotifications:
    def __init__(
        self, write: Callable[[dict[str, Any]], None], *, interval: float = 0.025, capacity: int = 4096
    ) -> None:
        self._write = write
        self._interval = interval
        self._capacity = capacity
        self._condition = threading.Condition()
        self._pending: deque[tuple[str, dict[str, Any]]] = deque()
        self._closed = False
        self._batched = False
        self._dropped = 0
        self._thread = threading.Thread(target=self._run, name="event-notifications", daemon=True)
        self._thread.start()

    @property
    def batched(self) -> bool:
        with self._condition:
            return self._batched

    def enable_batches(self) -> None:
        with self._condition:
            self._batched = True
            self._condition.notify_all()

    @staticmethod
    def _urgent(method: str, params: dict[str, Any]) -> bool:
        kind = str(params.get("type", ""))
        return method != "engine.event" or kind in ("flow_finished", "breakpoint_hit", "error") or "failed" in kind

    def submit(self, method: str, params: dict[str, Any]) -> None:
        # Never wait while the caller may own a session/lifecycle lock. On
        # overload, discard routine GUI telemetry (the evidence trace is separate)
        # and report the gap; reserve the bounded queue for critical transitions.
        with self._condition:
            if self._closed:
                return
            if len(self._pending) >= self._capacity:
                routine = next((i for i, item in enumerate(self._pending) if not self._urgent(*item)), None)
                if routine is not None:
                    del self._pending[routine]
                    self._dropped += 1
                elif not self._urgent(method, params):
                    self._dropped += 1
                    return
                else:
                    # Retain critical order in the pathological critical-only
                    # flood, without blocking stop on a session lock. Report the
                    # omission instead of silently promising lossless delivery.
                    self._pending.popleft()
                    self._dropped += 1
            self._pending.append((method, params))
            self._condition.notify_all()

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._condition.notify_all()
        self._thread.join(timeout=0.5)

    def _run(self) -> None:
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._closed or bool(self._pending))
                if not self._pending:
                    return
                if (
                    self._batched
                    and not self._closed
                    and len(self._pending) < 64
                    and not any(self._urgent(*item) for item in self._pending)
                ):
                    self._condition.wait_for(
                        lambda: (
                            self._closed
                            or len(self._pending) >= 64
                            or any(self._urgent(*item) for item in self._pending)
                        ),
                        timeout=self._interval,
                    )
                method, params = self._pending.popleft()
                batch = [params]
                batched = self._batched and method == "engine.event"
                if batched:
                    while self._pending and self._pending[0][0] == method and len(batch) < 64:
                        batch.append(self._pending.popleft()[1])
                dropped = self._dropped
                self._dropped = 0
                self._condition.notify_all()
            payload = {"events": batch} if batched else params
            try:
                if dropped:
                    self._write(
                        {
                            "jsonrpc": "2.0",
                            "method": "engine.log",
                            "params": {
                                "level": "warning",
                                "logger": "gamepilot.rpc.events",
                                "message": f"界面事件过载，已合并/省略 {dropped} 条旧通知；请查看运行证据 trace.jsonl",
                                "droppedEvents": dropped,
                            },
                        }
                    )
                self._write({"jsonrpc": "2.0", "method": "engine.events" if batched else method, "params": payload})
            except (OSError, ValueError):
                with self._condition:
                    self._closed = True
                    self._pending.clear()
                    self._condition.notify_all()
                return
