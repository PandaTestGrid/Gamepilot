"""Exploration branch regression; no templates, user files, or live device input."""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from gamepilot.core.flow_engine import FlowEngine
from gamepilot.core.frame import Frame
from gamepilot.core.graph import Graph
from gamepilot.core.trace import TraceEvent
from gamepilot.devices.synthetic_test import SyntheticController


def step(identity: str, kind: str, **params: Any) -> dict[str, Any]:
    return {"id": identity, "type": kind, "params": params}


def make_engine(monkeypatch: pytest.MonkeyPatch, *, matched: bool, authored: bool = True) -> FlowEngine:
    body = [
        step("start", "manual"),
        step("loop", "loop", count=3),
        step("condition", "cond", rec="battle", _loopRepeat="then", _loopRepeatLoop="loop"),
        step("battle", "click", by="coord", x=0.5, y=0.5),
        step("continue1", "click", by="recognizer", rec="continue"),
        step("continue2", "click", by="recognizer", rec="continue"),
        step("else", "else"),
        step("swipe", "swipe", x=0.8, y=0.5, to_x=0.2, to_y=0.5),
        step("endcondition", "condend", back="condition"),
        step("endloop", "loopend", back="loop"),
    ]
    if authored:
        for item in body:
            item["params"]["_out"] = []
        body[2]["params"]["_out"] = ["then>battle", "else>swipe"]
        body[5]["params"]["_out"] = ["out>loop"]
    graph = Graph.empty("")
    graph.flow = {"steps": body}
    graph.defaults["on_step_error"] = "continue"
    engine = FlowEngine(graph, SyntheticController())
    monkeypatch.setattr(engine, "_condition_ok", lambda params: matched)
    monkeypatch.setattr(engine, "perform", lambda spec: "synthetic action")
    monkeypatch.setattr(
        engine,
        "_try_wait_action_target",
        lambda identity, kind, params, frame: "timeout" if params.get("rec") == "continue" else "ok",
    )
    engine.start()
    return engine


def run(engine: FlowEngine) -> list[TraceEvent]:
    result = []
    for index in range(1, 30):
        result.extend(engine.tick(Frame(np.zeros((8, 8, 3), dtype=np.uint8), size=(8, 8), index=index)))
        if engine.result != "running":
            break
    assert engine.result == "success"
    return result


def test_continue_on_missing_continue_target_preserves_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = make_engine(monkeypatch, matched=True)
    events = run(engine)
    assert len([event for event in events if event.type == "loop_repeat"]) == 2
    assert len([event for event in events if event.type == "step_finished" and "出错已跳过" in event.message]) == 6
    assert not any(event.type == "loop_break" for event in events)


def test_explicit_else_empty_tail_repeats_enclosing_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = make_engine(monkeypatch, matched=False)
    events = run(engine)
    assert len([event for event in events if event.type == "loop_repeat"]) == 2
    assert len([event for event in events if event.type == "action_executed" and event.node == "swipe"]) == 3
    assert not any(event.type == "loop_break" for event in events)


def test_explicit_loopbreak_remains_authoritative(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = make_engine(monkeypatch, matched=False)
    engine.steps.insert(8, step("explicitbreak", "loopbreak", back="loop"))
    engine.graph.flow = {"steps": engine.steps}
    engine.start()
    events = run(engine)
    assert len([event for event in events if event.type == "loop_break"]) == 1
    assert not any(event.type == "loop_repeat" for event in events)


def test_legacy_branch_repeat_still_breaks_opposite_branch(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = make_engine(monkeypatch, matched=False, authored=False)
    events = run(engine)
    assert len([event for event in events if event.type == "loop_break"]) == 1
    assert not any(event.type == "loop_repeat" for event in events)
