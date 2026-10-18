"""仅当环境变量 ``GAMEPILOT_TEST_SYNTHETIC=1`` 时加载；供单测 / RPC 联调，不出现在 device.list。"""

from __future__ import annotations

from typing import Any

import numpy as np

from .base import SUPPORTED_KEYS, Controller, Size, register

BUTTON: tuple[float, float, float, float] = (0.30, 0.30, 0.20, 0.10)
LOGO: tuple[float, float, float, float] = (0.60, 0.30, 0.16, 0.12)


@register
class SyntheticController(Controller):
    scheme = "Synthetic"
    description = "测试用合成画面"

    def __init__(
        self, device_id: str = "synthetic:test-1", width: int = 1280, height: int = 720, **options: Any
    ) -> None:
        super().__init__(device_id, **options)
        self.width = int(width)
        self.height = int(height)
        self.channel = "synthetic"
        self.link_note = "测试合成画面"
        self.frames = 0
        self.hits = 0
        self.keys: list[str] = []
        self.swipes: list[tuple[float, float, float, float, float]] = []
        self.touches: list[tuple[str, float, float]] = []

    def connect(self) -> None:
        self.frames = 0
        self.hits = 0
        self.keys = []
        self.swipes = []
        self.touches = []
        self._connected = True

    @property
    def resolution(self) -> Size:
        return (self.width, self.height)

    @property
    def link_fps(self) -> float:
        return float(self.frames)

    def screenshot(self) -> np.ndarray:
        self.frames += 1
        canvas = np.full((self.height, self.width, 3), 28, dtype=np.uint8)
        x, y, w, h = _pixels(BUTTON, self.resolution)
        canvas[y : y + h, x : x + w] = (240, 240, 240)
        lx, ly, lw, lh = _pixels(LOGO, self.resolution)
        canvas[ly : ly + lh, lx : lx + lw] = _checker(lw, lh)
        band = 30
        top = (self.frames * 6) % max(1, self.height - band)
        canvas[top : top + band, :] = (60, 120, 200)
        return canvas

    def press(self, name: str) -> None:
        if name not in SUPPORTED_KEYS:
            raise ValueError(f"不支持的按键: {name}")
        self.keys.append(name)

    def touch(self, phase: str, x: float, y: float) -> None:
        self.touches.append((phase, round(x, 4), round(y, 4)))

    def swipe(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        duration: float = 0.3,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        self.swipes.append((x1, y1, x2, y2, duration))
        if path:
            self.touches.extend(("move", round(x, 4), round(y, 4)) for x, y in path)

    def click(
        self,
        x: float,
        y: float,
        duration: float = 0.05,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            raise ValueError(f"归一化坐标越界: ({x}, {y})")
        bx, by, bw, bh = BUTTON
        if bx <= x <= bx + bw and by <= y <= by + bh:
            self.hits += 1

    def shell(self, command: str) -> str:
        return f"synthetic: {command}"


def _checker(width: int, height: int, cell: int = 6) -> np.ndarray:
    yy, xx = np.mgrid[0:height, 0:width]
    mask = ((xx // cell + yy // cell) % 2 == 0)[:, :, None]
    return np.where(mask, np.array([210, 210, 210], np.uint8), np.array([70, 70, 70], np.uint8)).astype(np.uint8)


def _pixels(rect: tuple[float, float, float, float], size: Size) -> tuple[int, int, int, int]:
    x, y, w, h = rect
    width, height = size
    return int(x * width), int(y * height), max(1, int(w * width)), max(1, int(h * height))
