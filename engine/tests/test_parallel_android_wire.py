"""FlowEngine parallel gestures through real Android/scrcpy methods, mock wire only."""

from __future__ import annotations

import struct
import threading
from collections.abc import Callable
from typing import Any

import numpy as np
import pytest

from gamepilot.core.flow_engine import FlowEngine
from gamepilot.core.flow_model import validate_flow
from gamepilot.core.frame import Frame
from gamepilot.core.graph import Graph
from gamepilot.core.touch_scheduler import close_touch_scheduler
from gamepilot.devices import android, scrcpy


class RecordingControl:
    """Only replaces the socket; all ownership and packet encoding stay production."""

    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.packets: list[tuple[int, ...]] = []
        self.active: set[int] = set()
        self.active_after: list[frozenset[int]] = []

    def sendall(self, payload: bytes) -> None:
        packet = struct.unpack(">BBQIIHHHII", payload)
        assert packet[0] == 2
        with self.condition:
            if packet[1] == 0:
                assert packet[2] not in self.active
                self.active.add(packet[2])
            elif packet[1] == 1:
                assert packet[2] in self.active
                self.active.remove(packet[2])
            else:
                assert packet[1] == 2 and packet[2] in self.active
            self.packets.append(packet)
            self.active_after.append(frozenset(self.active))
            self.condition.notify_all()

    def wait_for(self, predicate: Callable[[], bool]) -> None:
        with self.condition:
            assert self.condition.wait_for(predicate, timeout=2), self.trace()

    def trace(self) -> list[str]:
        names = {0: "DOWN", 1: "UP", 2: "MOVE"}
        return [f"finger{p[2] - 16}:{names[p[1]]}@({p[3]},{p[4]})" for p in self.packets]


def parallel_graph(tap_duration_ms: int) -> Graph:
    body: list[dict[str, Any]] = [
        {"id": "trigger", "type": "manual"},
        {"id": "parallel", "type": "parallel", "params": {"branches": 2, "mode": "all"}},
        {"id": "movement", "type": "parallelbranch", "params": {"parallel": "parallel", "branch": 1}},
        {
            "id": "joystick",
            "type": "swipe",
            "params": {
                "x": 0.2,
                "y": 0.8,
                "to_x": 0.4,
                "to_y": 0.8,
                "duration_ms": 50,
                "hold_ms": 10000,
                "finger": 1,
            },
        },
        {"id": "skillbranch", "type": "parallelbranch", "params": {"parallel": "parallel", "branch": 2}},
        {"id": "skill", "type": "click", "params": {"by": "coord", "x": 0.8, "y": 0.7, "finger": 2}},
        {"id": "join", "type": "parallelend", "params": {"parallel": "parallel"}},
    ]
    validate_flow({"steps": body}, set())
    return Graph.from_dict(
        {
            "flow": {"steps": body},
            "defaults": {
                "swipe_bezier": False,
                "click_jitter_px": 0,
                "click_micro_px": 0,
                "delay_jitter_ms": 0,
                "tap_duration_ms": tap_duration_ms,
            },
        },
        "",
    )


@pytest.mark.parametrize("stop_with_skill_active", [False, True], ids=["skill-up-keeps-joystick", "stop-releases-both"])
def test_parallel_android_scrcpy_wire_smoke(monkeypatch: pytest.MonkeyPatch, stop_with_skill_active: bool) -> None:
    def no_adb(*_args: object, **_kwargs: object) -> Any:
        raise AssertionError("wire smoke must never touch ADB or a real game")

    monkeypatch.setattr(android, "_adb_shell", no_adb)
    monkeypatch.setattr(scrcpy, "_adb_quiet", no_adb)
    channel = scrcpy.ScrcpyChannel("mock-only", "no-adb", "no-server")
    channel.video_size = (101, 201)
    wire = RecordingControl()
    channel._control = wire  # type: ignore[assignment]
    controller = android.AndroidController(serial="mock-only")
    controller._scrcpy = channel
    controller._connected = True
    checks: list[bool] = []
    monkeypatch.setattr(controller, "_validate_scrcpy_target", lambda *, force=False: checks.append(force))
    engine = FlowEngine(parallel_graph(10000 if stop_with_skill_active else 30), controller)
    try:
        engine.start()
        engine.tick(Frame(np.zeros((8, 8, 3), dtype=np.uint8), size=(8, 8), index=1))
        wire.wait_for(lambda: sum(p[1] == 0 for p in wire.packets) == 2)
        wire.wait_for(lambda: any(p[1] == 2 and p[2] == 17 for p in wire.packets))
        if not stop_with_skill_active:
            wire.wait_for(lambda: any(p[1] == 1 and p[2] == 18 for p in wire.packets))
            skill_up = next(i for i, p in enumerate(wire.packets) if p[1:3] == (1, 18))
            assert wire.active_after[skill_up] == frozenset({17})
            assert set(channel._active_touches) == {1}, wire.trace()
        else:
            assert wire.active == {17, 18}, wire.trace()
            assert set(channel._active_touches) == {1, 2}
        assert engine.result == "running"
        assert set(engine.active_step_ids) == {"joystick", "skill"}
        engine.request_stop()
        engine.stop_execution()
        assert engine.result == "cancelled"
        assert wire.active == set(), wire.trace()
        assert channel._active_touches == {}
        packets = list(wire.packets)
        joystick_down = next(i for i, p in enumerate(packets) if p[1:3] == (0, 17))
        joystick_up = next(i for i, p in enumerate(packets) if p[1:3] == (1, 17))
        skill_down = next(i for i, p in enumerate(packets) if p[1:3] == (0, 18))
        assert joystick_down < skill_down < joystick_up, wire.trace()
        assert sum(p[1:3] == (1, 17) for p in packets) == 1
        assert sum(p[1:3] == (1, 18) for p in packets) == 1
        assert all(p[2] in (17, 18) and p[8:] == (0, 0) for p in packets)
        assert all(p[7] == (0 if p[1] == 1 else 65535) for p in packets)
        assert checks.count(True) == 2, "both finger DOWNs use Android target safety validation"
        engine.tick(Frame(np.zeros((8, 8, 3), dtype=np.uint8), size=(8, 8), index=2))
        assert wire.packets == packets, "stop must invalidate queued MOVE/UP events"
        print("\nmock Android/scrcpy wire trace:", " -> ".join(wire.trace()))
    finally:
        engine.request_stop()
        close_touch_scheduler(controller)
