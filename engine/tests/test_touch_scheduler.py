from __future__ import annotations

import pytest

from gamepilot.core.touch_scheduler import TouchOwner, TouchScheduler
from gamepilot.devices.synthetic_test import SyntheticController


def test_cancelled_owner_cannot_submit_or_reserve_after_stop() -> None:
    controller = SyntheticController()
    controller.connect()
    scheduler = TouchScheduler(controller)
    owner = TouchOwner("cancelled-run")
    try:
        scheduler.cancel_owner(owner)
        with pytest.raises(RuntimeError, match="关闭"):
            scheduler.submit(owner, 1, [(0, "down", 0.1, 0.1)])
        with pytest.raises(RuntimeError, match="关闭"):
            scheduler.allocate_finger(owner)
        assert not controller.pointer_events
    finally:
        scheduler.close()


def test_two_contacts_overlap_and_complete_without_capture() -> None:
    controller = SyntheticController()
    controller.connect()
    scheduler = TouchScheduler(controller)
    try:
        first = scheduler.submit("a", 1, [(0, "down", 0.1, 0.1), (0.1, "up", 0.1, 0.1)])
        second = scheduler.submit("b", 2, [(0, "down", 0.8, 0.8), (0.05, "up", 0.8, 0.8)])
        assert first.done.wait(2) and second.done.wait(2)
        phases = [(entry[0], entry[1]) for entry in controller.pointer_events]
        assert phases.index(("down", 2)) < phases.index(("up", 1))
        assert not controller.active_touches
    finally:
        scheduler.close()


def test_cancel_persistent_contact_and_owner_conflict() -> None:
    controller = SyntheticController()
    controller.connect()
    scheduler = TouchScheduler(controller)
    try:
        handle = scheduler.submit("a", 1, [(0, "down", 0.2, 0.2)])
        assert handle.done.wait(2)
        with pytest.raises(ValueError, match="占用"):
            scheduler.submit("b", 1, [(0, "down", 0.1, 0.1)])
        scheduler.cancel_owner("a")
        assert not controller.active_touches
        assert handle.cancelled
        other = scheduler.submit("b", 1, [(0, "down", 0.1, 0.1), (0, "up", 0.1, 0.1)])
        assert other.done.wait(2)
    finally:
        scheduler.close()


def test_cancel_prevents_future_down_and_auto_allocator_is_unique() -> None:
    controller = SyntheticController()
    controller.connect()
    scheduler = TouchScheduler(controller)
    try:
        assert scheduler.allocate_finger("a", 1) == 1
        assert scheduler.allocate_finger("b", 1) == 2
        handle = scheduler.submit("a", 1, [(100, "down", 0.1, 0.1)])
        scheduler.cancel_owner("a")
        assert handle.done.is_set() and handle.cancelled
        assert not controller.pointer_events
    finally:
        scheduler.close()
