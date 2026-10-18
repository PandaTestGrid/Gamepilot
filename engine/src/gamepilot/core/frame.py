"""帧与识别结果的统一协议。"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from .geometry import Rect, Size


@dataclass
class Frame:
    """一帧设备画面（BGR）。size 是设备逻辑分辨率，image 可能已被缩放。"""

    image: np.ndarray
    size: Size
    ts: float = field(default_factory=time.time)
    index: int = 0
    # 整帧灰度的惰性缓存。模板匹配全屏搜索时多个识别器共用同一张灰度图，
    # 避免每个识别器各自 cvtColor 一整帧（1080p 一次约 3ms）。
    _gray: np.ndarray | None = field(default=None, init=False, repr=False, compare=False)

    @property
    def image_size(self) -> Size:
        height, width = self.image.shape[:2]
        return (int(width), int(height))

    def gray(self) -> np.ndarray:
        """整帧灰度（BGR/BGRA → GRAY）。同一帧只算一次；调用方不得原地修改返回值。"""
        if self._gray is None:
            image = self.image
            if image.ndim == 2:
                self._gray = image
            elif image.shape[2] == 4:
                self._gray = cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
            else:
                self._gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        return self._gray

    def gray_crop(self, rect: Rect) -> np.ndarray:
        """按归一化矩形裁一块灰度图（返回的是整帧灰度图的视图，不拷贝）。"""
        x, y, w, h = rect.clamp().to_pixels(self.image_size)
        return self.gray()[y : y + h, x : x + w]

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
    # 同一标签有多个同分且位置明显不同的候选（全屏搜索时常见）：
    # 用于界面提示，也用于让点击动作拒绝"猜一个"（见 flow_engine / state_machine）。
    ambiguous: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "rect": self.rect.to_list(),
            "score": round(float(self.score), 4),
            "source": self.source,
            "state": self.state,
            "ambiguous": bool(self.ambiguous),
        }


def best_per_label(detections: list[Detection]) -> dict[str, Any]:
    """同一标签只保留分数最高的一条（投票与 UI 都按标签工作）。"""
    best: dict[str, Detection] = {}
    for detection in detections:
        current = best.get(detection.label)
        if current is None or detection.score > current.score:
            best[detection.label] = detection
    return best
