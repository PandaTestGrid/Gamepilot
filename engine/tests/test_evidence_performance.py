"""Event-gated evidence writer regressions, independent of disk speed thresholds."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pytest

from gamepilot.core.evidence import RunEvidence
from gamepilot.core.flow_engine import FlowEngine
from gamepilot.core.graph import Graph
from gamepilot.devices.synthetic_test import SyntheticController
from gamepilot.project import Project
from gamepilot.session import DeviceSession, WorkflowRunner


def test_slow_jpeg_does_not_block_steps_and_pending_screenshots_are_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entered = threading.Event()
    release = threading.Event()
    original = cv2.imencode

    def blocked(*args: Any, **kwargs: Any) -> Any:
        entered.set()
        assert release.wait(3)
        return original(*args, **kwargs)

    monkeypatch.setattr(cv2, "imencode", blocked)
    evidence = RunEvidence(tmp_path)
    image = np.zeros((8, 8, 3), dtype=np.uint8)
    try:
        first = evidence.step(1, "first", "click", image)
        assert entered.wait(3)
        assert first["screenshot"] == "", "pending screenshot must not claim a written file"
        records = [evidence.step(index, str(index), "click", image) for index in range(2, 102)]
        snapshot = evidence.to_dict()
        assert snapshot["pendingScreenshots"] == 8
        assert snapshot["droppedScreenshots"] == 92
        assert all(record["screenshot"] == "" for record in records)
        for index in range(200):
            evidence.event({"seq": index, "type": "step_finished"})
        evidence.event({"seq": 200, "type": "flow_finished", "result": "failure"})
        release.set()
        evidence.close()
        assert first["screenshot"]
        assert sum(bool(record["screenshot"]) for record in records) == 8
        lines = (evidence.dir / "trace.jsonl").read_text(encoding="utf-8").splitlines()
        assert [json.loads(line)["seq"] for line in lines] == list(range(201))
        snapshot = evidence.to_dict()
        assert not snapshot["pendingScreenshots"]
        assert not snapshot["writerPending"]
        evidence.close()
        assert evidence.to_dict() == snapshot
    finally:
        release.set()
        evidence.close()


def test_same_filename_pending_updates_keep_latest_and_count_dropped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entered = threading.Event()
    release = threading.Event()
    original = cv2.imencode

    def blocked(*args: Any, **kwargs: Any) -> Any:
        entered.set()
        assert release.wait(3)
        return original(*args, **kwargs)

    monkeypatch.setattr(cv2, "imencode", blocked)
    evidence = RunEvidence(tmp_path)
    image = np.zeros((8, 8, 3), dtype=np.uint8)
    try:
        evidence.step(0, "busy", "click", image)
        assert entered.wait(3)
        old = evidence.step(1, "same", "click", image)
        latest = evidence.step(1, "same", "click", image)
        assert evidence.to_dict()["droppedScreenshots"] == 1
        release.set()
        evidence.close()
        assert old["screenshot"] == ""
        assert latest["screenshot"]
    finally:
        release.set()
        evidence.close()


def test_finished_state_publishes_evidence_before_slow_close_without_holding_state_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    controller = SyntheticController()
    controller.connect()
    session = DeviceSession(
        "synthetic:evidence-race", controller, Project(root=str(tmp_path)).ensure(), lambda *_: None
    )
    engine = FlowEngine(Graph.empty(str(tmp_path)), controller)
    evidence = RunEvidence(tmp_path)
    record = evidence.step(1, "done", "manual", np.zeros((8, 8, 3), dtype=np.uint8))
    engine.attach_evidence(evidence)
    root = session._root_key(str(tmp_path))
    runner = WorkflowRunner(root, engine.graph, engine)
    session.runners[root] = runner
    session.running = True
    closing = threading.Event()
    release = threading.Event()
    errors: list[BaseException] = []
    original = evidence.close

    def close() -> None:
        if threading.current_thread().name == "finish-run":
            closing.set()
            assert release.wait(3)
        original()

    monkeypatch.setattr(evidence, "close", close)

    def finish() -> None:
        try:
            session._complete_run(root, "success", expected=runner)
        except BaseException as error:
            errors.append(error)

    thread = threading.Thread(target=finish, name="finish-run")
    thread.start()
    try:
        assert closing.wait(3)
        assert not session.running
        # The collector is blocked before close: callers must still see the
        # published handle and may independently drain it outside session.lock.
        bundle = session.evidence_bundle()
        assert bundle is not None
        assert bundle["steps"][0]["screenshot"] == record["screenshot"] != ""
        assert session.status()["running"] is False
        acquired = session.lock.acquire(timeout=1)
        assert acquired
        session.lock.release()
        release.set()
        thread.join(3)
        assert not errors
        assert not thread.is_alive()
    finally:
        release.set()
        thread.join(3)
        session.stop()


def test_step_records_are_bounded_and_merge_targets_latest_retained_record(tmp_path: Path) -> None:
    evidence = RunEvidence(tmp_path)
    try:
        for index in range(5007):
            evidence.step(index, str(index), "setvar")
        evidence.merge(5006, {"result": "last"})
        evidence.merge(0, {"result": "already evicted"})
        snapshot = evidence.to_dict()
        assert len(snapshot["steps"]) == 5000
        assert snapshot["steps"][0]["index"] == 7
        assert snapshot["steps"][-1]["result"] == "last"
        assert snapshot["droppedStepRecords"] == 7
    finally:
        evidence.close()


def test_close_timeout_returns_without_claiming_pending_image_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entered = threading.Event()
    release = threading.Event()
    original = cv2.imencode

    def blocked(*args: Any, **kwargs: Any) -> Any:
        entered.set()
        assert release.wait(3)
        return original(*args, **kwargs)

    monkeypatch.setattr(cv2, "imencode", blocked)
    evidence = RunEvidence(tmp_path)
    evidence._close_timeout = 0.01
    try:
        record = evidence.step(1, "blocked", "click", np.zeros((8, 8, 3), dtype=np.uint8))
        assert entered.wait(3)
        evidence.close()
        assert record["screenshot"] == ""
        assert evidence.to_dict()["writerPending"]
        release.set()
        evidence._writer.join(3)
        assert not evidence._writer.is_alive()
        assert record["screenshot"]
        evidence.close()
        assert not evidence.to_dict()["writerPending"]
    finally:
        release.set()
        evidence._writer.join(3)
