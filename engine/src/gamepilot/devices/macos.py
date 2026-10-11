"""macOS 本机窗口自动化。

把"一个应用窗口"当成一台设备：枚举窗口 → 选一个（或直接给句柄）→ 只抓这个窗口的画面 →
点/拖/打字都换算到它的坐标系里。

- 枚举：`CGWindowListCopyWindowInfo`（`kCGWindowNumber` 就是窗口句柄）
- 抓图：`CGWindowListCreateImage(..., kCGWindowListOptionIncludingWindow, handle, ...)`
  —— 只抓目标窗口，不受其它窗口遮挡影响
- 控制：`CGEvent` 鼠标/键盘。坐标用**窗口原点的全局点坐标**（屏幕坐标，非像素），
  所以 Retina 缩放不影响映射。
  点按优先走**辅助功能 API**（`AXPress`）：完全后台执行，不动鼠标、不抢焦点 ——
  适合"录好工作流后台回放"；目标没有可操作元素时（游戏、自绘界面）自动退回鼠标事件。

  两种鼠标投递方式（`Mac:///?window=…&post=pid|global`）：

  | 模式 | 鼠标/焦点 | 可靠性 |
  |---|---|---|
  | `pid`（默认） | **完全不动**（CGEventPostToPid 直投目标进程） | 部分 App 会忽略直投事件（实测 Finder / 活动监视器） |
  | `global` | 会激活目标 App、指针被挪到点击处（点完自动放回原处） | 和真人操作一样可靠 |

  所以：想一边用它一边干活 → 保持 `pid`；发现点了没反应 → 换 `global`。

权限（macOS 必需，缺了会抓不到画面）：

    系统设置 → 隐私与安全性 → **屏幕录制**：给运行 GamePilot 的程序（终端 / 应用本体）打勾
    系统设置 → 隐私与安全性 → **辅助功能**：控制别人的窗口需要它

`CGPreflightScreenCaptureAccess()` 可以预先判断有没有屏幕录制权限。

Windows 侧同一套接口，换成 `EnumWindows` / `PrintWindow`+`BitBlt` / `SendInput` 即可，
上层（设备列表、坐标映射、工作流）不用改。
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any

import numpy as np

from .base import (
    KIND_WINDOWS,
    STATUS_DISCOVERED,
    Controller,
    DeviceInfo,
    Size,
    register,
)

logger = logging.getLogger("gamepilot.devices.macos")

KIND_MACOS = "macos"

# 太小的窗口（菜单、提示条）不作为设备
MIN_WINDOW_SIZE = (160, 120)


# 归一化坐标 → 窗口内点坐标
def window_point(
    bounds: tuple[float, float, float, float],
    x: float,
    y: float,
) -> tuple[float, float]:
    """窗口内归一化坐标 → 全局屏幕点坐标（CGEvent 用的就是屏幕点）。"""
    left, top, width, height = bounds
    return (left + max(0.0, min(1.0, x)) * width, top + max(0.0, min(1.0, y)) * height)


def _ax() -> Any:
    try:
        import ApplicationServices

        return ApplicationServices
    except Exception as exc:
        logger.debug("辅助功能 API 不可用: %s", exc)
        return None


def _quartz() -> Any:
    try:
        import Quartz

        return Quartz
    except Exception as exc:  # 非 macOS 或缺 pyobjc
        logger.debug("Quartz 不可用: %s", exc)
        return None


def available() -> bool:
    """本平台能不能做窗口自动化（macOS + pyobjc）。"""
    return _quartz() is not None


def screen_capture_allowed() -> bool:
    quartz = _quartz()
    if quartz is None:
        return False
    try:
        return bool(quartz.CGPreflightScreenCaptureAccess())
    except Exception:
        return False


@dataclass
class MacWindow:
    handle: int
    pid: int
    app: str
    title: str
    left: float
    top: float
    width: float
    height: float
    layer: int = 0

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        return (self.left, self.top, self.width, self.height)

    @property
    def label(self) -> str:
        return f"{self.app} — {self.title}" if self.title else self.app

    def to_dict(self) -> dict[str, Any]:
        return {
            "handle": self.handle,
            "pid": self.pid,
            "app": self.app,
            "title": self.title,
            "label": self.label,
            "x": round(self.left),
            "y": round(self.top),
            "width": round(self.width),
            "height": round(self.height),
            "uri": f"Mac:///?window={self.handle}",
        }


def filter_windows(raw: list[dict[str, Any]]) -> list[MacWindow]:
    """从 CGWindowListCopyWindowInfo 的原始字典里挑出"可以当设备用"的窗口。

    规则：普通层（layer 0）、够大、有归属 App；按 App+标题去重（同一窗口的多个层只留一个）。
    抽成纯函数是为了能单测 —— 窗口列表依赖真实桌面，没法在测试里造。
    """
    out: list[MacWindow] = []
    seen: set[tuple[str, str]] = set()
    for item in raw:
        layer = int(item.get("kCGWindowLayer", 0))
        if layer != 0:
            continue
        bounds = item.get("kCGWindowBounds", {}) or {}
        width = float(bounds.get("Width", 0))
        height = float(bounds.get("Height", 0))
        if width < MIN_WINDOW_SIZE[0] or height < MIN_WINDOW_SIZE[1]:
            continue
        app = str(item.get("kCGWindowOwnerName", "") or "")
        title = str(item.get("kCGWindowName", "") or "")
        handle = int(item.get("kCGWindowNumber", 0))
        if not app or not handle:
            continue
        key = (app, title)
        if key in seen:
            continue
        seen.add(key)
        out.append(
            MacWindow(
                handle=handle,
                pid=int(item.get("kCGWindowOwnerPID", 0)),
                app=app,
                title=title,
                left=float(bounds.get("X", 0)),
                top=float(bounds.get("Y", 0)),
                width=width,
                height=height,
                layer=layer,
            )
        )
    return out


def list_windows(include_own: bool = True) -> list[MacWindow]:
    """当前屏幕上可以抓的窗口（需要屏幕录制权限才能拿到标题）。"""
    quartz = _quartz()
    if quartz is None:
        return []
    options = quartz.kCGWindowListOptionOnScreenOnly | quartz.kCGWindowListExcludeDesktopElements
    raw = quartz.CGWindowListCopyWindowInfo(options, quartz.kCGNullWindowID) or []
    windows = filter_windows(list(raw))
    if not include_own:
        windows = [item for item in windows if item.app.lower() != "gamepilot"]
    return windows


def discover() -> list[DeviceInfo]:
    """设备列表里给一个"本机窗口"入口；具体窗口由界面上的选择器给（见 mac.windows）。"""
    if not available():
        return []
    count = len(list_windows(include_own=False))
    note = f"{count} 个可选窗口" if screen_capture_allowed() else "缺屏幕录制权限，抓到的是空白"
    return [
        DeviceInfo(
            id=f"{KIND_MACOS}:picker",
            uri="Mac:///?window=0",
            name=f"本机窗口（macOS）· {note}",
            kind=KIND_WINDOWS,
            status=STATUS_DISCOVERED,
            serial="macos",
            model="macOS 窗口自动化",
            error=None,
        )
    ]


@register
class MacWindowController(Controller):
    """URI: ``Mac:///?window=<句柄>``，也支持 ``?pid=<pid>`` / ``?app=<App 名>``。"""

    scheme = "Mac"
    kind = "windows"
    description = "macOS 本机窗口（按窗口句柄抓图 + CGEvent 控制）"

    def __init__(
        self,
        device_id: str = "",
        window: str | int = "",
        pid: str | int = "",
        app: str = "",
        activate: bool = False,
        post: str = "pid",
        strategy: str = "auto",
        restore_cursor: bool = True,
        **options: Any,
    ) -> None:
        super().__init__(device_id or f"{KIND_MACOS}:{window or pid or app}", **options)
        self.window_ref = str(window or "")
        self.pid_ref = int(pid) if pid else 0
        self.app_ref = app
        # 控制方式：
        #   post="pid"（默认）→ CGEventPostToPid 直接投给目标进程：
        #       **不移动你的鼠标、不抢焦点**，你可以一边用它一边干活
        #   post="global"     → 走系统事件流（更像真人操作，但会接管鼠标/焦点）
        # strategy="auto"：点按优先走辅助功能（AXPress，完全后台、不动鼠标、不抢焦点），
        # 目标没有可操作元素（游戏/自绘界面）时才退回鼠标事件
        self.strategy = strategy
        self.ax_clicks = 0
        self.post_to_pid = post != "global"
        self.activate = activate if post == "global" else False
        # 全局模式会真的把鼠标拽到点击位置 → 点完放回原处（默认开）
        self.restore_cursor = restore_cursor
        self.channel = "quartz"
        self.link_note = ""
        self._target: MacWindow | None = None
        self._cursor_origin: tuple[float, float] | None = None
        self._last_frame: np.ndarray | None = None
        self._frame_seq = 0

    # ---------- 连接 ----------

    def connect(self) -> None:
        quartz = _quartz()
        if quartz is None:
            raise RuntimeError("这个功能只在 macOS 上可用（需要 pyobjc 的 Quartz）")
        window = self._resolve_window()
        if window is None:
            raise RuntimeError(
                "没找到目标窗口。`Mac:///?window=<句柄>` / `?pid=<pid>` / `?app=<App 名>` 三选一，"
                "句柄可以在界面上的窗口列表里看到"
            )
        if not screen_capture_allowed():
            raise RuntimeError(
                "没有屏幕录制权限，抓窗口会得到空白。"
                "去「系统设置 → 隐私与安全性 → 屏幕录制」勾上运行 GamePilot 的程序（终端或应用本体）后重启它"
            )
        self._target = window
        self.channel = "quartz"
        self.link_note = (
            f"{window.label}（{round(window.width)}x{round(window.height)} @{round(window.left)},{round(window.top)}）"
        )
        # 试抓一帧：确认句柄还有效、权限真的够
        frame = self._capture()
        self._last_frame = frame
        self._connected = True

    def _resolve_window(self) -> MacWindow | None:
        # 先不看自己的窗口；按句柄找不到时再带上自己找一遍
        # （不然"连自己应用的窗口"永远失败 —— 实测踩过）
        windows = list_windows(include_own=False) or list_windows()
        resolved = self._match_window(windows)
        if resolved is None and self.window_ref:
            resolved = self._match_window(list_windows(include_own=True))
        return resolved

    def _match_window(self, windows: list[MacWindow]) -> MacWindow | None:
        if self.window_ref:
            handle = int(self.window_ref)
            for item in windows:
                if item.handle == handle:
                    return item
            # 句柄可能刚被系统重排：拿不到就回退到"还在的同一个 App"
            return None
        if self.pid_ref:
            for item in windows:
                if item.pid == self.pid_ref:
                    return item
            return None
        if self.app_ref:
            for item in windows:
                if self.app_ref.lower() in item.app.lower():
                    return item
        return windows[0] if windows else None

    @property
    def display_name(self) -> str:
        return self._target.label if self._target is not None else ""

    # ---------- 采集 ----------

    @property
    def resolution(self) -> Size:
        if self._last_frame is not None:
            return (int(self._last_frame.shape[1]), int(self._last_frame.shape[0]))
        if self._target is not None:
            return (round(self._target.width), round(self._target.height))
        return (0, 0)

    @property
    def link_fps(self) -> float:
        return 0.0

    def _capture(self) -> np.ndarray:
        quartz = _quartz()
        if quartz is None or self._target is None:
            raise RuntimeError("窗口控制器未就绪")
        image = quartz.CGWindowListCreateImage(
            quartz.CGRectNull,
            quartz.kCGWindowListOptionIncludingWindow,
            self._target.handle,
            quartz.kCGWindowImageBoundsIgnoreFraming,
        )
        if image is None:
            raise RuntimeError("抓窗口失败（窗口可能已关闭，或没有屏幕录制权限）")
        width = int(quartz.CGImageGetWidth(image))
        height = int(quartz.CGImageGetHeight(image))
        stride = int(quartz.CGImageGetBytesPerRow(image))
        provider = quartz.CGImageGetDataProvider(image)
        data = bytes(quartz.CGDataProviderCopyData(provider))
        buffer = np.frombuffer(data, dtype=np.uint8)
        # 每行可能有对齐填充：先按 stride 切，再取前 width*4 字节
        usable = height * stride
        buffer = buffer[:usable].reshape(height, stride)
        pixels = buffer[:, : width * 4].reshape(height, width, 4)
        return np.ascontiguousarray(pixels[:, :, :3])

    def screenshot(self) -> np.ndarray:
        if self._target is None:
            raise RuntimeError("窗口控制器未连接")
        self._refresh_geometry()
        frame = self._capture()
        self._last_frame = frame
        self._frame_seq += 1
        return frame

    def to_dict(self) -> dict[str, Any]:
        data = super().to_dict()
        data.update(
            {
                "channel": self.channel,
                "linkNote": self.link_note,
                "window": self._target.to_dict() if self._target else None,
                "post": "pid" if self.post_to_pid else "global",
                "strategy": self.strategy,
                "axClicks": self.ax_clicks,
                "activate": self.activate,
                "restoreCursor": self.restore_cursor,
            }
        )
        return data

    # ---------- 控制 ----------

    def _post(self, event: Any, restore: bool = False) -> None:
        """投递事件。

        - `post="pid"`（默认）：`CGEventPostToPid` 直投目标进程，**鼠标与焦点都不动**
          （用户反馈过"控制本机窗口会和我抢鼠标"）；代价是部分 App 会忽略直投事件
        - `post="global"`：走系统事件流，和真人操作一样可靠，但会激活目标 App、
          指针被挪到点击处 —— 所以**手势结束**时把指针放回原处（拖动中途不回位，否则会打断拖动）
        """
        quartz = _quartz()
        assert quartz is not None
        if self.post_to_pid and self._target is not None:
            quartz.CGEventPostToPid(self._target.pid, event)
            return
        if self.activate and self._target is not None:
            self._activate_app(quartz)
        quartz.CGEventPost(quartz.kCGHIDEventTap, event)
        if restore and self.restore_cursor:
            self._restore_cursor(quartz)

    def _restore_cursor(self, quartz: Any) -> None:
        if self._cursor_origin is None:
            return
        warp = quartz.CGEventCreateMouseEvent(
            None, quartz.kCGEventMouseMoved, self._cursor_origin, quartz.kCGMouseButtonLeft
        )
        quartz.CGEventPost(quartz.kCGHIDEventTap, warp)
        self._cursor_origin = None

    def _activate_app(self, quartz: Any) -> None:
        """把目标 App 激活：多数 App 只理会发给前台窗口的点击。"""
        if self._target is None:
            return
        try:
            from AppKit import NSApplicationActivateIgnoringOtherApps, NSRunningApplication

            app = NSRunningApplication.runningApplicationWithProcessIdentifier_(self._target.pid)
            if app is not None:
                app.activateWithOptions_(NSApplicationActivateIgnoringOtherApps)
                time.sleep(0.06)
        except Exception as exc:
            logger.debug("激活 App 失败（继续直接投事件）: %s", exc)

    def _mouse(self, kind: str, x: float, y: float, restore: bool = False) -> None:
        quartz = _quartz()
        if quartz is None or self._target is None:
            raise RuntimeError("窗口控制器未连接")
        px, py = window_point(self._target.bounds, x, y)
        button = quartz.kCGMouseButtonLeft
        event = quartz.CGEventCreateMouseEvent(None, kind, (px, py), button)
        self._post(event, restore=restore)

    def _refresh_geometry(self) -> None:
        """窗口可能被用户挪动/改尺寸 —— 手势开始时刷一次，整段手势都用同一套坐标。"""
        if self._target is None:
            return
        for item in list_windows(include_own=True):
            if item.handle == self._target.handle:
                self._target = item
                return

    def touch(self, phase: str, x: float, y: float) -> None:
        quartz = _quartz()
        assert quartz is not None
        if phase == "down":
            self._refresh_geometry()  # 只在这一段手势开始时刷新，拖到一半移动窗口也不会算错
            if not self.post_to_pid and self.restore_cursor:
                quartz_now = _quartz()
                if quartz_now is not None:
                    point = quartz_now.CGEventGetLocation(quartz_now.CGEventCreate(None))
                    self._cursor_origin = (point.x, point.y)
        mapping = {
            "down": quartz.kCGEventLeftMouseDown,
            "move": quartz.kCGEventLeftMouseDragged,
            "up": quartz.kCGEventLeftMouseUp,
        }
        if phase not in mapping:
            raise ValueError(f"phase 必须是 down/move/up，收到: {phase}")
        self._mouse(mapping[phase], x, y, restore=phase == "up")

    def click(self, x: float, y: float) -> None:
        """点一下：优先用辅助功能按元素（后台执行），不行再走鼠标事件。"""
        if self.strategy in ("auto", "ax") and self._ax_press(x, y):
            self.ax_clicks += 1
            return
        self.touch("down", x, y)
        time.sleep(0.03)
        self.touch("up", x, y)

    def _ax_press(self, x: float, y: float) -> bool:
        """在目标窗口的这个位置找可操作元素并按下 —— 不移动鼠标、不抢焦点。

        很多控件自己没有 AXPress（比如列表行），所以沿父链往上找最近的能按的祖先。
        """
        ax = _ax()
        if ax is None or self._target is None or not ax.AXIsProcessTrusted():
            return False
        px, py = window_point(self._target.bounds, x, y)
        try:
            err, element = ax.AXUIElementCopyElementAtPosition(ax.AXUIElementCreateSystemWide(), px, py, None)
            if err != 0 or element is None:
                return False
            for _ in range(5):
                _err, actions = ax.AXUIElementCopyActionNames(element, None)
                if actions and "AXPress" in actions:
                    return bool(ax.AXUIElementPerformAction(element, "AXPress") == 0)
                _err, parent = ax.AXUIElementCopyAttributeValue(element, "AXParent", None)
                if parent is None:
                    return False
                element = parent
        except Exception as exc:
            logger.debug("AX 点击失败（回退鼠标事件）: %s", exc)
        return False

    def swipe(self, x1: float, y1: float, x2: float, y2: float, duration: float = 0.3) -> None:
        steps = max(4, int(duration / 0.02))
        self.touch("down", x1, y1)
        for index in range(1, steps + 1):
            ratio = index / steps
            self.touch("move", x1 + (x2 - x1) * ratio, y1 + (y2 - y1) * ratio)
            time.sleep(max(0.005, duration / steps))
        self.touch("up", x2, y2)

    def press(self, name: str) -> None:
        """按键：名字 → macOS 虚拟键码（和安卓/iOS 的按键名保持同一套）。"""
        code = MAC_KEYS.get(name)
        if code is None:
            raise ValueError(f"macOS 不支持的按键: {name}（支持: {', '.join(sorted(MAC_KEYS))}）")
        quartz = _quartz()
        assert quartz is not None
        for down in (True, False):
            event = quartz.CGEventCreateKeyboardEvent(None, code, down)
            self._post(event, restore=not down)

    def text(self, value: str) -> None:
        quartz = _quartz()
        assert quartz is not None
        for char in value:
            event = quartz.CGEventCreateKeyboardEvent(None, 0, True)
            quartz.CGEventKeyboardSetUnicodeString(event, len(char), char)
            self._post(event)
            up = quartz.CGEventCreateKeyboardEvent(None, 0, False)
            quartz.CGEventKeyboardSetUnicodeString(up, len(char), char)
            self._post(up)
            time.sleep(0.01)

    def close(self) -> None:
        self._target = None
        super().close()


# macOS 虚拟键码（kVK_*）：按键名与安卓/iOS 尽量统一
MAC_KEYS: dict[str, int] = {
    "enter": 36,
    "return": 36,
    "tab": 48,
    "space": 49,
    "delete": 51,
    "escape": 53,
    "esc": 53,
    "left": 123,
    "right": 124,
    "down": 125,
    "up": 126,
    "home": 115,
    "end": 119,
    "pageup": 116,
    "pagedown": 121,
    "f1": 122,
    "f2": 120,
    "f3": 99,
    "f4": 118,
    "f5": 96,
    "f6": 97,
    "f7": 98,
    "f8": 100,
    "f9": 101,
    "f10": 109,
    "f11": 103,
    "f12": 111,
    # 组合键常用修饰（按下再抬起）
    "cmd": 55,
    "command": 55,
    "shift": 56,
    "capslock": 57,
    "option": 58,
    "alt": 58,
    "ctrl": 59,
    "control": 59,
}
