"""帧与识别结果的统一协议。"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .geometry import Rect, Size


@dataclass
class Frame:
    """一帧设备画面（BGR）。size 是设备逻辑分辨率，image 可能已被缩放。"""

    image: np.ndarray
    size: Size
    ts: float = field(default_factory=time.time)
    index: int = 0

    @property
    def image_size(self) -> Size:
        height, width = self.image.shape[:2]
        return (int(width), int(height))

    def crop(self, rect: Rect) -> np.ndarray:
        x, y, w, h = rect.clamp().to_pixels(self.image_size)
        return self.image[y : y + h, x : x + w]


@dataclass
class Detection:
    label: str
    rect: Rect
    score: float = 1.0
    source: str = "template"
    state: str = "idle"  # confirmed | pending | idle（由投票过滤决定）

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "rect": self.rect.to_list(),
            "score": round(float(self.score), 4),
            "source": self.source,
            "state": self.state,
        }


def best_per_label(detections: list[Detection]) -> dict[str, Any]:
    """同一标签只保留分数最高的一条（投票与 UI 都按标签工作）。"""
    best: dict[str, Detection] = {}
    for detection in detections:
        current = best.get(detection.label)
        if current is None or detection.score > current.score:
            best[detection.label] = detection
    return best
