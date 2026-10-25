"""RecordingService: extracted session responsibility; shared state belongs to DeviceSession."""

from __future__ import annotations

import contextlib
import logging
import os
import shutil
import sqlite3
import tempfile
import uuid
from typing import TYPE_CHECKING, Any

from ..core.frame import Frame

if TYPE_CHECKING:
    from .device import DeviceSession


logger = logging.getLogger("gamepilot.session")


class RecordingService:
    def __init__(self, session: DeviceSession) -> None:
        self.session = session

    def close(self) -> None:
        """Close SQLite and remove temporary recordings after worker shutdown."""
        with self.session._recording_lock:
            self.session._recordings_closed = True
            if self.session._recording_db is not None:
                self.session._recording_db.close()
                self.session._recording_db = None
                self.session._recording_id = None
            if self.session._recordings_dir is not None:
                shutil.rmtree(self.session._recordings_dir)
                self.session._recordings_dir = None

    def _recording_loop(self) -> None:
        while not self.session._stop.is_set():
            with self.session._record_ready:
                self.session._record_ready.wait_for(
                    lambda: self.session._stop.is_set() or self.session._record_pending is not None
                )
                if self.session._stop.is_set():
                    return
                job, self.session._record_pending = self.session._record_pending, None
            if job is not None:
                frame, recording_id = job
                try:
                    self.session._record_frame(frame, recording_id=recording_id)
                except Exception:
                    logger.exception("录屏写入失败（投屏继续）: %s", self.session.device_id)

    def start_recording(self) -> dict[str, Any]:
        """Create an unlimited, disk-backed recording of captured (not merely streamed) frames."""
        with self.session._recording_lock:
            if self.session._recordings_closed:
                raise RuntimeError("会话已关闭，不能开始录屏")
            if self.session._recording_id is not None:
                raise RuntimeError("已有正在进行的录屏，请先停止")
            if self.session._recordings_dir is None:
                self.session._recordings_dir = tempfile.mkdtemp(prefix="gamepilot-recordings-")
            recording_id = uuid.uuid4().hex
            path = os.path.join(self.session._recordings_dir, f"{recording_id}.sqlite3")
            db = sqlite3.connect(path, check_same_thread=False)
            try:
                db.execute(
                    "CREATE TABLE frames (idx INTEGER PRIMARY KEY, jpeg BLOB NOT NULL, "
                    "width INTEGER NOT NULL, height INTEGER NOT NULL, ts REAL NOT NULL)"
                )
                db.commit()
            except BaseException:
                db.close()
                with contextlib.suppress(OSError):
                    os.remove(path)
                raise
            self.session._recording_id = recording_id
            self.session._recording_db = db
            return {"recordingId": recording_id, "active": True, "count": 0, "firstIndex": 0, "lastIndex": 0}

    def _recording_path(self, recording_id: str) -> str:
        # UUID hex is the only permissible filename, even if supplied by an untrusted RPC caller.
        if len(recording_id) != 32 or any(char not in "0123456789abcdef" for char in recording_id):
            raise ValueError("无效的 recordingId")
        if self.session._recordings_dir is None:
            raise ValueError("找不到这段录屏")
        path = os.path.join(self.session._recordings_dir, f"{recording_id}.sqlite3")
        if not os.path.isfile(path):
            raise ValueError("找不到这段录屏")
        return path

    def _record_frame(self, frame: Frame, *, recording_id: str | None = None) -> None:
        with self.session._recording_lock:
            if recording_id is not None and recording_id != self.session._recording_id:
                return
            recording_id = self.session._recording_id
            if recording_id is None or self.session._recordings_closed:
                return
        # JPEG compression is expensive; do it outside the state lock, then recheck
        # whether stop/delete/close raced with this capture before committing.
        jpeg = self.session._encode_jpeg(frame.image)
        if not jpeg:
            return
        with self.session._recording_lock:
            db = self.session._recording_db
            if db is None or self.session._recordings_closed or self.session._recording_id != recording_id:
                return
            try:
                db.execute(
                    "INSERT INTO frames VALUES (?, ?, ?, ?, ?)",
                    (frame.index, jpeg, int(frame.size[0]), int(frame.size[1]), frame.ts),
                )
                db.commit()
            except sqlite3.Error:
                logger.exception("录屏写盘失败，停止录屏（设备 %s）", self.session.device_id)
                db.close()
                self.session._recording_db = None
                self.session._recording_id = None

    def _recording_summary(self, db: sqlite3.Connection, recording_id: str) -> dict[str, Any]:
        count, first, last = db.execute("SELECT count(*), min(idx), max(idx) FROM frames").fetchone()
        return {
            "recordingId": recording_id,
            "active": recording_id == self.session._recording_id,
            "count": count,
            "firstIndex": first or 0,
            "lastIndex": last or 0,
        }

    def stop_recording(self, recording_id: str | None = None) -> dict[str, Any]:
        with self.session._recording_lock:
            if self.session._recording_id is None or (
                recording_id is not None and recording_id != self.session._recording_id
            ):
                raise ValueError("找不到正在进行的录屏")
            assert self.session._recording_db is not None
            result = self.session._recording_summary(self.session._recording_db, self.session._recording_id)
            self.session._recording_db.close()
            self.session._recording_db = None
            self.session._recording_id = None
            result["active"] = False
            return result

    def recording_meta(self, recording_id: str, *, after_index: int = -1, limit: int = 100) -> dict[str, Any]:
        """Page exact frame indices without loading an entire recording into memory."""
        if not 1 <= limit <= 500:
            raise ValueError("limit 必须在 1 到 500 之间")
        with self.session._recording_lock:
            path = self.session._recording_path(recording_id)
            # A live writer shares its connection; finished recordings open read-only.
            with (
                contextlib.nullcontext(self.session._recording_db)
                if recording_id == self.session._recording_id
                else contextlib.closing(sqlite3.connect(path))
            ) as db:
                assert db is not None
                result = self.session._recording_summary(db, recording_id)
                indices = [
                    row[0]
                    for row in db.execute(
                        "SELECT idx FROM frames WHERE idx > ? ORDER BY idx LIMIT ?", (after_index, limit + 1)
                    )
                ]
            result["indices"] = indices[:limit]
            result["hasMore"] = len(indices) > limit
            result["nextAfterIndex"] = result["indices"][-1] if result["indices"] else after_index
            return result

    def recording_frame_at(self, recording_id: str, index: int) -> dict[str, Any]:
        """Fetch exactly one recorded index; gaps are errors, never nearest-frame fallback."""
        with self.session._recording_lock:
            path = self.session._recording_path(recording_id)
            with (
                contextlib.nullcontext(self.session._recording_db)
                if recording_id == self.session._recording_id
                else contextlib.closing(sqlite3.connect(path))
            ) as db:
                assert db is not None
                row = db.execute("SELECT idx, jpeg, width, height, ts FROM frames WHERE idx = ?", (index,)).fetchone()
            if row is None:
                raise ValueError(f"录屏中不存在第 {index} 帧")
            return self.session._frame_payload(row, index)

    def delete_recording(self, recording_id: str) -> None:
        with self.session._recording_lock:
            path = self.session._recording_path(recording_id)
            if recording_id == self.session._recording_id:
                assert self.session._recording_db is not None
                self.session._recording_db.close()
                self.session._recording_db = None
                self.session._recording_id = None
            os.remove(path)
