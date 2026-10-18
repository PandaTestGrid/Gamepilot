"""iOS 的 USB 配置：测绘 + 切换。

iOS 设备在 USB 上有**多套配置**（configuration），切换配置会改变暴露出来的接口数：

| 配置 | 通路 | 用途 |
|---|---|---|
| 1 | 2 条（usbmux / PTP） | 默认，`pymobiledevice3`、iTunes 这些能用 |
| 2 | 4 条（多了 AV 采集等） | **QuickTime 采集要这一套** |

macOS 上的坑：如果不先自己把设备切到配置 2，QuickTime（CoreMediaIO 的 iOS Screen Capture）
会自己去切 —— 切的过程中它会独占设备，之后 usbmux / RSD 隧道都连不上。
所以正确顺序是：

    先切配置 2 → 起 QuickTime 采集 → 再连 pymobiledevice3 HID

这里提供：
- `survey()`：只读地列出每台 Apple USB 设备的配置与通路数（**安全，可随时跑**）
- `ensure_configuration(2)`：当前不是 2 就切过去（pyusb / libusb）；
  失败时回退到 `GAMEPILOT_IOS_USB_CONFIG_CMD` 指定的命令

命令行直接跑：`uv run python -m gamepilot.devices.ios_usb`
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("gamepilot.devices.ios_usb")

APPLE_VENDOR_ID = 0x05AC
# QuickTime 相关：通路更多的 USB 配置（诊断用）
QUICKTIME_CONFIGURATION = 2


@dataclass
class UsbConfiguration:
    value: int
    interfaces: list[tuple[int, int, int]] = field(default_factory=list)  # (号, 备用设置, 类)

    @property
    def paths(self) -> int:
        """这条配置暴露出来的通路数（接口数）。"""
        return len({number for number, _, _ in self.interfaces})

    def describe(self) -> str:
        detail = ", ".join(f"#{number}(alt{alt},class{cls:#04x})" for number, alt, cls in self.interfaces)
        return f"配置 {self.value}：{self.paths} 条通路 [{detail}]"


@dataclass
class AppleUsbDevice:
    bus: int
    address: int
    vendor: int
    product: int
    name: str
    current: int
    configurations: list[UsbConfiguration] = field(default_factory=list)

    def describe(self) -> str:
        lines = [
            f"{self.name}（vid={self.vendor:#06x} pid={self.product:#06x} bus={self.bus} addr={self.address}）",
            f"  当前配置：{self.current}",
        ]
        for config in self.configurations:
            mark = " ← 当前" if config.value == self.current else ""
            lines.append(f"  {config.describe()}{mark}")
        return "\n".join(lines)


def _pyusb() -> Any:
    try:
        import usb.core

        return usb.core
    except Exception as exc:  # pyusb / libusb 缺失
        logger.debug("pyusb 不可用: %s", exc)
        return None


def survey() -> list[AppleUsbDevice]:
    """列出所有 Apple USB 设备及其配置（只读）。"""
    core = _pyusb()
    if core is None:
        return []
    try:
        found = core.find(find_all=True, idVendor=APPLE_VENDOR_ID)
    except Exception as exc:
        logger.warning("枚举 USB 设备失败: %s", exc)
        return []
    devices: list[AppleUsbDevice] = []
    for device in found or []:
        devices.append(_inspect(device))
    return devices


def _inspect(device: Any) -> AppleUsbDevice:
    configurations: list[UsbConfiguration] = []
    try:
        for config in device:
            interfaces = [
                (int(item.bInterfaceNumber), int(item.bAlternateSetting), int(item.bInterfaceClass)) for item in config
            ]
            configurations.append(UsbConfiguration(value=int(config.bConfigurationValue), interfaces=interfaces))
    except Exception as exc:
        logger.debug("读取配置失败: %s", exc)
    current = 0
    try:
        current = int(device.get_active_configuration().bConfigurationValue)
    except Exception:
        # 有的设备（或权限不足时）拿不到当前配置，用第一个配置兜底
        current = configurations[0].value if configurations else 0
    name = ""
    try:
        name = str(getattr(device, "product", "") or "")
    except Exception:
        name = ""
    return AppleUsbDevice(
        bus=int(getattr(device, "bus", 0)),
        address=int(getattr(device, "address", 0)),
        vendor=int(getattr(device, "idVendor", 0)),
        product=int(getattr(device, "idProduct", 0)),
        name=name or "Apple USB 设备",
        current=current,
        configurations=configurations,
    )


def ensure_configuration(target: int = QUICKTIME_CONFIGURATION) -> str:
    """把 Apple 设备切到指定 USB 配置；返回一句人话结果（不抛异常）。

    顺序：pyusb 直接切 → 失败则跑 `GAMEPILOT_IOS_USB_CONFIG_CMD` → 都不行就给提示。
    """
    devices = survey()
    if not devices:
        hint = "USB 上没看到 Apple 设备"
        if shutil.which("pymobiledevice3"):
            hint += "（换个数据线/直插端口试试；只能充电的线枚举不出来）"
        return hint

    already = [item for item in devices if item.current == target]
    if already:
        return f"{already[0].name} 已经在配置 {target}（{_paths_of(already[0], target)} 条通路）"

    core = _pyusb()
    if core is not None:
        for item in devices:
            try:
                device = core.find(idVendor=item.vendor, idProduct=item.product, bus=item.bus, address=item.address)
                if device is None:
                    continue
                wanted = next((cfg for cfg in device if int(cfg.bConfigurationValue) == target), None)
                device.set_configuration(wanted if wanted is not None else target)
                after = _inspect(device)
                if after.current == target:
                    return f"{item.name} 已切到配置 {target}（{_paths_of(after, target)} 条通路）"
                return f"{item.name} 切换后当前配置仍是 {after.current}（可能被系统/QuickTime 抢回去了）"
            except Exception as exc:
                logger.warning("切 USB 配置失败（%s）: %s", item.name, exc)

    command = os.environ.get("GAMEPILOT_IOS_USB_CONFIG_CMD", "").strip()
    if command:
        result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=60, check=False)
        if result.returncode == 0:
            return f"已用 GAMEPILOT_IOS_USB_CONFIG_CMD 切换配置 {target}"
        return f"切换命令失败（退出码 {result.returncode}）: {(result.stderr or result.stdout).strip()[:200]}"

    return (
        f"{devices[0].name} 当前是配置 {devices[0].current}，需要切到 {target} 才能做 QuickTime 采集。"
        "自动切换没成功：确认已 uv sync，或设置 GAMEPILOT_IOS_USB_CONFIG_CMD"
    )


def _paths_of(device: AppleUsbDevice, value: int) -> int:
    config = next((item for item in device.configurations if item.value == value), None)
    return config.paths if config is not None else 0


def main() -> int:
    """命令行：打印 USB 配置测绘结果。"""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    devices = survey()
    if not devices:
        print("没有发现 Apple USB 设备。")
        print("排查：① 用能传数据的线（不是只能充电的）② 直插 Mac 的端口，别走 Hub")
        print("      ③ iPhone 解锁并点『信任此电脑』 ④ `pymobiledevice3 usbmux list` 能不能看到设备")
        return 1
    for device in devices:
        print(device.describe())
        print()
    print(f"QuickTime 采集需要配置 {QUICKTIME_CONFIGURATION}（通路更多的那一套）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
