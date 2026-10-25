"""设备监听、缓存与慢详情查询隔离；全部使用本机假 ADB 服务，不依赖手机。"""

from __future__ import annotations

import copy
import queue
import socket
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from gamepilot.devices import android, android_discovery
from gamepilot.devices.android_discovery import AndroidDiscovery, parse_snapshot, read_block, read_exact
from gamepilot.devices.base import STATUS_DISCOVERED, STATUS_FAILED, DeviceInfo


def test_snapshot_preserves_authorization_and_model() -> None:
    rows = parse_snapshot("usb-a unauthorized\n127.0.0.1:16384 device product:mumu model:MuMu_12\n")
    assert rows["usb-a"].status == STATUS_FAILED
    assert "未授权" in (rows["usb-a"].error or "")
    assert rows["127.0.0.1:16384"].name == "MuMu 12"
    assert rows["127.0.0.1:16384"].status == STATUS_DISCOVERED
    assert parse_snapshot("") == {}


def test_track_frame_handles_empty_utf8_and_eof() -> None:
    reader, writer = socket.socketpair()
    try:
        payload = "手机 device".encode()
        writer.sendall(b"0000" + f"{len(payload):04x}".encode() + payload)
        assert read_block(reader) == ""
        assert read_block(reader) == "手机 device"
        writer.close()
        with pytest.raises(EOFError):
            read_block(reader)
    finally:
        reader.close()
        writer.close()


@pytest.mark.parametrize("disconnect", [False, True])
def test_slow_details_do_not_block_snapshot_or_restore_disconnected_device(
    monkeypatch: pytest.MonkeyPatch, disconnect: bool
) -> None:
    monitor = AndroidDiscovery(lambda: None)
    monkeypatch.setattr(monitor, "start", lambda: None)
    monitor._accept("usb-a device model:Phone")
    entered = threading.Event()
    release = threading.Event()

    def slow_resolution(_serial: str) -> tuple[int, int]:
        entered.set()
        assert release.wait(3)
        return (1080, 1920)

    monkeypatch.setattr(android, "_query_resolution", slow_resolution)
    monkeypatch.setattr(android, "list_displays", lambda _serial: [])
    base = copy.deepcopy(monitor.snapshot()[0])
    version = monitor._versions["usb-a"]
    worker = threading.Thread(target=monitor._refresh_device, args=("usb-a", version, base), daemon=True)
    worker.start()
    try:
        assert entered.wait(2)
        if disconnect:
            monitor._accept("usb-a offline")
        # 在详情线程仍被阻塞时读取成功，且不误用它尚未返回的分辨率。
        rows = monitor.snapshot()
        assert rows[0].resolution is None
        assert rows[0].status == (STATUS_FAILED if disconnect else STATUS_DISCOVERED)
        assert monitor.snapshot_with_pending()[1] == ([] if disconnect else ["usb-a"])
    finally:
        release.set()
        worker.join(timeout=3)
        monitor.stop()
    assert not worker.is_alive()
    rows = monitor.snapshot()
    assert rows[0].resolution == (None if disconnect else (1080, 1920))
    assert monitor.snapshot_with_pending()[1] == []


def test_first_detail_completion_notifies_even_without_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    changes: list[bool] = []
    monitor = AndroidDiscovery(lambda: changes.append(True))
    monkeypatch.setattr(monitor, "start", lambda: None)
    monkeypatch.setattr(android, "_query_resolution", lambda _serial: None)
    monkeypatch.setattr(android, "list_displays", lambda _serial: [])
    monitor._accept("usb-a device")
    rows, pending = monitor.snapshot_with_pending()
    assert pending == ["usb-a"]
    monitor._refresh_device("usb-a", monitor._versions["usb-a"], rows[0])
    assert monitor.snapshot_with_pending()[1] == []
    assert len(changes) == 2
    monitor.stop()


def test_missing_secondary_screen_is_confirmed_with_a_new_query(monkeypatch: pytest.MonkeyPatch) -> None:
    monitor = AndroidDiscovery(lambda: None)
    monkeypatch.setattr(monitor, "start", lambda: None)
    monitor._accept("127.0.0.1:16384 device model:MuMu")
    base = monitor.snapshot()[0]
    display = android.DisplayInfo(id=4, name="external", physical_id=42, size=(900, 1600))
    monitor._details[base.serial or ""] = [base, *android.display_devices(base.serial or "", base, [display])]
    answers = iter([[], [display]])
    monkeypatch.setattr(android, "_query_resolution", lambda _serial: (900, 1600))
    monkeypatch.setattr(android, "list_displays", lambda _serial: next(answers))
    monitor._refresh_device(base.serial or "", monitor._versions[base.serial or ""], copy.deepcopy(base))
    assert [row.id for row in monitor.snapshot()] == ["android:127.0.0.1:16384", "android:127.0.0.1:16384:42"]


@pytest.mark.parametrize("long_supported", [False, True])
def test_tracking_updates_authorization_reconnects_and_stops(
    monkeypatch: pytest.MonkeyPatch, long_supported: bool
) -> None:
    changes: queue.Queue[list[DeviceInfo]] = queue.Queue()
    monitor = AndroidDiscovery(lambda: changes.put(monitor.snapshot()))
    monkeypatch.setattr(monitor, "_refresh", lambda: monitor._stop.wait(10))
    monkeypatch.setattr(android_discovery, "log_once", lambda: {})
    authorize = threading.Event()
    disconnect = threading.Event()
    finished = threading.Event()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(4)
        monkeypatch.setenv("ANDROID_ADB_SERVER_HOST", "127.0.0.1")
        monkeypatch.setenv("ANDROID_ADB_SERVER_PORT", str(listener.getsockname()[1]))

        def send(connection: socket.socket, payload: bytes) -> None:
            connection.sendall(f"{len(payload):04x}".encode() + payload)

        def serve() -> None:
            if not long_supported:
                connection, _ = listener.accept()
                with connection:
                    assert read_exact(connection, int(read_exact(connection, 4), 16)) == b"host:track-devices-l"
                    connection.sendall(b"FAIL")
                    send(connection, b"unknown host service")
            for first in (True, False):
                connection, _ = listener.accept()
                with connection:
                    service = b"host:track-devices-l" if long_supported else b"host:track-devices"
                    assert read_exact(connection, int(read_exact(connection, 4), 16)) == service
                    connection.sendall(b"OKAY")
                    if first:
                        send(connection, b"usb-a unauthorized\n")
                        assert authorize.wait(3)
                        send(connection, b"usb-a device model:Phone\n")
                        assert disconnect.wait(3)
                    else:
                        send(connection, b"usb-b device model:Second\n")
                        assert finished.wait(3)

        with ThreadPoolExecutor(max_workers=1) as pool:
            serving = pool.submit(serve)
            try:
                monitor.start()
                assert changes.get(timeout=3)[0].status == STATUS_FAILED
                authorize.set()
                assert changes.get(timeout=3)[0].status == STATUS_DISCOVERED
                disconnect.set()
                assert changes.get(timeout=3) == []
                assert changes.get(timeout=3)[0].id == "android:usb-b"
            finally:
                authorize.set()
                disconnect.set()
                finished.set()
                monitor.stop()
            serving.result(timeout=4)
