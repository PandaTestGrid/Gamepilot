"""常驻 ADB 设备监听：列表读取不等待设备 shell，详情在后台补齐。"""

from __future__ import annotations

import contextlib
import copy
import os
import socket
import subprocess
import threading
import time
from collections.abc import Callable

from . import android
from .base import STATUS_DISCOVERED, DeviceInfo
from .env_report import log_once

DETAIL_REFRESH_SECONDS = 1.0
EMULATOR_PROBE_SECONDS = 5.0


class _ServiceRejectedError(ConnectionError):
    """ADB 明确拒绝服务；网络断连不能据此降级到没有型号信息的旧协议。"""


def read_exact(connection: socket.socket, length: int) -> bytes:
    data = bytearray()
    while len(data) < length:
        chunk = connection.recv(length - len(data))
        if not chunk:
            raise EOFError("ADB 监听连接已断开")
        data.extend(chunk)
    return bytes(data)


def read_block(connection: socket.socket) -> str:
    length = int(read_exact(connection, 4), 16)
    return read_exact(connection, length).decode("utf-8")


def parse_snapshot(payload: str) -> dict[str, DeviceInfo]:
    result: dict[str, DeviceInfo] = {}
    for line in payload.splitlines():
        fields = line.split()
        if len(fields) < 2:
            continue
        serial, state = fields[:2]
        tags = dict(item.split(":", 1) for item in fields[2:] if ":" in item)
        result[serial] = android.device_info(serial, state, tags)
    return result


