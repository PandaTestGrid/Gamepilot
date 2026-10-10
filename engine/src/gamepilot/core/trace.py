"""时间轴缓冲：最近 N 条事件 + 每帧摘要，供 UI 回溯（M4 再接真实帧回放）。"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any


@dataclass
class TraceEvent:
    seq: int
    ts: float
    type: str
    node: str | None = None
    edge: str | None = None
    message: str = ""
    extra: dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "seq": self.seq,
            "ts": round(self.ts, 3),
            "type": self.type,
            "node": self.node,
            "edge": self.edge,
            "message": self.message,
            "extra": self.extra,
        }


class TraceBuffer:
    def __init__(self, max_events: int = 1000, max_frames: int = 300) -> None:
        self.events: deque[TraceEvent] = deque(maxlen=max_events)
        self.frames: deque[dict[str, Any]] = deque(maxlen=max_frames)
        self._lock = threading.Lock()

    def add_event(self, event: TraceEvent) -> None:
        with self._lock:
            self.events.append(event)

    def add_frame(self, index: int, node: str | None, detections: list[dict[str, Any]]) -> None:
        with self._lock:
            self.frames.append(
                {
                    "index": index,
                    "ts": round(time.time(), 3),
                    "node": node,
                    "detections": {item["label"]: item["score"] for item in detections},
                }
            )

    def recent_events(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock:
            return [event.to_dict() for event in list(self.events)[-limit:]]

    def recent_frames(self, limit: int = 60) -> list[dict[str, Any]]:
        with self._lock:
            return list(self.frames)[-limit:]
