from __future__ import annotations

import threading
import time
from typing import Any

import numpy as np
import pytest

from gamepilot.core.flow_engine import FlowEngine
from gamepilot.core.flow_model import validate_flow
from gamepilot.core.frame import Frame
from gamepilot.core.graph import Graph
from gamepilot.core.touch_scheduler import close_touch_scheduler
from gamepilot.devices.synthetic_test import SyntheticController


def steps(first: list[dict[str, Any]], second: list[dict[str, Any]], mode: str = "all") -> list[dict[str, Any]]:
    return [
        {"id": "t", "type": "manual"},
        {"id": "p", "type": "parallel", "params": {"branches": 2, "mode": mode}},
        {"id": "b1", "type": "parallelbranch", "params": {"parallel": "p", "branch": 1}},
        *first,
        {"id": "b2", "type": "parallelbranch", "params": {"parallel": "p", "branch": 2}},
        *second,
        {"id": "pe", "type": "parallelend", "params": {"parallel": "p"}},
        {"id": "after", "type": "setvar", "params": {"name": "after", "value": 1}},
    ]


def frame(index: int) -> Frame:
    return Frame(np.zeros((8, 8, 3), dtype=np.uint8), size=(8, 8), index=index)


def test_all_shared_variables_join_and_global_events() -> None:
    body = steps(
        [{"id": "one", "type": "setvar", "params": {"name": "value", "value": 1}}],
        [{"id": "two", "type": "setvar", "params": {"name": "value", "value": 2}}],
    )
    validate_flow({"steps": body}, set())
    engine = FlowEngine(Graph.from_dict({"flow": {"steps": body}}, ""), SyntheticController())
    engine.start()
    events = engine.tick(frame(1))
    assert engine.result == "success"
    assert engine.variables.get("value") == 2
    assert engine.variables.get("after") == 1
    seq = [event.seq for event in events]
    assert seq == sorted(set(seq))
    paths = [event.extra.get("branchPath") for event in events]
    assert {tuple(path) for path in paths if isinstance(path, list)} >= {(1,), (2,)}


def test_any_winner_cancels_slow_branch() -> None:
    body = steps([{"id": "wait", "type": "delay", "params": {"ms": 100000}}], [{"id": "win", "type": "end"}], "any")
    engine = FlowEngine(Graph.from_dict({"flow": {"steps": body}}, ""), SyntheticController())
    engine.start()
    engine.tick(frame(1))
    assert engine.result == "success" and engine.variables.get("after") == 1
    assert engine.active_step_ids == []


def test_parallel_holds_really_overlap_and_stop_releases() -> None:
    body = steps(
        [{"id": "left", "type": "hold", "params": {"by": "coord", "x": 0.1, "y": 0.1, "duration_ms": 10000}}],
        [{"id": "right", "type": "hold", "params": {"by": "coord", "x": 0.8, "y": 0.8, "duration_ms": 10000}}],
    )
    controller = SyntheticController()
    controller.connect()
    engine = FlowEngine(Graph.from_dict({"flow": {"steps": body}}, ""), controller)
    try:
        engine.start()
        engine.tick(frame(1))
        deadline = time.monotonic() + 2
        while len(controller.active_touches) < 2 and time.monotonic() < deadline:
            time.sleep(0.005)
        assert len(controller.active_touches) == 2
        assert set(engine.active_step_ids) == {"left", "right"}
        engine.request_stop()
        assert not controller.active_touches
        engine.stop_execution()
    finally:
        close_touch_scheduler(controller)


def test_stop_during_child_start_cannot_run_late_branch(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = FlowEngine(
        Graph.from_dict(
            {"flow": {"steps": steps([{"id": "late", "type": "setvar", "params": {"name": "late", "value": 1}}], [])}},
            "",
        ),
        SyntheticController(),
    )
    engine.start()
    entered = threading.Event()
    release = threading.Event()
    original = FlowEngine.start

    def start(self: FlowEngine, from_step_id: str | None = None) -> None:
        if self is not engine:
            entered.set()
            assert release.wait(3)
        original(self, from_step_id)

    monkeypatch.setattr(FlowEngine, "start", start)
    thread = threading.Thread(target=lambda: engine.tick(frame(1)))
    thread.start()
    try:
        assert entered.wait(3)
        engine.request_stop()
        release.set()
        thread.join(3)
        assert not thread.is_alive()
        assert engine.variables.get("late") is None
    finally:
        release.set()
        thread.join(3)


def test_branch_breakpoint_and_fromstep_boundary() -> None:
    body = steps([{"id": "a", "type": "setvar", "params": {"name": "a", "value": 1}}], [])
    engine = FlowEngine(Graph.from_dict({"flow": {"steps": body}}, ""), SyntheticController())
    with pytest.raises(ValueError, match="并行分支内部"):
        engine.start("a")
    engine.start()
    engine.breakpoints.add("a")
    engine.tick(frame(1))
    assert engine.paused and engine.variables.get("a") is None


def test_pause_explicit_persistent_contact_requires_restart() -> None:
    body = [
        {"id": "t", "type": "manual"},
        {"id": "down", "type": "touch", "params": {"phase": "down", "finger": 3, "x": 0.2, "y": 0.2}},
        {"id": "delay", "type": "delay", "params": {"ms": 10000}},
    ]
    controller = SyntheticController()
    controller.connect()
    engine = FlowEngine(Graph.from_dict({"flow": {"steps": body}}, ""), controller)
    try:
        engine.start()
        engine.tick(frame(1))
        assert engine._touch_handle is not None and engine._touch_handle.done.wait(2)
        engine.tick(frame(2))
        assert controller.active_touches
        engine.pause_execution()
        assert not controller.active_touches
        engine.resume()
        assert engine.result == "failure"
    finally:
        close_touch_scheduler(controller)


@pytest.mark.parametrize("bad", ["call", "escape", "count", "floatbranch", "orphan", "finger", "duration"])
def test_parallel_validation_rejects_invalid_boundaries(bad: str) -> None:
    body = steps([], [])
    if bad == "call":
        body.insert(3, {"id": "call", "type": "call", "params": {"script": "other"}})
    elif bad == "escape":
        body.insert(3, {"id": "break", "type": "loopbreak", "params": {"back": "outside"}})
    elif bad == "count":
        body[3]["params"]["branch"] = 3
    elif bad == "floatbranch":
        body[2]["params"]["branch"] = 1.0
    elif bad == "orphan":
        body.insert(2, {"id": "lost", "type": "delay"})
    elif bad == "finger":
        body.insert(3, {"id": "touch", "type": "click", "params": {"finger": True}})
    else:
        body.insert(
            3,
            {
                "id": "touch",
                "type": "touch",
                "params": {"phase": "move", "x": 0.5, "y": 0.5, "duration_ms": float("nan")},
            },
        )
    with pytest.raises(ValueError):
        validate_flow({"steps": body}, set())
