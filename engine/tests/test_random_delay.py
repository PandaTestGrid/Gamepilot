"""Random waits use one sampled target per arrival and retain fixed-delay behavior."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from gamepilot.core.evidence import RunEvidence
from gamepilot.core.flow_engine import FlowEngine
from gamepilot.core.frame import Frame
from gamepilot.core.graph import Graph
from gamepilot.devices.synthetic_test import SyntheticController


def _engine() -> FlowEngine:
    return FlowEngine(Graph.empty(""), SyntheticController())


def _frame(index: int = 1) -> Frame:
    return Frame(np.zeros((8, 8, 3), dtype=np.uint8), size=(8, 8), index=index)


@pytest.mark.parametrize(
    "params, expected",
    [({}, 500), ({"ms": 123}, 123), ({"random": False, "ms": 12}, 12), ({"ms": -5}, 0), ({"ms": True}, 500)],
)
def test_fixed_delay_is_unchanged(params: dict[str, Any], expected: int, monkeypatch: pytest.MonkeyPatch) -> None:
    engine = _engine()
    calls: list[int] = []

    def phase(_step: str, ms: int, _frame: Frame) -> bool:
        calls.append(ms)
        return False

    monkeypatch.setattr(engine, "_try_step_phase_delay", phase)
    monkeypatch.setattr(
        "gamepilot.core.flow_engine.random.randint", lambda *_: pytest.fail("fixed delay must not sample")
    )
    engine._try_delay("delay", params, _frame())
    assert calls == [expected]


@pytest.mark.parametrize(
    "params, bounds",
    [
        ({"minMs": 10, "maxMs": 20}, (10, 20)),
        ({"minMs": 20, "maxMs": 10}, (10, 20)),
        ({}, (0, 500)),
        ({"ms": 42}, (0, 42)),
        ({"minMs": 7}, (7, 7)),
        ({"maxMs": 13}, (0, 13)),
        ({"minMs": -20, "maxMs": 900000}, (0, 600000)),
    ],
)
def test_random_bounds_and_fallbacks(
    params: dict[str, Any], bounds: tuple[int, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    engine = _engine()
    calls: list[tuple[int, int]] = []

    def sample(low: int, high: int) -> int:
        calls.append((low, high))
        return high

    monkeypatch.setattr("gamepilot.core.flow_engine.random.randint", sample)
    engine._try_delay("delay", {"random": True, **params}, _frame())
    assert calls == [bounds]
    if bounds[1]:
        assert engine.blocking is not None and engine.blocking.random_wait_ms == bounds[1]


def test_random_wait_samples_once_and_records_actual_value(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    now = [1000.0]
    monkeypatch.setattr("gamepilot.core.flow_engine.time.monotonic", lambda: now[0])
    calls: list[bool] = []

    def sample(*_args: int) -> int:
        calls.append(True)
        return 250

    monkeypatch.setattr("gamepilot.core.flow_engine.random.randint", sample)
    engine = _engine()
    evidence = RunEvidence(tmp_path)
    engine.attach_evidence(evidence)
    evidence.step(1, "delay", "delay")
    params = {"random": True, "minMs": 100, "maxMs": 500}
    before = copy.deepcopy(params)
    try:
        assert engine._try_delay("delay", params, _frame())
        now[0] += 0.1
        assert engine._try_delay("delay", params, _frame(2))
        now[0] += 0.151
        assert not engine._try_delay("delay", params, _frame(3))
        assert engine.blocking is None
        assert calls == [True]
        assert params == before
        assert evidence.to_dict()["steps"][0]["randomWaitMs"] == 250
        events = engine._flush()
        assert any(event.extra.get("randomWaitMs") == 250 for event in events)
        assert engine._try_delay("delay", params, _frame(4))
        assert calls == [True, True]
    finally:
        evidence.close()


def test_random_zero_finishes_immediately(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("gamepilot.core.flow_engine.random.randint", lambda *_: 0)
    engine = _engine()
    assert not engine._try_delay("delay", {"random": True, "maxMs": 0}, _frame())
    assert engine.blocking is None


@pytest.mark.parametrize("value", [None, 1, "true", []])
def test_non_boolean_random_falls_back_to_fixed_delay(value: Any) -> None:
    """手改 graph 把 random 写成 "true"/1 时不能抛错打断执行，按固定延时处理。"""
    engine = _engine()
    assert not engine._try_delay("delay", {"random": value, "ms": 0}, _frame())
    assert engine.blocking is None


def test_pause_resume_keeps_single_random_sample(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [1000.0]
    calls: list[bool] = []
    monkeypatch.setattr("gamepilot.core.flow_engine.time.monotonic", lambda: now[0])

    def sample(*_args: int) -> int:
        calls.append(True)
        return 1000

    monkeypatch.setattr("gamepilot.core.flow_engine.random.randint", sample)
    graph = Graph.from_dict(
        {
            "flow": {
                "steps": [
                    {"id": "manual", "type": "manual", "params": {}},
                    {"id": "delay", "type": "delay", "params": {"random": True, "maxMs": 2000}},
                ]
            }
        },
        "",
    )
    engine = FlowEngine(graph, SyntheticController())
    engine.start()
    engine.tick(_frame())
    state = engine.blocking
    assert state is not None and state.random_wait_ms == 1000
    started_at = state.started_at
    engine.paused_at = "delay"
    now[0] += 0.2
    engine.tick(_frame(2))
    assert engine.blocking is state and state.random_wait_ms == 1000
    assert calls == [True]
    engine.resume()
    engine.tick(_frame(3))
    assert engine.blocking is state and state.started_at == started_at
    assert calls == [True]
    now[0] += 0.801
    engine.tick(_frame(4))
    assert engine.blocking is None
    assert engine.result == "success"
    assert calls == [True]


def test_stop_interrupts_random_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("gamepilot.core.flow_engine.random.randint", lambda *_: 600000)
    graph = Graph.from_dict(
        {
            "flow": {
                "steps": [
                    {"id": "manual", "type": "manual", "params": {}},
                    {"id": "delay", "type": "delay", "params": {"random": True, "maxMs": 600000}},
                ]
            }
        },
        "",
    )
    engine = FlowEngine(graph, SyntheticController())
    engine.start()
    engine.tick(_frame())
    assert engine.blocking is not None
    engine.stop_execution()
    assert engine.blocking is None
    assert engine.result != "running"
