"""RPC 发现入口：读取缓存；Android 持续监听，其余来源按需在后台刷新。"""

from __future__ import annotations

import contextlib
import copy
import threading
import time
from collections.abc import Callable
from typing import Any

from . import _providers
from .android_discovery import AndroidDiscovery
from .base import ScanResult

REFRESH_SECONDS = 1.0


class DeviceDiscovery:
    def __init__(self, on_change: Callable[[str], None]) -> None:
        self._on_change = on_change
        self._android = AndroidDiscovery(lambda: self._changed("android"))
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._results: dict[str, ScanResult] = {}
        self._pending = False
        self._refreshing = False
        self._refreshed = 0.0

    def _changed(self, provider: str) -> None:
        if not self._stop.is_set():
            with contextlib.suppress(Exception):
                self._on_change(provider)

    def snapshot(self) -> dict[str, Any]:
        devices, pending = self._android.snapshot_with_pending()
        with self._lock:
            if self._thread is None and not self._stop.is_set():
                self._thread = threading.Thread(target=self._refresh, name="device-discovery", daemon=True)
                self._thread.start()
            if not self._refreshing and time.monotonic() - self._refreshed >= REFRESH_SECONDS:
                self._pending = True
            result = ScanResult(devices=devices)
            for cached in self._results.values():
                result.devices.extend(copy.deepcopy(cached.devices))
                result.errors.extend(copy.deepcopy(cached.errors))
        self._wake.set()
        result.devices.sort(key=lambda device: (device.kind, device.name))
        return {**result.to_dict(), "pendingAndroidSerials": pending}

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        self._android.stop()

    def _refresh(self) -> None:
        while not self._stop.is_set():
            self._wake.wait()
            self._wake.clear()
            with self._lock:
                if not self._pending or self._stop.is_set():
                    continue
                self._pending = False
                self._refreshing = True
            try:
                for name, provider in _providers():
                    if name == "android":
                        continue
                    result = ScanResult()
                    try:
                        result.devices = provider()
                    except Exception as exc:
                        result.errors.append({"provider": name, "message": f"{type(exc).__name__}: {exc}"})
                    with self._lock:
                        if self._stop.is_set():
                            return
                        changed = self._results.get(name) != result
                        self._results[name] = result
                    if changed:
                        self._changed(name)
            finally:
                with self._lock:
                    self._refreshing = False
                    self._refreshed = time.monotonic()
