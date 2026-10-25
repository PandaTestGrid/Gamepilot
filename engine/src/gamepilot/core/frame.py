"""帧与识别结果的统一协议。"""

from __future__ import annotations

import time
from collections.abc import Sequence
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
    # 异步识别运行时策略：None 保留 max_age_frames；否则按源图 ts 的真实年龄过期。
    # ts 必须保持采集时刻（time.time），不能用推理完成时刻刷新。
    async_max_age_seconds: float | None = None
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
    # 同一标签在画面里的全部不同命中（含 `rect` 本身，按阅读顺序）。
    # 只有一个命中时为空 —— 老消费方只看 `rect` 的行为完全不变。
    candidates: list[Rect] = field(default_factory=list)

    def all_rects(self) -> list[Rect]:
        """这一帧所有可选目标：多命中时是候选列表，否则就是主框。"""
        return self.candidates if len(self.candidates) > 1 else [self.rect]

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "label": self.label,
            "rect": self.rect.to_list(),
            "score": round(float(self.score), 4),
            "source": self.source,
            "state": self.state,
            "ambiguous": bool(self.ambiguous),
        }
        # 只有一个命中时不发这个字段：老界面/老脚本不用改，也能少一点 payload。
        if len(self.candidates) > 1:
            out["candidates"] = [item.to_list() for item in self.candidates]
        return out


def _same_target(a: Rect, b: Rect) -> bool:
    """两个矩形是不是同一个目标（多尺度命中会差几个像素）。"""
    return abs(a.cx - b.cx) <= 0.5 * max(a.w, b.w) and abs(a.cy - b.cy) <= 0.5 * max(a.h, b.h)


def reading_order(rects: Sequence[Rect]) -> list[Rect]:
    """按「从上到下、从左到右」排：同一行允许一点上下抖动。"""
    if len(rects) <= 1:
        return list(rects)
    rows: list[list[Rect]] = []
    for rect in sorted(rects, key=lambda item: (item.cy, item.cx)):
        if rows and abs(rows[-1][0].cy - rect.cy) <= 0.5 * max(rows[-1][0].h, rect.h):
            rows[-1].append(rect)
        else:
            rows.append([rect])
    ordered: list[Rect] = []
    for row in rows:
        ordered.extend(sorted(row, key=lambda item: item.cx))
    return ordered


def best_per_label(detections: list[Detection]) -> dict[str, Detection]:
    """同一标签保留分数最高的一条，并把其它不同位置收进 `candidates`。

    老行为（只留最高分）仍然是默认的点击语义；候选列表只是让步骤可以选择
    「最近的 / 第 N 个 / 最左 / 全部」这些策略。
    """
    grouped: dict[str, list[Detection]] = {}
    for detection in detections:
        grouped.setdefault(detection.label, []).append(detection)

    best: dict[str, Detection] = {}
    for label, items in grouped.items():
        primary = max(items, key=lambda item: item.score)
        # 歧义标记可能挂在另一个尺度/位置的命中上：按 label 汇总，别让最高分那条把它丢掉
        if any(item.ambiguous for item in items):
            primary.ambiguous = True
        distinct: list[Rect] = []
        for item in sorted(items, key=lambda item: item.score, reverse=True):
            if all(not _same_target(item.rect, kept) for kept in distinct):
                distinct.append(item.rect)
        primary.candidates = reading_order(distinct) if len(distinct) > 1 else []
        best[label] = primary
    return best
