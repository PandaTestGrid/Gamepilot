"""Frame metadata keeps parallel active-step snapshots without waiting for execution."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import numpy as np
import pytest

from gamepilot.core.frame import Frame
from gamepilot.devices.synthetic_test import SyntheticController
from gamepilot.project import Project
from gamepilot.session import DeviceSession


@pytest.mark.parametrize("active", [["left", "right"], [], None])
def test_frame_contains_active_steps_without_execution_lock(tmp_path: Path, active: list[str] | None) -> None:
    controller = SyntheticController()
    controller.connect()
    events: list[dict[str, Any]] = []
    session = DeviceSession(
        "synthetic",
        controller,
        Project(root=str(tmp_path)).ensure(),
        lambda method, params: events.append(params) if method == "engine.frame" else None,
    )
    engine = Mock(current="legacy")
    if active is None:
        del engine.active_step_ids
    else:
        engine.active_step_ids = active
    session.engine = engine
    frame = Frame(image=np.zeros((2, 2, 3), dtype=np.uint8), size=(2, 2), index=1)
    # Execution lock may be owned by a slow device action; capture metadata must not take it.
    lock = session._execution_lock
    entered = threading.Event()
    release = threading.Event()

    def hold() -> None:
        with lock:
            entered.set()
            assert release.wait(5)

    worker = threading.Thread(target=hold)
    worker.start()
    try:
        assert entered.wait(2)
        session._emit_frame(frame, [])
    finally:
        release.set()
        worker.join(timeout=2)
    assert events[-1]["activeStepIds"] == (["legacy"] if active is None else active)
    if active is not None:
        active.append("late-update")
        assert "late-update" not in events[-1]["activeStepIds"]


def test_active_step_transient_does_not_break_frame_capture(tmp_path: Path) -> None:
    controller = SyntheticController()
    controller.connect()
    events: list[dict[str, Any]] = []
    session = DeviceSession(
        "synthetic",
        controller,
        Project(root=str(tmp_path)).ensure(),
        lambda method, params: events.append(params) if method == "engine.frame" else None,
    )

    class TransientEngine:
        current = "fallback"

        @property
        def active_step_ids(self) -> list[str]:
            raise RuntimeError("parallel children changed")

    session.engine = TransientEngine()  # type: ignore[assignment]
    session._emit_frame(Frame(image=np.zeros((2, 2, 3), dtype=np.uint8), size=(2, 2), index=1), [])
    assert events[-1]["activeStepIds"] == ["fallback"]
