from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

from gamepilot.rpc.frame_notifications import FrameNotifications


def test_blocked_stdout_never_blocks_capture_and_latest_frame_wins() -> None:
    blocked = threading.Event()
    release = threading.Event()
    delivered = threading.Event()
    messages: list[dict[str, Any]] = []

    def slow_write(payload: dict[str, Any]) -> None:
        if not messages:
            blocked.set()
            assert release.wait(3)
        messages.append(payload)
        if payload["params"]["index"] == 999:
            delivered.set()

    publisher = FrameNotifications(slow_write)
    try:
        publisher.submit({"deviceId": "one", "index": 0})
        assert blocked.wait(1)
        for index in range(1, 1000):
            publisher.submit({"deviceId": "one", "index": index})
        with publisher._condition:
            assert len(publisher._pending) == 1
            assert publisher._pending["one"]["index"] == 999
        release.set()
        assert delivered.wait(1)
        assert [message["params"]["index"] for message in messages] == [0, 999]
    finally:
        release.set()
        publisher.close()


def test_invalidated_inflight_metadata_cannot_overwrite_reconnected_device() -> None:
    waiting = threading.Event()
    release = threading.Event()
    delivered = threading.Event()
    indices: list[int] = []

    def guarded_write(payload: dict[str, Any], current: Callable[[], bool]) -> None:
        if payload["params"]["index"] == 99:
            waiting.set()
            assert release.wait(2)
        if current():
            indices.append(payload["params"]["index"])
            delivered.set()

    publisher = FrameNotifications(lambda _: None, guarded_write=guarded_write)
    try:
        publisher.submit({"deviceId": "device", "index": 99})
        assert waiting.wait(1)
        publisher.invalidate("device")
        publisher.submit({"deviceId": "device", "index": 1})
        release.set()
        assert delivered.wait(1)
        assert indices == [1]
    finally:
        release.set()
        publisher.close()


def test_pending_device_count_is_bounded_and_close_discards_pending() -> None:
    blocked = threading.Event()
    release = threading.Event()

    def slow_write(payload: dict[str, Any]) -> None:
        blocked.set()
        release.wait(2)

    publisher = FrameNotifications(slow_write, max_devices=2)
    try:
        publisher.submit({"deviceId": "active"})
        assert blocked.wait(1)
        for index in range(20):
            publisher.submit({"deviceId": str(index)})
        with publisher._condition:
            assert list(publisher._pending) == ["18", "19"]
        publisher.close()
        publisher.submit({"deviceId": "late"})
        assert not publisher._pending
    finally:
        release.set()
        publisher.close()
