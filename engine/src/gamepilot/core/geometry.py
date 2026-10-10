"""归一化几何：Rect 全部是 [0,1] 相对坐标，像素换算只在设备层/识别层内部发生。

这条铁律的价值在多设备场景里最明显：同一份状态图可以跑在 720p 的 OPPO A57 和
2280p 的 MI 8 Lite 上，录制出来的模板与 ROI 不需要任何换算。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

Size = tuple[int, int]


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    w: float = 0.0
    h: float = 0.0

    def __post_init__(self) -> None:
        if self.w < 0 or self.h < 0:
            raise ValueError(f"Rect 宽高不能为负: {self!r}")

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    @property
    def center(self) -> tuple[float, float]:
        return (self.cx, self.cy)

    def clamp(self) -> Rect:
        x1 = min(max(self.x, 0.0), 1.0)
        y1 = min(max(self.y, 0.0), 1.0)
        x2 = min(max(self.x + self.w, 0.0), 1.0)
        y2 = min(max(self.y + self.h, 0.0), 1.0)
        return Rect(x1, y1, max(0.0, x2 - x1), max(0.0, y2 - y1))

    def to_pixels(self, size: Size) -> tuple[int, int, int, int]:
        width, height = size
        return (
            round(self.x * width),
            round(self.y * height),
            max(1, round(self.w * width)),
            max(1, round(self.h * height)),
        )

    @classmethod
    def from_pixels(cls, x: float, y: float, w: float, h: float, size: Size) -> Rect:
        width, height = size
        if width <= 0 or height <= 0:
            raise ValueError(f"非法分辨率: {size}")
        return cls(x / width, y / height, w / width, h / height)

    def to_list(self) -> list[float]:
        return [round(self.x, 6), round(self.y, 6), round(self.w, 6), round(self.h, 6)]

    @classmethod
    def parse(cls, value: Rect | Sequence[float] | dict[str, Any]) -> Rect:
        if isinstance(value, Rect):
            return value
        if isinstance(value, dict):
            return cls(float(value["x"]), float(value["y"]), float(value.get("w", 0)), float(value.get("h", 0)))
        seq = list(value)
        if len(seq) != 4:
            raise ValueError(f"Rect 需要 [x, y, w, h]，收到: {value!r}")
        return cls(*(float(item) for item in seq))
