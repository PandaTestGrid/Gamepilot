"""Mock 设备：不需要真机就能把整条链路跑起来（也是端到端测试的夹具）。

画面刻意设计成**可控**的：
- 一个固定的白色方块（稳定目标）：录制成模板后，后续帧都能匹配到；
- 一条会动的高亮带（动态干扰）：验证模板匹配不会被移动元素骗到；
- 点击白色方块会计数（`hits`），点别处不计数 —— 状态机的动作能被断言。
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .base import KIND_MOCK, STATUS_DISCOVERED, Controller, DeviceInfo, Size, register

MOCK_SERIAL = "mock-1"
MOCK_DEVICE_ID = f"mock:{MOCK_SERIAL}"
MOCK_URI = "Mock:///?width=1280&height=720"

# 归一化的固定按钮（录制/识别的稳定目标）
# BUTTON 是纯色（录制时会自动降级成颜色识别器），LOGO 有纹理（走模板匹配）
BUTTON: tuple[float, float, float, float] = (0.30, 0.30, 0.20, 0.10)
LOGO: tuple[float, float, float, float] = (0.60, 0.30, 0.16, 0.12)


def discover() -> list[DeviceInfo]:
    """Mock 设备永远存在：即使用户一台真机都没有，界面也能跑通全流程。"""
    return [
        DeviceInfo(
            id=MOCK_DEVICE_ID,
            uri=MOCK_URI,
            name="Mock 合成设备",
            kind=KIND_MOCK,
            status=STATUS_DISCOVERED,
            serial=MOCK_SERIAL,
            model="mock",
            resolution=(1280, 720),
        )
    ]


@register
class MockController(Controller):
    """URI: ``Mock:///?width=1280&height=720``"""

    scheme = "Mock"
    description = "离线合成设备（无需真机，用于验证链路与跑测试）"

    def __init__(self, device_id: str = MOCK_DEVICE_ID, width: int = 1280, height: int = 720, **options: Any) -> None:
        super().__init__(device_id, **options)
        self.width = int(width)
        self.height = int(height)
        self.frames = 0
        self.hits = 0

    def connect(self) -> None:
        self.frames = 0
        self.hits = 0
        self._connected = True

    @property
    def resolution(self) -> Size:
        return (self.width, self.height)

    def screenshot(self) -> np.ndarray:
        self.frames += 1
        canvas = np.full((self.height, self.width, 3), 28, dtype=np.uint8)
        x, y, w, h = _pixels(BUTTON, self.resolution)
        canvas[y : y + h, x : x + w] = (240, 240, 240)
        lx, ly, lw, lh = _pixels(LOGO, self.resolution)
        canvas[ly : ly + lh, lx : lx + lw] = _checker(lw, lh)
        # 动态干扰：一条上下移动的色带
        band = 30
        top = (self.frames * 6) % max(1, self.height - band)
        canvas[top : top + band, :] = (60, 120, 200)
        return canvas

    def click(self, x: float, y: float) -> None:
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            raise ValueError(f"归一化坐标越界: ({x}, {y})")
        bx, by, bw, bh = BUTTON
        if bx <= x <= bx + bw and by <= y <= by + bh:
            self.hits += 1

    def shell(self, command: str) -> str:
        return f"mock: {command}"


def _checker(width: int, height: int, cell: int = 6) -> np.ndarray:
    """棋盘格纹理：模板匹配需要非恒定像素，否则 NCC 退化。"""
    yy, xx = np.mgrid[0:height, 0:width]
    mask = ((xx // cell + yy // cell) % 2 == 0)[:, :, None]
    return np.where(mask, np.array([210, 210, 210], np.uint8), np.array([70, 70, 70], np.uint8)).astype(np.uint8)


def _pixels(rect: tuple[float, float, float, float], size: Size) -> tuple[int, int, int, int]:
    x, y, w, h = rect
    width, height = size
    return int(x * width), int(y * height), max(1, int(w * width)), max(1, int(h * height))
