"""Devices 层入口：扫描 + 控制器注册。

`scan()` 是唯一给上层的发现接口，约定：
- **绝不抛异常**：单个来源失败（adb 没装、usbmux 不可用）只记进 `errors`，
  其它来源照常返回，UI 才能显示"Android 扫描失败，但 iOS 照常可用"；
- 结果按 (kind, name) 排序，保证 UI 列表顺序稳定。
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable

from . import android, ios, macos, windows

if os.environ.get("GAMEPILOT_TEST_SYNTHETIC") == "1":
    from . import synthetic_test  # noqa: F401
from .base import (  # noqa: F401
    KIND_ANDROID,
    KIND_EMULATOR,
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

IOS_APPLE_USBMUX_ERROR = "iOS 扫描失败：未检测到 Apple Mobile Device Service（通常与 iTunes / Apple Devices 未安装或未启动有关）；Android 扫描不受影响"

# 界面方向码 → 中文标签（iOS 横屏坐标变换会变，状态栏里显示它便于排查）
ORIENTATION_LABELS: dict[int, str] = {
    1: "竖屏",
    2: "竖屏（倒置）",
    3: "横屏（Home 在右）",
    4: "横屏（Home 在左）",
}

_SEEN: set[str] = set()


def _providers() -> list[tuple[str, Callable[[], list[DeviceInfo]]]]:
    """设备来源清单。新增平台（iOS / Windows / 鸿蒙）在这里加一行即可。"""
    return [
        ("android", android.discover),
        ("ios", ios.discover),
        ("macos", macos.discover),  # macOS 本机窗口（非 macOS 自动返回空）
        ("windows", windows.discover),  # Windows 本机窗口（非 Windows 自动返回空）
    ]


def _provider_error(name: str, exc: Exception) -> str:
    # 只影响 iOS 这一路：Android 设备继续照常返回，并在弹层里显示一条可执行提示。
    if (
        name == "ios"
        and sys.platform == "win32"
        and ("Usbmuxd" in type(exc).__name__ or "ConnectionFailedToUsbmuxd" in type(exc).__name__)
    ):
        return IOS_APPLE_USBMUX_ERROR
    return f"{type(exc).__name__}: {exc}"


def scan() -> ScanResult:
    result = ScanResult()
    for name, provider in _providers():
        try:
            result.devices.extend(provider())
        except Exception as exc:  # pragma: no cover - 兜底：任何来源都不该拖垮扫描
            result.errors.append({"provider": name, "message": _provider_error(name, exc)})
    result.devices.sort(key=lambda device: (device.kind, device.name))
    return result
