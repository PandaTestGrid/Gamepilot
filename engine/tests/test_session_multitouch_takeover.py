"""Manual controls must cancel persistent automatic fingers before legacy input."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from gamepilot.core.flow_engine import FlowEngine
from gamepilot.core.graph import Graph
from gamepilot.devices.synthetic_test import SyntheticController
from gamepilot.project import Project
from gamepilot.sessions.device import DeviceSession


@pytest.fixture()
def session(tmp_path: Path) -> Any:
    controller = SyntheticController()
    controller.connect()
    graph = Graph.from_dict(
        {
            "flow": {
                "steps": [
                    {"id": "start", "type": "manual"},
                    {"id": "down", "type": "touch", "params": {"phase": "down", "finger": 1, "x": 0.2, "y": 0.3}},
                ]
            }
        },
        str(tmp_path),
    )
    graph.save(str(tmp_path / "graph.json"))
    instance = DeviceSession("synthetic:takeover", controller, Project(root=str(tmp_path)).ensure(), lambda *_: None)
    yield instance
    instance.stop()


@pytest.mark.parametrize("operation", ["tap", "swipe", "press", "down"])
def test_manual_input_cancels_before_injection(session: Any, monkeypatch: pytest.MonkeyPatch, operation: str) -> None:
    assert isinstance(session.engine, FlowEngine)
    events: list[str] = []
    session.engine.start()

    def pause() -> None:
        assert session._manual_touch
        events.append("pause:manual")

    monkeypatch.setattr(session.engine, "pause_execution", pause)
    monkeypatch.setattr(session.controller, "click", lambda *_args, **_kw: events.append("tap"))
    monkeypatch.setattr(session.controller, "swipe", lambda *_args, **_kw: events.append("swipe"))
    monkeypatch.setattr(session.controller, "press", lambda *_args: events.append("press"))
    monkeypatch.setattr(session.controller, "touch", lambda phase, *_args: events.append(phase), raising=False)
    if operation == "tap":
        session.tap(0.2, 0.3)
    elif operation == "swipe":
        session.swipe(0.1, 0.2, 0.4, 0.5, 0.2)
    elif operation == "press":
        session.press("back")
    else:
        session.touch("down", 0.2, 0.3)
    assert events[:2] == ["pause:manual", operation]
    if operation == "down":
        assert session._manual_touch
        session.touch("up", 0.2, 0.3)
    assert not session._manual_touch


def test_legacy_serial_input_is_not_paused(session: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    session.graph.flow = {
        "steps": [{"id": "start", "type": "manual"}, {"id": "wait", "type": "delay", "params": {"ms": 500}}]
    }
    session.engine = FlowEngine(session.graph, session.controller)
    session.engine.start()
    monkeypatch.setattr(
        session.engine,
        "pause_execution",
        lambda: pytest.fail("legacy serial execution must retain manual gate semantics"),
    )
    monkeypatch.setattr(session.controller, "click", lambda *_args, **_kw: None)
    session.tap(0.2, 0.3)
    assert not session.engine.paused
    assert not session._manual_touch


def test_debug_action_rejected_while_multitouch_workflow_running(session: Any) -> None:
    session.engine.start()
    with pytest.raises(RuntimeError, match="先停止流程"):
        session.run_action({"type": "click", "x": 0.2, "y": 0.3})
    assert not session.controller.pointer_events


def test_failed_manual_input_releases_takeover_gate(session: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    def fail(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("control unavailable")

    monkeypatch.setattr(session.controller, "click", fail)
    with pytest.raises(RuntimeError, match="control unavailable"):
        session.tap(0.2, 0.3)
    assert not session._manual_touch


def test_disconnect_closes_scheduler_before_controller(session: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from gamepilot.core import touch_scheduler

    order: list[str] = []
    monkeypatch.setattr(touch_scheduler, "close_touch_scheduler", lambda _controller: order.append("scheduler"))
    original_close = session.controller.close

    def close() -> None:
        order.append("controller")
        original_close()

    monkeypatch.setattr(session.controller, "close", close)
    session.stop()
    assert order[:2] == ["scheduler", "controller"]
