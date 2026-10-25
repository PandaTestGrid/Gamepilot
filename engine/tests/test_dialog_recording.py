"""Disk-backed AI dialog recordings: exact indexing, concurrency, and cleanup."""

from __future__ import annotations

import base64
import os
import threading
import time
from pathlib import Path

import numpy as np
import pytest

from gamepilot.core.frame import Frame
from gamepilot.devices.synthetic_test import SyntheticController
from gamepilot.project import Project
from gamepilot.session import DeviceSession


def make_session(tmp_path: Path) -> DeviceSession:
    controller = SyntheticController()
    controller.connect()
    return DeviceSession("synthetic:recording", controller, Project(root=str(tmp_path)).ensure(), lambda *_: None)


def add_frame(session: DeviceSession, index: int) -> None:
    image = np.full((12, 16, 3), index % 256, dtype=np.uint8)
    session._record_frame(Frame(image=image, size=(16, 12), index=index))


def test_unlimited_frames_are_disk_backed_and_exact(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    try:
        started = session.start_recording()
        recording_id = started["recordingId"]
        session.set_stream_fps(0)
        for index in range(1, 1201):
            add_frame(session, index)
        assert len(session._frame_history) == 0
        assert session._recordings_dir is not None
        path = Path(session._recordings_dir) / f"{recording_id}.sqlite3"
        assert path.stat().st_size > 0
        first = session.recording_meta(recording_id, limit=500)
        assert first["count"] == 1200
        assert first["indices"] == list(range(1, 501))
        assert first["hasMore"] is True
        assert session.recording_meta(recording_id, after_index=500, limit=500)["indices"] == list(range(501, 1001))
        assert session.recording_meta(recording_id, after_index=1000)["indices"] == list(range(1001, 1101))
        with pytest.raises(ValueError, match="limit"):
            session.recording_meta(recording_id, limit=1000000)
        frame = session.recording_frame_at(recording_id, 1)
        assert frame["index"] == frame["requestedIndex"] == 1
        assert base64.b64decode(frame["jpeg"]).startswith(b"\xff\xd8")
        assert session.recording_frame_at(recording_id, 1200)["index"] == 1200
        with pytest.raises(ValueError, match="不存在"):
            session.recording_frame_at(recording_id, 1201)
        stopped = session.stop_recording(recording_id)
        assert stopped["count"] == 1200 and stopped["active"] is False
        assert session.recording_frame_at(recording_id, 1)["index"] == 1
        with pytest.raises(ValueError, match="正在进行"):
            session.stop_recording(recording_id)
        session.delete_recording(recording_id)
        assert not path.exists()
        with pytest.raises(ValueError, match="找不到"):
            session.recording_meta(recording_id)
    finally:
        session.stop()


def test_delete_active_then_restart_and_cleanup_close(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    first = session.start_recording()["recordingId"]
    directory = session._recordings_dir
    assert directory is not None
    with pytest.raises(RuntimeError, match="正在进行"):
        session.start_recording()
    add_frame(session, 10)
    session.delete_recording(first)
    second = session.start_recording()["recordingId"]
    add_frame(session, 11)
    add_frame(session, 13)  # capture ids may have gaps; retrieval must never substitute a neighbor
    assert session.recording_meta(second)["indices"] == [11, 13]
    with pytest.raises(ValueError, match="不存在"):
        session.recording_frame_at(second, 12)
    with pytest.raises(ValueError, match="正在进行"):
        session.stop_recording(first)
    with pytest.raises(ValueError):
        session.recording_frame_at("../../other-file", 10)
    session.stop()
    assert not os.path.exists(directory)
    with pytest.raises(RuntimeError, match="关闭"):
        session.start_recording()


def test_stop_races_writer_without_corrupting_db(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    recording_id = session.start_recording()["recordingId"]
    thread = threading.Thread(target=lambda: [add_frame(session, index) for index in range(1, 201)])
    thread.start()
    try:
        session.stop_recording(recording_id)
        thread.join(timeout=5)
        assert not thread.is_alive()
        meta = session.recording_meta(recording_id)
        assert meta["count"] <= 200
        if meta["count"]:
            assert session.recording_frame_at(recording_id, meta["lastIndex"])["index"] == meta["lastIndex"]
    finally:
        thread.join(timeout=5)
        session.stop()


def test_capture_loop_records_when_stream_disabled(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    session.start()
    try:
        recording_id = session.start_recording()["recordingId"]
        deadline = time.monotonic() + 4
        while session.recording_meta(recording_id)["count"] < 3 and time.monotonic() < deadline:
            time.sleep(0.05)
        assert session.recording_meta(recording_id)["count"] >= 3
        assert not session._frame_history
        session.stop_recording(recording_id)
    finally:
        session.stop()