class AndroidDiscovery:
    """每个 RPC 服务一份；两个守护线程分别监听状态与查询详情，停止时只关闭自己的连接。"""

    def __init__(self, on_change: Callable[[], None]) -> None:
        self._on_change = on_change
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._started = False
        self._connection: socket.socket | None = None
        self._base: dict[str, DeviceInfo] = {}
        self._details: dict[str, list[DeviceInfo]] = {}
        self._versions: dict[str, int] = {}
        self._revision = 0
        self._pending: set[str] = set()
        self._inflight: set[str] = set()
        self._refreshed: dict[str, float] = {}

    def start(self) -> None:
        with self._lock:
            if self._started or self._stop.is_set():
                return
            self._started = True
        for target in (self._track, self._refresh, log_once):
            threading.Thread(target=target, name=f"adb-{target.__name__}", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        with self._lock:
            connection = self._connection
        if connection is not None:
            with contextlib.suppress(OSError):
                connection.shutdown(socket.SHUT_RDWR)
            connection.close()

    def snapshot(self) -> list[DeviceInfo]:
        return self.snapshot_with_pending()[0]

    def snapshot_with_pending(self) -> tuple[list[DeviceInfo], list[str]]:
        """设备行与详情未就绪的 serial 必须来自同一份快照，避免重连时误删活附屏。"""
        self.start()
        now = time.monotonic()
        with self._lock:
            for serial, info in self._base.items():
                if (
                    info.status == STATUS_DISCOVERED
                    and serial not in self._inflight
                    and now - self._refreshed.get(serial, 0) >= DETAIL_REFRESH_SECONDS
                ):
                    self._pending.add(serial)
            result = copy.deepcopy(self._rows())
            pending = [
                serial
                for serial, info in self._base.items()
                if info.status == STATUS_DISCOVERED and serial not in self._details
            ]
        self._wake.set()
        return result, pending

    def _rows(self) -> list[DeviceInfo]:
        return [row for serial, base in self._base.items() for row in self._details.get(serial, [base])]

    def _changed(self) -> None:
        if not self._stop.is_set():
            with contextlib.suppress(Exception):
                self._on_change()

    def _accept(self, payload: str) -> None:
        incoming = parse_snapshot(payload)
        with self._lock:
            if incoming == self._base:
                return
            for serial in self._base.keys() | incoming.keys():
                if self._base.get(serial) == incoming.get(serial):
                    continue
                self._revision += 1
                self._versions[serial] = self._revision
                self._details.pop(serial, None)
                self._refreshed.pop(serial, None)
                if serial in incoming and incoming[serial].status == STATUS_DISCOVERED:
                    self._pending.add(serial)
                else:
                    self._pending.discard(serial)
            self._base = incoming
        self._wake.set()
        self._changed()

    def _open(self, service: str) -> socket.socket:
        host = os.environ.get("ANDROID_ADB_SERVER_HOST", "127.0.0.1")
        port = int(os.environ.get("ANDROID_ADB_SERVER_PORT", "5037"))
        try:
            connection = socket.create_connection((host, port), timeout=3)
        except OSError:
            if host not in ("127.0.0.1", "localhost", "::1"):
                raise
            # 不使用 adbutils 的自动拉起：它会把 adb start-server 输出继承到 RPC stdout。
            subprocess.run(
                [android._adb_binary(), "-P", str(port), "start-server"],
                capture_output=True,
                timeout=10,
                check=True,
                stdin=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            connection = socket.create_connection((host, port), timeout=3)
        with self._lock:
            if self._stop.is_set():
                connection.close()
                raise EOFError("ADB 监听已停止")
            self._connection = connection
        command = service.encode("ascii")
        connection.sendall(f"{len(command):04x}".encode("ascii") + command)
        status = read_exact(connection, 4)
        if status == b"FAIL":
            raise _ServiceRejectedError(read_block(connection))
        if status != b"OKAY":
            raise ConnectionError(repr(status))
        connection.settimeout(None)
        return connection

    def _track(self) -> None:
        service = "host:track-devices-l"
        while not self._stop.is_set():
            try:
                with self._open(service) as connection:
                    while not self._stop.is_set():
                        self._accept(read_block(connection))
            except Exception as exc:
                if self._stop.is_set():
                    return
                if isinstance(exc, _ServiceRejectedError) and service.endswith("-l"):
                    service = "host:track-devices"
                android._warn_adb_once("track-devices", "ADB 设备监听中断，稍后重连: %s", exc)
                self._accept("")
            finally:
                with self._lock:
                    closed_connection = self._connection
                    self._connection = None
                if closed_connection is not None:
                    closed_connection.close()
            self._stop.wait(1)

    def _refresh_device(self, serial: str, version: int, base: DeviceInfo) -> None:
        base.resolution = android._query_resolution(serial)
        displays = android.list_displays(serial)
        rows = [base, *android.display_devices(serial, base, displays)]
        with self._lock:
            previous = self._details.get(serial, [])
        # 缓存中的同一份快照不能冒充前端的两次独立扫描；附屏消失先在后台再查一次。
        missing = {row.id for row in previous[1:]} - {row.id for row in rows[1:]}
        if missing and not self._stop.is_set():
            rows = [base, *android.display_devices(serial, base, android.list_displays(serial))]
        with self._lock:
            if self._stop.is_set() or self._versions.get(serial) != version:
                return
            changed = self._details.get(serial) != rows
            self._details[serial] = rows
            self._refreshed[serial] = time.monotonic()
        if changed:
            self._changed()

    def _probe_emulators(self) -> None:
        import adbutils

        with self._lock:
            if self._connection is None:
                return
            serials = set(self._base)
        android.connect_local_emulators(adbutils.AdbClient(), serials)

    def _refresh(self) -> None:
        next_probe = 0.0
        while not self._stop.is_set():
            self._wake.wait(0.5)
            self._wake.clear()
            with self._lock:
                pending = self._pending.copy()
                self._pending.clear()
            for serial in pending:
                with self._lock:
                    base = self._base.get(serial)
                    if base is None or base.status != STATUS_DISCOVERED or self._stop.is_set():
                        continue
                    version = self._versions[serial]
                    self._inflight.add(serial)
                    base = copy.deepcopy(base)
                try:
                    self._refresh_device(serial, version, base)
                except Exception as exc:
                    android.logger.debug("后台设备详情读取失败 %s: %s", serial, exc)
                finally:
                    with self._lock:
                        self._inflight.discard(serial)
            if time.monotonic() >= next_probe and not self._stop.is_set():
                with contextlib.suppress(Exception):
                    self._probe_emulators()
                next_probe = time.monotonic() + EMULATOR_PROBE_SECONDS
