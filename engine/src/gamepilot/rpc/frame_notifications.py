"""Bounded latest-only frame metadata publishing, independent of capture threads."""

from __future__ import annotations

import threading
from collections.abc import Callable
from functools import partial
from typing import Any


class FrameNotifications:
    """One pending notification per device; never let stdout backpressure stop capture.

    This does not preempt an already blocked stdout write. It bounds pending frame
    work so control replies compete with at most one publisher, not every camera.
    """

    def __init__(
        self,
        write: Callable[[dict[str, Any]], None],
        *,
        max_devices: int = 64,
        guarded_write: Callable[[dict[str, Any], Callable[[], bool]], None] | None = None,
    ) -> None:
        self._write = write
        self._guarded_write = guarded_write
        self._max_devices = max_devices
        self._condition = threading.Condition()
        self._pending: dict[str, dict[str, Any]] = {}
        self._generations: dict[str, object] = {}
        self._closed = False
        self._thread = threading.Thread(target=self._run, name="frame-notifications", daemon=True)
        self._thread.start()

    def submit(self, params: dict[str, Any]) -> None:
        device = str(params.get("deviceId") or "")
        with self._condition:
            if self._closed:
                return
            if device not in self._pending and len(self._pending) >= self._max_devices:
                del self._pending[next(iter(self._pending))]
            self._generations.setdefault(device, object())
            self._pending[device] = params
            self._condition.notify()

    def invalidate(self, device: str) -> None:
        with self._condition:
            self._pending.pop(device, None)
            self._generations.pop(device, None)

    def _current(self, device: str, generation: object) -> bool:
        with self._condition:
            return not self._closed and self._generations.get(device) is generation

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._pending.clear()
            self._condition.notify_all()
        self._thread.join(timeout=0.2)

    def _run(self) -> None:
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._closed or bool(self._pending))
                if self._closed:
                    return
                device = next(iter(self._pending))
                params = self._pending.pop(device)
                generation = self._generations[device]
            try:
                payload = {"jsonrpc": "2.0", "method": "engine.frame", "params": params}
                if self._guarded_write is not None:
                    self._guarded_write(payload, partial(self._current, device, generation))
                elif self._current(device, generation):
                    self._write(payload)
            except (OSError, ValueError):
                with self._condition:
                    self._closed = True
                    self._pending.clear()
                return
