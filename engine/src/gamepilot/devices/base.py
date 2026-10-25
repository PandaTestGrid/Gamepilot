"""设备层基础设施：设备描述 + 控制器抽象 + 注册表。

设计约束（与 DESIGN.md §4.6 对齐）：
1. **输入接口一律用 [0,1] 归一化坐标**，像素换算只在本层内部发生；
2. 每个平台一个 Controller 实现，靠 URI scheme 注册，上层（状态机 / RPC / UI）不认识平台；
3. 发现（discovery）与连接（connect）分离：列表里可以出现"未授权/离线"的设备，
   它们不能连接，但要能被 UI 展示并给出修复建议。

参考实现来源：panda-agent `src/pda/devices/provider.py`（adbutils 发现）、
`devices/base.py`（BaseDriver 抽象）。我们做了两处收敛：坐标归一化、
发现结果直接带 error/suggested_fix（UI 要展示可执行的修复建议）。
"""

from __future__ import annotations

import abc
import math
from dataclasses import dataclass, field

import numpy as np

Size = tuple[int, int]  # (w, h) 像素

KIND_ANDROID = "android"
KIND_EMULATOR = "emulator"
KIND_WINDOWS = "windows"
KIND_REMOTE = "remote"

STATUS_DISCOVERED = "discovered"
STATUS_CONNECTED = "connected"
STATUS_FAILED = "failed"


@dataclass
class DeviceInfo:
    """一台可被 UI 展示的设备（**发现结果**，不代表已连接）。"""

    id: str
    uri: str
    name: str
    kind: str = KIND_ANDROID
    status: str = STATUS_DISCOVERED
    serial: str | None = None
    model: str | None = None
    product: str | None = None
    resolution: Size | None = None
    error: str | None = None
    suggested_fix: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "uri": self.uri,
            "name": self.name,
            "kind": self.kind,
            "status": self.status,
            "serial": self.serial,
            "model": self.model,
            "product": self.product,
            "resolution": list(self.resolution) if self.resolution else None,
            "error": self.error,
            "suggestedFix": self.suggested_fix,
        }


@dataclass
class ScanResult:
    """一次扫描的结果：设备 + 各来源的错误（例如 adb 没装 / 没权限）。"""

    devices: list[DeviceInfo] = field(default_factory=list)
    errors: list[dict[str, str]] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "devices": [device.to_dict() for device in self.devices],
            "errors": self.errors,
        }


# 手动控制支持的功能键（引擎与界面共用这一份定义）
SUPPORTED_KEYS: frozenset[str] = frozenset(
    {"back", "home", "recents", "power", "volume_up", "volume_down", "enter", "delete"}
)

# Windows 窗口游戏里常用的键盘按键（动作 `key` 的 value 允许这些）。
# Android/iOS 控制器运行时遇到不认识的键会明确报「不支持的按键」，不会静默。
GAME_KEYS: frozenset[str] = frozenset(
    {
        *"abcdefghijklmnopqrstuvwxyz",
        *"0123456789",
        "space",
        "enter",
        "escape",
        "tab",
        "backspace",
        "delete",
        "shift",
        "ctrl",
        "alt",
        "home",
        "end",
        "pageup",
        "pagedown",
        "insert",
        "left",
        "up",
        "right",
        "down",
        *(f"f{index}" for index in range(1, 13)),
    }
)
# 工作流 `key` 动作保存/加载时允许的按键全集（具体设备不支持的在运行时报错）
ACTION_KEYS: frozenset[str] = SUPPORTED_KEYS | GAME_KEYS


