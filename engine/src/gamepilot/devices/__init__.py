"""Devices 层入口：扫描 + 控制器注册。

`scan()` 是唯一给上层的发现接口，约定：
- **绝不抛异常**：单个来源失败（adb 没装、usbmux 不可用）只记进 `errors`，
  其它来源照常返回，UI 才能显示"Android 扫描失败，但 Mock 可用"；
- 结果按 (kind, name) 排序，保证 UI 列表顺序稳定。
"""

from __future__ import annotations

from collections.abc import Callable

from . import android, mock
from .base import (  # noqa: F401
    KIND_ANDROID,
    KIND_EMULATOR,
    KIND_MOCK,
    KIND_REMOTE,
    KIND_WINDOWS,
    STATUS_CONNECTED,
    STATUS_DISCOVERED,
    STATUS_FAILED,
    Controller,
    DeviceInfo,
    ScanResult,
    Size,
    available_schemes,
    controller_for_scheme,
    register,
    register_scheme,
)

_SEEN: set[str] = set()


def _providers() -> list[tuple[str, Callable[[], list[DeviceInfo]]]]:
    """设备来源清单。新增平台（iOS / Windows / 鸿蒙）在这里加一行即可。"""
    return [
        ("android", android.discover),
        ("mock", mock.discover),
    ]


def scan() -> ScanResult:
    result = ScanResult()
    for name, provider in _providers():
        try:
            result.devices.extend(provider())
        except Exception as exc:  # pragma: no cover - 兜底：任何来源都不该拖垮扫描
            result.errors.append({"provider": name, "message": f"{type(exc).__name__}: {exc}"})
    result.devices.sort(key=lambda device: (device.kind, device.name))
    return result
