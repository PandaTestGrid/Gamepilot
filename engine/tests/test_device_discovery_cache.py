"""其它设备来源很慢/失败时，RPC 快照仍可读取且通知更新。"""

from __future__ import annotations

import threading

import pytest

from gamepilot.devices import discovery
from gamepilot.devices.base import DeviceInfo


@pytest.mark.parametrize("fail", [False, True])
def test_other_providers_refresh_without_blocking_snapshot(monkeypatch: pytest.MonkeyPatch, fail: bool) -> None:
    changes: list[str] = []
    updated = threading.Event()

    def changed(provider: str) -> None:
        changes.append(provider)
        updated.set()

    monitor = discovery.DeviceDiscovery(changed)
    monkeypatch.setattr(monitor._android, "snapshot_with_pending", lambda: ([], []))
    entered = threading.Event()
    release = threading.Event()
    calls: list[bool] = []

    def slow_provider() -> list[DeviceInfo]:
        calls.append(True)
        entered.set()
        assert release.wait(3)
        if fail:
            raise RuntimeError("usbmux 不可用")
        return [DeviceInfo(id="ios:phone", uri="iOS:///?udid=phone", name="iPhone", kind="ios")]

    monkeypatch.setattr(discovery, "_providers", lambda: [("ios", slow_provider)])
    try:
        assert monitor.snapshot()["devices"] == []
        assert entered.wait(2)
        # 提供方仍阻塞；连续读取不能等待它，也不能启动重复扫描。
        assert monitor.snapshot()["devices"] == []
        assert monitor.snapshot()["errors"] == []
        assert calls == [True]
        release.set()
        assert updated.wait(2)
        result = monitor.snapshot()
        if fail:
            assert result["devices"] == []
            assert result["errors"] == [{"provider": "ios", "message": "RuntimeError: usbmux 不可用"}]
        else:
            assert result["devices"][0]["id"] == "ios:phone"
            assert result["errors"] == []
        assert changes == ["ios"]
        assert calls == [True]
    finally:
        release.set()
        monitor.stop()
        if monitor._thread is not None:
            monitor._thread.join(timeout=3)
