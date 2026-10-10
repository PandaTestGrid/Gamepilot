"""Mock 设备：不依赖任何真机，用来验证链路与跑单测。

第 1 块提供「发现」与一个可连接的空壳；合成画面（会动的元素、随机弹窗）
在第 2~3 块补，那里才是真正需要它的时候。
"""

from __future__ import annotations

import numpy as np

from .base import KIND_MOCK, STATUS_DISCOVERED, Controller, DeviceInfo, Size, register

MOCK_SERIAL = "mock-1"
MOCK_DEVICE_ID = f"mock:{MOCK_SERIAL}"
MOCK_URI = "Mock:///?width=1280&height=720"


def discover() -> list[DeviceInfo]:
    """Mock 设备永远存在：这样即使用户一台真机都没有，界面也能跑通全流程。"""
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
    description = "离线合成设备（无需真机，用于验证链路）"

    def __init__(
        self, device_id: str = MOCK_DEVICE_ID, width: int = 1280, height: int = 720, **options: object
    ) -> None:
        super().__init__(device_id, **options)
        self.width = int(width)
        self.height = int(height)
        self.frames = 0

    def connect(self) -> None:
        self.frames = 0
        self._connected = True

    @property
    def resolution(self) -> Size:
        return (self.width, self.height)

    def screenshot(self) -> np.ndarray:
        """合成一帧：渐变色 + 随帧号移动的方块（第 2 块会换成真正的"游戏界面"）。"""
        self.frames += 1
        canvas = np.zeros((self.height, self.width, 3), dtype=np.uint8)
        canvas[:, :, 0] = 24
        canvas[:, :, 1] = 26
        canvas[:, :, 2] = 32
        band = 40
        top = (self.frames * 4) % max(1, self.height - band)
        canvas[top : top + band, self.width // 4 : self.width // 2] = (200, 120, 60)
        return canvas

    def click(self, x: float, y: float) -> None:
        self.frames += 0  # 记录性动作；第 2 块接入真实事件流

    def shell(self, command: str) -> str:
        return f"mock: {command}"