class Controller(abc.ABC):
    """设备控制器：截图 + 输入 + 生命周期。所有坐标都是归一化坐标。"""

    scheme: str = ""
    description: str = ""

    def __init__(self, device_id: str, **options: object) -> None:
        self.device_id = device_id
        self.options = dict(options)
        self._connected = False

    # ---------- 生命周期 ----------

    @abc.abstractmethod
    def connect(self) -> None: ...

    def close(self) -> None:
        self._connected = False

    def is_alive(self) -> bool:
        return self._connected

    @property
    def display_name(self) -> str:
        """给界面显示的名字（iOS 的"型号 (iOS 版本)"、macOS 的窗口标题）。

        默认空字符串 = 用设备列表里扫描到的名字。
        """
        return ""

    @property
    def preferred_fps(self) -> float:
        """引擎截图/识别循环的目标帧率（0 = 用会话默认 8fps）。

        抓图很快的设备（例如 WGC 抓 Windows 窗口，单帧 3ms）不需要被 8fps 卡住：
        覆盖这个属性，会话层会用它作为循环上限；界面要多少帧仍由 `device.stream` 决定。
        """
        return 0.0

    # ---------- 能力 ----------

    @property
    @abc.abstractmethod
    def resolution(self) -> Size: ...

    @abc.abstractmethod
    def screenshot(self) -> np.ndarray:
        """返回 BGR uint8 ndarray。"""

    @property
    def max_touch_points(self) -> int:
        """显式 owner 隔离多指能力；0 表示不支持，不影响旧单指 touch。"""
        return 0

    def touch_down(self, x: float, y: float, *, pointer_id: int, owner: str) -> None:
        raise NotImplementedError(f"{type(self).__name__} 不支持多指触控")

    def touch_move(self, x: float, y: float, *, pointer_id: int, owner: str) -> None:
        raise NotImplementedError(f"{type(self).__name__} 不支持多指触控")

    def touch_up(self, *, pointer_id: int, owner: str) -> None:
        raise NotImplementedError(f"{type(self).__name__} 不支持多指触控")

    def release_touches(self, *, owner: str | None = None) -> None:
        """释放指定运行实例的触点；None 只用于设备级关闭/全局清理。"""
        return None

    # ---------- 输入（归一化坐标） ----------

    def click(
        self,
        x: float,
        y: float,
        duration: float = 0.05,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        raise NotImplementedError(f"{type(self).__name__} 不支持 click")

    def swipe(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        duration: float = 0.3,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        raise NotImplementedError(f"{type(self).__name__} 不支持 swipe")

    def key(self, name: str) -> None:
        raise NotImplementedError(f"{type(self).__name__} 不支持 key")

    def press(self, name: str) -> None:
        """按功能键。合法的键名见 `SUPPORTED_KEYS`，各实现自己映射到 keycode。"""
        self.key(name)

    def text(self, value: str) -> None:
        raise NotImplementedError(f"{type(self).__name__} 不支持 text")

    def shell(self, command: str) -> str:
        raise NotImplementedError(f"{type(self).__name__} 不支持 shell")

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.device_id,
            "scheme": type(self).__name__,
            "connected": self._connected,
            "resolution": list(self.resolution) if self._connected else None,
            "capabilities": {"multiTouch": self.max_touch_points > 1, "maxTouchPoints": self.max_touch_points},
        }


def validate_touch_identity(pointer_id: int, owner: str) -> None:
    if isinstance(pointer_id, bool) or not isinstance(pointer_id, int) or not 1 <= pointer_id <= 10:
        raise ValueError("pointer_id 必须是 1..10 的整数")
    validate_touch_owner(owner)


def validate_touch_owner(owner: str) -> None:
    if not isinstance(owner, str) or not owner.strip():
        raise ValueError("owner 必须是非空的运行实例字符串")


def normalize_touch_point(x: float, y: float) -> tuple[float, float]:
    if (
        isinstance(x, bool)
        or isinstance(y, bool)
        or not isinstance(x, (int, float))
        or not isinstance(y, (int, float))
        or not math.isfinite(x)
        or not math.isfinite(y)
    ):
        raise ValueError("触控坐标必须是有限数字")
    return min(1.0, max(0.0, x)), min(1.0, max(0.0, y))


_REGISTRY: dict[str, type[Controller]] = {}


def register(cls: type[Controller]) -> type[Controller]:
    if not cls.scheme:
        raise ValueError(f"{cls.__name__} 必须声明 scheme")
    _REGISTRY[cls.scheme.lower()] = cls
    return cls


def register_scheme(scheme: str, cls: type[Controller]) -> None:
    """给不方便用装饰器的实现注册（例如可选的平台依赖）。"""
    _REGISTRY[scheme.lower()] = cls


def controller_for_scheme(scheme: str) -> type[Controller] | None:
    return _REGISTRY.get(scheme.lower())


def available_schemes() -> dict[str, str]:
    return {name: cls.description for name, cls in sorted(_REGISTRY.items())}
