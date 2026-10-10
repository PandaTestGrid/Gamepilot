"""Android 设备：发现 + 控制器（第 1 块只做「发现」；截图/输入在第 2 块接）。

发现逻辑参考 panda-agent `src/pda/devices/provider.py::AndroidProvider`：
用 `adbutils.AdbClient().list(extended=True)` 一次拿到 serial/state/tags，
避免为每台设备各起一次 adb 进程。

与参考实现的差异：
1. 坐标对外归一化（内部才换算像素）；
2. 把 adb state 映射成 UI 能直接展示的 status + error + suggested_fix，
   而不是让 UI 自己解释 `unauthorized`；
3. 分辨率按需查询（`wm size`），失败不影响设备出现在列表里。
"""

from __future__ import annotations

import logging
import re
from typing import Any

import numpy as np

from .base import (
    KIND_ANDROID,
    KIND_EMULATOR,
    STATUS_DISCOVERED,
    STATUS_FAILED,
    Controller,
    DeviceInfo,
    Size,
    register,
)

logger = logging.getLogger("gamepilot.devices.android")

_EMULATOR_HINTS = ("emulator-", "127.0.0.1", "localhost", "mumu", "ldplayer", "nox", "bluestacks", "emulator")

# adb state → (status, error, suggested_fix)
_STATE_MAP = {
    "unauthorized": (
        STATUS_FAILED,
        "未授权：设备上未确认 USB 调试",
        "在手机上点「允许 USB 调试」（勾选「一律允许」），然后重新检测",
    ),
    "offline": (
        STATUS_FAILED,
        "设备离线（adb 连接已断）",
        "重插 USB 或执行 `adb reconnect`，无线调试请确认同一网络",
    ),
    "bootloader": (STATUS_FAILED, "设备处于 bootloader 模式", "退出 fastboot 进入系统后再连接"),
}


def classify_kind(serial: str, model: str = "", product: str = "") -> str:
    """模拟器 vs 真机：串口名/型号里出现模拟器特征即判为模拟器。"""
    haystack = f"{serial} {model} {product}".lower()
    if any(hint in haystack for hint in _EMULATOR_HINTS):
        return KIND_EMULATOR
    return KIND_ANDROID


def make_device_id(serial: str) -> str:
    """稳定 id：同一台设备在多次扫描之间保持不变（UI 靠它做选中/记忆）。"""
    return f"android:{serial}"


def make_uri(serial: str) -> str:
    return f"Android:///?serial={serial}"


def friendly_name(serial: str, model: str = "", product: str = "") -> str:
    """优先展示人能认出的型号名，拿不到才退回 serial。"""
    pretty = (model or product).replace("_", " ").strip()
    return pretty or serial


def parse_wm_size(output: str) -> Size | None:
    """解析 `adb shell wm size` 的输出。

    常见形式：`Physical size: 1080x1920`；部分 ROM 还有 `Override size: 720x1280`，
    后者才是当前实际分辨率，优先级更高。
    """
    override = re.search(r"Override size:\s*(\d+)\s*x\s*(\d+)", output)
    physical = re.search(r"Physical size:\s*(\d+)\s*x\s*(\d+)", output)
    match = override or physical
    if not match:
        return None
    return (int(match.group(1)), int(match.group(2)))


def discover(include_resolution: bool = True) -> list[DeviceInfo]:
    """扫描当前通过 adb 连接的设备。**不抛异常**：adb 不可用时返回空列表。"""
    try:
        import adbutils
    except ImportError:  # pragma: no cover - 依赖缺失时不该让整个扫描失败
        logger.warning("未安装 adbutils，跳过 Android 扫描")
        return []

    devices: list[DeviceInfo] = []
    try:
        client = adbutils.AdbClient()
        entries = client.list(extended=True)
    except Exception as exc:  # adb server 没起来 / 未安装
        logger.warning("adb 列表获取失败: %s", exc)
        return []

    for entry in entries:
        serial = entry.serial
        state = entry.state or "unknown"
        tags = getattr(entry, "tags", {}) or {}
        model = str(tags.get("model", "") or "")
        product = str(tags.get("product", "") or "")
        info = DeviceInfo(
            id=make_device_id(serial),
            uri=make_uri(serial),
            name=friendly_name(serial, model, product),
            kind=classify_kind(serial, model, product),
            status=STATUS_DISCOVERED,
            serial=serial,
            model=model or None,
            product=product or None,
        )

        if state != "device":
            status, error, fix = _STATE_MAP.get(
                state, (STATUS_FAILED, f"adb 状态异常: {state}", "重新插拔设备或重启 adb server")
            )
            info.status = status
            info.error = error
            info.suggested_fix = fix
            devices.append(info)
            continue

        if include_resolution:
            info.resolution = _query_resolution(serial)
        devices.append(info)

    return devices


def _query_resolution(serial: str) -> Size | None:
    try:
        import adbutils

        device = adbutils.adb.device(serial=serial)
        return parse_wm_size(device.shell("wm size"))
    except Exception as exc:
        logger.debug("查询 %s 分辨率失败: %s", serial, exc)
        return None


@register
class AndroidController(Controller):
    """URI: ``Android:///?serial=xxx``。

    第 1 块只实现连接与分辨率查询；截图与输入在第 2/3 块接
    （届时可换成 scrcpy 通道：参考 panda-agent `devices/android/control/`）。
    """

    scheme = "Android"
    description = "安卓真机/模拟器（adbutils）"

    def __init__(self, device_id: str = "", serial: str = "", **options: object) -> None:
        super().__init__(device_id or make_device_id(serial), **options)
        self.serial = serial
        self._client_device: Any = None
        self._resolution: Size | None = None

    def connect(self) -> None:
        import adbutils

        self._client_device = adbutils.adb.device(serial=self.serial) if self.serial else adbutils.adb.device()
        state = self._client_device.get_state()
        if state != "device":
            raise RuntimeError(f"设备 {self.serial} 状态异常: {state}")
        self._resolution = None
        self._connected = True

    @property
    def resolution(self) -> Size:
        if self._resolution is not None:
            return self._resolution
        if not self._connected or self._client_device is None:
            raise RuntimeError("设备未连接")
        size = parse_wm_size(str(self._client_device.shell("wm size")))
        if size is None:
            raise RuntimeError(f"无法解析设备分辨率（serial={self.serial}）")
        self._resolution = size
        return size

    def screenshot(self) -> np.ndarray:
        raise NotImplementedError("Android 截图在第 2 块实现（screencap / scrcpy）")

    def shell(self, command: str) -> str:
        if self._client_device is None:
            raise RuntimeError("设备未连接")
        output = self._client_device.shell(command)
        return output if isinstance(output, str) else str(output)
