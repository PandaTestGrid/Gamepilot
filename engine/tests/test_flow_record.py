"""录操作 → flow.steps（单元 + RPC）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from gamepilot.core.actions import Action
from gamepilot.core.flow_record import action_to_flow_step
from test_rpc_session import DEVICE_ID, DEVICE_URI, EngineProcess


@pytest.fixture()
def engine(tmp_path: Path) -> Any:
    instance = EngineProcess(str(tmp_path))
    ready = instance.read()
    assert ready["method"] == "engine.ready"
    yield instance
    instance.close()


def test_click_coordinate_becomes_flow_step() -> None:
    step = action_to_flow_step(Action.parse({"type": "click", "x": 0.2, "y": 0.8}), step_id="s1")
    assert step["type"] == "click"
    assert step["params"]["by"] == "coord"
    assert step["params"]["x"] == pytest.approx(0.2)


def test_recognizer_click_records_english_mode_and_preserves_user_label() -> None:
    recorded = action_to_flow_step(Action.parse({"type": "click", "target": "挑战按钮"}), step_id="s1")
    assert recorded["params"] == {"by": "recognizer", "rec": "挑战按钮"}


def test_wait_becomes_delay_ms() -> None:
    step = action_to_flow_step(Action.parse({"type": "wait", "seconds": 1.5}), step_id="s2")
    assert step["type"] == "delay"
    assert step["params"]["ms"] == 1500


def test_record_action_appends_flow_step(engine: EngineProcess, tmp_path: Path) -> None:
    """有 flow.steps 时 record.action 只改链，不造 edges。"""
    ws = tmp_path / "ws"
    ws.mkdir()
    engine.call("workspace.add", {"dir": str(ws), "name": "测试", "create": True})
    engine.call("device.connect", {"uri": DEVICE_URI})
    engine.call("workflow.create", {"name": "链"})

    result = engine.call(
        "record.action",
        {"deviceId": DEVICE_ID, "action": {"type": "click", "x": 0.4, "y": 0.6}},
    )
    graph = result["graph"]
    steps = graph.get("flow", {}).get("steps") or []
    assert len(steps) >= 2
    last = steps[-1]
    assert last["type"] == "click"
    assert result.get("stepId") == last["id"]
    assert not graph.get("edges")
