from __future__ import annotations

import threading
from typing import Any

from gamepilot.rpc.event_notifications import EventNotifications


def test_batching_preserves_events_and_lifecycle_order_under_blocked_writer() -> None:
    blocked = threading.Event()
    release = threading.Event()
    stopped = threading.Event()
    messages: list[dict[str, Any]] = []

    def write(payload: dict[str, Any]) -> None:
        if not messages:
            blocked.set()
            assert release.wait(3)
        messages.append(payload)
        if payload["method"] == "run.stopped":
            stopped.set()

    publisher = EventNotifications(write)
    publisher.enable_batches()
    try:
        publisher.submit("run.started", {"deviceId": "d"})
        assert blocked.wait(1)
        for seq in range(1000):
            publisher.submit("engine.event", {"seq": seq, "type": "step_started"})
        publisher.submit("engine.event", {"seq": 1000, "type": "flow_finished"})
        publisher.submit("run.stopped", {"deviceId": "d"})
        assert len(publisher._pending) == 1002
        release.set()
        assert stopped.wait(3)
        events = [
            event
            for message in messages
            if message["method"] == "engine.events"
            for event in message["params"]["events"]
        ]
        assert [event["seq"] for event in events] == list(range(1001))
        assert messages[0]["method"] == "run.started"
        assert messages[-1]["method"] == "run.stopped"
        assert len(messages) <= 18
    finally:
        release.set()
        publisher.close()


def test_overload_never_blocks_stop_and_reports_dropped_telemetry() -> None:
    blocked = threading.Event()
    release = threading.Event()
    messages: list[dict[str, Any]] = []

    def write(payload: dict[str, Any]) -> None:
        if not messages:
            blocked.set()
            assert release.wait(3)
        messages.append(payload)

    publisher = EventNotifications(write, capacity=2)
    publisher.enable_batches()
    try:
        publisher.submit("run.started", {})
        assert blocked.wait(1)
        for seq in range(100):
            publisher.submit("engine.event", {"seq": seq, "type": "step_started"})
        publisher.submit("run.stopped", {})
        assert len(publisher._pending) == 2
        release.set()
        publisher.close()
        assert messages[-1]["method"] == "run.stopped"
        assert any(message["method"] == "engine.log" and message["params"]["droppedEvents"] > 0 for message in messages)
    finally:
        release.set()
        publisher.close()


def test_legacy_events_stay_single_without_negotiation() -> None:
    messages: list[dict[str, Any]] = []
    publisher = EventNotifications(messages.append)
    publisher.submit("engine.event", {"seq": 1, "type": "step_started"})
    publisher.submit("engine.event", {"seq": 2, "type": "error"})
    publisher.close()
    assert [message["method"] for message in messages] == ["engine.event", "engine.event"]
    assert [message["params"]["seq"] for message in messages] == [1, 2]
