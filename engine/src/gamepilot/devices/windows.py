"""Windows 本机窗口自动化：把"一个 PC 窗口"当成一台设备。

链路（与 `macos.py` 同构，上层不用认识平台）：

- 枚举：`EnumWindows` + 进程名/标题/类名（`window.list` 的窗口选择器用）
- 抓图：`PrintWindow(PW_RENDERFULLCONTENT | PW_CLIENTONLY)` 优先 —— 只抓这个窗口的
  **客户区**，被别的窗口挡住也能抓；返回全黑时按序回退 `PrintWindow` 整窗裁剪、
  `BitBlt` 屏幕 DC、`BitBlt` 窗口 DC（要求窗口可见、未被遮挡）
- 输入：两种通道（URI 参数 `post=`）
  - `post=global`（默认）：`SendInput` 系统级输入。点按前把目标窗口激活，坐标用
    `ClientToScreen` 换算成屏幕像素；手势结束把鼠标放回原处（`restoreCursor`）。
    这是**最可靠**的方式，但会抢鼠标/焦点。
  - `post=message`：`PostMessage` 直投窗口消息，**不抢鼠标、不抢焦点**，适合后台挂机；
    部分游戏用 DirectInput / 原始输入，会忽略窗口消息。
- 坐标：对外一律归一化 `[0,1]`（相对**客户区**），像素换算只在本文件里发生。
- URI：`Windows:///?hwnd=<十进制>`；也支持 `?pid=` / `?title=` / `?exe=` / `?class=` 兜底。

已知限制（写进 docs/rpc.md，不静默失败）：

- 独占全屏（exclusive fullscreen）窗口抓不到 —— 游戏改窗口化/无边框；
- 以管理员运行的游戏要求 GamePilot 也以管理员运行（UIPI 会拦下普通权限的输入）；
- 窗口最小化时屏幕 BitBlt 不可用，`PrintWindow` 也可能全黑，连接/截图会报错并提示还原窗口。

纯逻辑（`parse_handle` / `filter_windows` / `client_point` / `black_frame`）抽成独立函数，
测试不需要真实桌面；Win32 调用全部惰性进行，非 Windows 上 import 本模块是安全的。
"""

from __future__ import annotations

import contextlib
import ctypes
import importlib.util
import logging
import os
import sys
import threading
import time
from ctypes import wintypes
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..core.bezier_trajectory import play_swipe_path, play_tap, resolve_swipe_points
from .base import (
    KIND_WINDOWS,
    STATUS_DISCOVERED,
    Controller,
    DeviceInfo,
    Size,
    register,
)

logger = logging.getLogger("gamepilot.devices.windows")

# 太小的窗口（菜单、提示条、悬浮球）不作为设备
MIN_WINDOW_SIZE = (160, 120)
# 整帧平均亮度低于它就算"黑屏"（用于抓图回退；真实游戏画面不会这么低）
BLACK_FRAME_THRESHOLD = 2.0
PICKER_DEVICE_ID = "windows:picker"

# ---------- Win32 常量 ----------

GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
DWMWA_EXTENDED_FRAME_BOUNDS = 9
DWMWA_CLOAKED = 14

PW_CLIENTONLY = 0x00000001
PW_RENDERFULLCONTENT = 0x00000002
SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_CHAR = 0x0102
MK_LBUTTON = 0x0001

# 子窗口命中测试：后台消息必须投递给真正处理输入的那个子窗口（Chromium/Electron 的
# 渲染窗、Tk 的 Canvas 都是子窗口，投给顶层会被丢掉）
CWP_SKIPINVISIBLE = 0x0001
CWP_SKIPDISABLED = 0x0002
CWP_SKIPTRANSPARENT = 0x0004

# 同步消息：SendMessageTimeout 直接把消息送到窗口过程，不经过对方消息队列。
# 很多游戏（UE / Unity）只处理"送进来"的消息，PostMessage 会被丢掉；
# SMTO_ABORTIFHUNG 防止目标卡死时把引擎拖住。
SMTO_ABORTIFHUNG = 0x0002
SEND_MESSAGE_TIMEOUT_MS = 200

SW_RESTORE = 9
SW_SHOW = 5
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_SHOWWINDOW = 0x0040
VK_MENU = 0x12
SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

# Windows 桌面壳/系统窗口：它们没有"可自动化内容"，列出来只会干扰选择
EXCLUDED_CLASSES = frozenset(
    {
        "progman",
        "workerw",
        "shell_traywnd",
        "shell_secondarytraywnd",
        "windows.ui.core.corewindow",
        "applicationmanager_deshellwindow",
        "foregroundstaging",
        "tasklist_thumbbar",
        "dv2controlhost",
    }
)

# 键盘虚拟键码（与 Android / iOS / macOS 的按键名尽量统一）
WINDOW_KEYS: dict[str, int] = {
    "enter": 0x0D,
    "return": 0x0D,
    "tab": 0x09,
    "space": 0x20,
    "backspace": 0x08,
    "delete": 0x2E,
    "escape": 0x1B,
    "esc": 0x1B,
    "left": 0x25,
    "up": 0x26,
    "right": 0x27,
    "down": 0x28,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pagedown": 0x22,
    "insert": 0x2D,
    "capslock": 0x14,
    "shift": 0x10,
    "ctrl": 0x11,
    "control": 0x11,
    "alt": 0x12,
    "menu": 0x5D,
    "printscreen": 0x2C,
    "pause": 0x13,
    # 字母 / 数字（游戏里最常用：WASD、数字键）。press() 会先把名字转小写
    **{chr(code).lower(): code for code in range(ord("A"), ord("Z") + 1)},
    **{str(number): 0x30 + number for number in range(10)},
    "numpad0": 0x60,
    "numpad1": 0x61,
    "numpad2": 0x62,
    "numpad3": 0x63,
    "numpad4": 0x64,
    "numpad5": 0x65,
    "numpad6": 0x66,
    "numpad7": 0x67,
    "numpad8": 0x68,
    "numpad9": 0x69,
    "add": 0x6B,
    "subtract": 0x6D,
    "multiply": 0x6A,
    "divide": 0x6F,
    "decimal": 0x6E,
    **{f"f{index}": 0x6F + index for index in range(1, 13)},
}
# 上面 f1 从 0x70 开始，f1=0x70 … f12=0x7B；f10 会撞上 divide=0x6F 的边界，显式覆盖更稳
WINDOW_KEYS.update({f"f{index}": 0x6F + index for index in range(1, 13)})


# ---------- 纯逻辑（单测不需要真实桌面） ----------


@dataclass
class WinWindow:
    """一个可以当设备用的顶层窗口（枚举结果，不代表已连接）。"""

    hwnd: int
    pid: int
    process: str
    title: str
    class_name: str
    left: int
    top: int
    width: int
    height: int
    client_left: int
    client_top: int
    client_width: int
    client_height: int
    minimized: bool = False
    protected: bool = False

    @property
    def label(self) -> str:
        if self.process and self.title:
            return f"{self.process} — {self.title}"
        return self.title or self.process or f"窗口 #{self.hwnd}"

    @property
    def client_size(self) -> Size:
        return (max(1, self.client_width), max(1, self.client_height))

    @property
    def uri(self) -> str:
        return window_uri(self.hwnd)

    def to_dict(self) -> dict[str, Any]:
        return {
            "handle": self.hwnd,
            "hwnd": self.hwnd,
            "pid": self.pid,
            "process": self.process,
            "app": self.process,  # 与 macOS 的 app 字段对齐：界面只有一套窗口列表
            "title": self.title,
            "class": self.class_name,
            "className": self.class_name,
            "label": self.label,
            "x": self.left,
            "y": self.top,
            "width": self.width,
            "height": self.height,
            "clientX": self.client_left,
            "clientY": self.client_top,
            "clientWidth": self.client_width,
            "clientHeight": self.client_height,
            "minimized": self.minimized,
            "protected": self.protected,
            "uri": self.uri,
            "deviceId": f"windows:{self.hwnd}",
        }


def parse_handle(value: int | str | None) -> int:
    """窗口句柄 → int。接受十进制、`0x1A2B` 十六进制；空白返回 0。"""
    if value is None or isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return max(0, value)
    text = str(value).strip()
    if not text:
        return 0
    try:
        handle = int(text, 0)
    except ValueError:
        # `0x` 前缀被 urlencode 成小写也认；再兜底按十进制
        try:
            handle = int(text, 16)
        except ValueError as exc:
            raise ValueError(f"窗口句柄不合法: {value!r}（十进制或 0x 十六进制）") from exc
    return max(0, handle)


def client_point(window: WinWindow, x: float, y: float) -> tuple[int, int]:
    """窗口内归一化坐标 → **客户区像素**坐标（钳到客户区范围内）。"""
    width, height = window.client_size
    px = round(max(0.0, min(1.0, x)) * (width - 1))
    py = round(max(0.0, min(1.0, y)) * (height - 1))
    return max(0, min(width - 1, px)), max(0, min(height - 1, py))


def window_uri(hwnd: int) -> str:
    return f"Windows:///?hwnd={int(hwnd)}"


def black_frame(image: np.ndarray, threshold: float = BLACK_FRAME_THRESHOLD) -> bool:
    """整帧是否全黑（PrintWindow 抓 DX/独占窗口失败时的典型表现）。"""
    if image.size == 0:
        return True
    return float(image.mean()) < threshold


def filter_windows(raw: list[dict[str, Any]]) -> list[WinWindow]:
    """从 EnumWindows 的原始记录里挑出"可以当设备用"的窗口（纯函数，可单测）。

    规则：可见、非工具窗口、非 DWM cloaked、有标题、尺寸够大、不是桌面壳；
    按 hwnd 去重（同一窗口不重复列）。
    """
    seen: set[int] = set()
    out: list[WinWindow] = []
    for item in raw:
        if not bool(item.get("visible", False)):
            continue
        if bool(item.get("tool_window", False)) or bool(item.get("cloaked", False)):
            continue
        hwnd = int(item.get("hwnd", 0) or 0)
        if hwnd <= 0 or hwnd in seen:
            continue
        title = str(item.get("title", "") or "").strip()
        class_name = str(item.get("class_name", "") or "").strip()
        if not title:
            continue
        if class_name.lower() in EXCLUDED_CLASSES:
            continue
        width = int(item.get("width", 0) or 0)
        height = int(item.get("height", 0) or 0)
        if width < MIN_WINDOW_SIZE[0] or height < MIN_WINDOW_SIZE[1]:
            continue
        seen.add(hwnd)
        out.append(
            WinWindow(
                hwnd=hwnd,
                pid=int(item.get("pid", 0) or 0),
                process=str(item.get("process", "") or ""),
                title=title,
                class_name=class_name,
                left=int(item.get("left", 0) or 0),
                top=int(item.get("top", 0) or 0),
                width=width,
                height=height,
                client_left=int(item.get("client_left", item.get("left", 0)) or 0),
                client_top=int(item.get("client_top", item.get("top", 0)) or 0),
                client_width=max(1, int(item.get("client_width", width) or width)),
                client_height=max(1, int(item.get("client_height", height) or height)),
                minimized=bool(item.get("minimized", False)),
                protected=bool(item.get("protected", False)),
            )
        )
    return out


# ---------- Win32（ctypes）----------


class _RECT(ctypes.Structure):
    _fields_ = [
        ("left", wintypes.LONG),
        ("top", wintypes.LONG),
        ("right", wintypes.LONG),
        ("bottom", wintypes.LONG),
    ]


class _POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class _BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", _BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


_LONG_PTR = ctypes.c_ssize_t
_ULONG_PTR = ctypes.c_size_t


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", _ULONG_PTR),
    ]


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", _ULONG_PTR),
    ]


class _HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT), ("hi", _HARDWAREINPUT)]


class _INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("union", _INPUTUNION)]


# `WINFUNCTYPE` 只在 Windows 上存在：非 Windows 用 CFUNCTYPE 占位，保证 import 安全
# （非 Windows 上永远不会真的去 EnumWindows）。
_WNDENUMPROC: Any = (
    ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    if hasattr(ctypes, "WINFUNCTYPE")
    else ctypes.CFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
)


class _Api:
    """Win32 函数入口 + 一次性的 DPI 声明（只在 Windows 上构造）。"""

    def __init__(self) -> None:
        self.user32: Any = ctypes.WinDLL("user32", use_last_error=True)
        self.gdi32: Any = ctypes.WinDLL("gdi32", use_last_error=True)
        self.dwmapi: Any = ctypes.WinDLL("dwmapi", use_last_error=True)
        self.kernel32: Any = ctypes.WinDLL("kernel32", use_last_error=True)
        self._configure()
        self._dpi_ready = False

    def _configure(self) -> None:
        user32, gdi32, dwmapi, kernel32 = self.user32, self.gdi32, self.dwmapi, self.kernel32
        user32.EnumWindows.argtypes = [_WNDENUMPROC, wintypes.LPARAM]
        user32.EnumWindows.restype = wintypes.BOOL
        user32.IsWindow.argtypes = [wintypes.HWND]
        user32.IsWindow.restype = wintypes.BOOL
        user32.IsWindowVisible.argtypes = [wintypes.HWND]
        user32.IsWindowVisible.restype = wintypes.BOOL
        user32.IsIconic.argtypes = [wintypes.HWND]
        user32.IsIconic.restype = wintypes.BOOL
        user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        user32.GetWindowTextLengthW.restype = ctypes.c_int
        user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        user32.GetWindowTextW.restype = ctypes.c_int
        user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        user32.GetClassNameW.restype = ctypes.c_int
        user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        user32.GetWindowThreadProcessId.restype = wintypes.DWORD
        user32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
        user32.GetWindowLongPtrW.restype = _LONG_PTR
        user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(_RECT)]
        user32.GetWindowRect.restype = wintypes.BOOL
        user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(_RECT)]
        user32.GetClientRect.restype = wintypes.BOOL
        user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(_POINT)]
        user32.ClientToScreen.restype = wintypes.BOOL
        user32.GetCursorPos.argtypes = [ctypes.POINTER(_POINT)]
        user32.GetCursorPos.restype = wintypes.BOOL
        user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
        user32.SetCursorPos.restype = wintypes.BOOL
        user32.GetForegroundWindow.restype = wintypes.HWND
        user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        user32.SetForegroundWindow.restype = wintypes.BOOL
        user32.BringWindowToTop.argtypes = [wintypes.HWND]
        user32.BringWindowToTop.restype = wintypes.BOOL
        user32.SwitchToThisWindow.argtypes = [wintypes.HWND, wintypes.BOOL]
        user32.SwitchToThisWindow.restype = None
        user32.SetWindowPos.argtypes = [
            wintypes.HWND,
            wintypes.HWND,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.UINT,
        ]
        user32.SetWindowPos.restype = wintypes.BOOL
        user32.SetFocus.argtypes = [wintypes.HWND]
        user32.SetFocus.restype = wintypes.HWND
        user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        user32.ShowWindow.restype = wintypes.BOOL
        user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
        user32.AttachThreadInput.restype = wintypes.BOOL
        user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.PostMessageW.restype = wintypes.BOOL
        user32.SendMessageTimeoutW.argtypes = [
            wintypes.HWND,
            wintypes.UINT,
            wintypes.WPARAM,
            wintypes.LPARAM,
            wintypes.UINT,
            wintypes.UINT,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        user32.SendMessageTimeoutW.restype = ctypes.c_size_t
        user32.RealChildWindowFromPoint.argtypes = [wintypes.HWND, _POINT]
        user32.RealChildWindowFromPoint.restype = wintypes.HWND
        user32.ChildWindowFromPointEx.argtypes = [wintypes.HWND, _POINT, wintypes.UINT]
        user32.ChildWindowFromPointEx.restype = wintypes.HWND
        user32.ScreenToClient.argtypes = [wintypes.HWND, ctypes.POINTER(_POINT)]
        user32.ScreenToClient.restype = wintypes.BOOL
        user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(_INPUT), ctypes.c_int]
        user32.SendInput.restype = wintypes.UINT
        user32.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
        user32.MapVirtualKeyW.restype = wintypes.UINT
        user32.GetSystemMetrics.argtypes = [ctypes.c_int]
        user32.GetSystemMetrics.restype = ctypes.c_int
        user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
        user32.PrintWindow.restype = wintypes.BOOL
        user32.GetDC.argtypes = [wintypes.HWND]
        user32.GetDC.restype = wintypes.HDC
        user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
        user32.ReleaseDC.restype = ctypes.c_int

        gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
        gdi32.CreateCompatibleDC.restype = wintypes.HDC
        gdi32.CreateDIBSection.argtypes = [
            wintypes.HDC,
            ctypes.POINTER(_BITMAPINFO),
            wintypes.UINT,
            ctypes.POINTER(ctypes.c_void_p),
            wintypes.HANDLE,
            wintypes.DWORD,
        ]
        gdi32.CreateDIBSection.restype = wintypes.HBITMAP
        gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
        gdi32.SelectObject.restype = wintypes.HGDIOBJ
        gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
        gdi32.DeleteObject.restype = wintypes.BOOL
        gdi32.DeleteDC.argtypes = [wintypes.HDC]
        gdi32.DeleteDC.restype = wintypes.BOOL
        gdi32.BitBlt.argtypes = [
            wintypes.HDC,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.HDC,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.DWORD,
        ]
        gdi32.BitBlt.restype = wintypes.BOOL

        dwmapi.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
        dwmapi.DwmGetWindowAttribute.restype = ctypes.c_long

        kernel32.GetCurrentThreadId.restype = wintypes.DWORD
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.QueryFullProcessImageNameW.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.LPWSTR,
            ctypes.POINTER(wintypes.DWORD),
        ]
        kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL

    def enable_dpi_awareness(self) -> None:
        """声明进程 DPI 感知：否则缩放 125%/150% 时窗口矩形与像素坐标会被系统虚拟化。"""
        if self._dpi_ready:
            return
        self._dpi_ready = True
        try:
            setter = getattr(self.user32, "SetProcessDpiAwarenessContext", None)
            if setter is not None and setter(ctypes.c_void_p(-4)):
                return
        except Exception as exc:  # pragma: no cover - 老系统没有这个 API
            logger.debug("SetProcessDpiAwarenessContext 不可用: %s", exc)
        try:
            ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)
            return
        except Exception as exc:  # pragma: no cover
            logger.debug("SetProcessDpiAwareness 不可用: %s", exc)
        try:
            self.user32.SetProcessDPIAware()
        except Exception as exc:  # pragma: no cover
            logger.debug("SetProcessDPIAware 不可用: %s", exc)


_API: _Api | None = None


def _api() -> _Api | None:
    """惰性构造 Win32 入口；非 Windows 返回 None（import 时不碰 windll）。"""
    global _API
    if sys.platform != "win32":
        return None
    if _API is None:
        _API = _Api()
    _API.enable_dpi_awareness()
    return _API


def available() -> bool:
    """本平台能不能做 Windows 窗口自动化。"""
    return sys.platform == "win32"


# ---------- 窗口查询 ----------


def _window_text(api: _Api, hwnd: int) -> str:
    length = int(api.user32.GetWindowTextLengthW(hwnd))
    if length <= 0:
        return ""
    buffer = ctypes.create_unicode_buffer(length + 1)
    api.user32.GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.value


def _class_name(api: _Api, hwnd: int) -> str:
    buffer = ctypes.create_unicode_buffer(256)
    api.user32.GetClassNameW(hwnd, buffer, 256)
    return buffer.value


def _window_rect(api: _Api, hwnd: int) -> tuple[int, int, int, int]:
    """窗口外框（优先 DWM 扩展边框，退回 GetWindowRect）。"""
    rect = _RECT()
    result = api.dwmapi.DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        ctypes.byref(rect),
        ctypes.sizeof(_RECT),
    )
    if (result != 0 or rect.right <= rect.left or rect.bottom <= rect.top) and not api.user32.GetWindowRect(
        hwnd, ctypes.byref(rect)
    ):
        return (0, 0, 0, 0)
    return (
        int(rect.left),
        int(rect.top),
        max(0, int(rect.right - rect.left)),
        max(0, int(rect.bottom - rect.top)),
    )


def _client_rect(api: _Api, hwnd: int) -> tuple[int, int, int, int]:
    """客户区的 (屏幕 x, 屏幕 y, 宽, 高)。"""
    rect = _RECT()
    if not api.user32.GetClientRect(hwnd, ctypes.byref(rect)):
        return (0, 0, 0, 0)
    origin = _POINT(0, 0)
    if not api.user32.ClientToScreen(hwnd, ctypes.byref(origin)):
        return (0, 0, 0, 0)
    return (
        int(origin.x),
        int(origin.y),
        max(0, int(rect.right - rect.left)),
        max(0, int(rect.bottom - rect.top)),
    )


def _deepest_child(api: _Api, hwnd: int, screen_x: int, screen_y: int) -> tuple[int, int, int]:
    """找到屏幕点下**真正接收鼠标输入的子窗口**，返回 (hwnd, 该窗口客户区 x, y)。

    后台消息模式的坑：Chromium/Electron 的输入在 `Chrome_RenderWidgetHostHWND` 子窗口，
    Tk 的输入在 Canvas 子窗口 —— 把 `WM_LBUTTONDOWN` 投给顶层窗口会被直接丢掉
    （用户看到的就是"后台模式点了没反应"）。这里沿子窗口树一路下钻到最深的那个。
    """
    current = hwnd
    for _ in range(8):
        point = _POINT(screen_x, screen_y)
        if not api.user32.ScreenToClient(current, ctypes.byref(point)):
            break
        child = int(api.user32.RealChildWindowFromPoint(current, point) or 0)
        if child == 0 or child == current:
            child = int(
                api.user32.ChildWindowFromPointEx(
                    current,
                    point,
                    CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
                )
                or 0
            )
        if child == 0 or child == current:
            return current, int(point.x), int(point.y)
        current = child
    point = _POINT(screen_x, screen_y)
    api.user32.ScreenToClient(current, ctypes.byref(point))
    return current, int(point.x), int(point.y)


def _is_cloaked(api: _Api, hwnd: int) -> bool:
    """DWM cloak：窗口"存在但不可见"（虚拟桌面切走 / UWP 后台）。"""
    value = ctypes.c_int(0)
    result = api.dwmapi.DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        ctypes.byref(value),
        ctypes.sizeof(value),
    )
    return result == 0 and value.value != 0


def _process_name(api: _Api, pid: int) -> tuple[str, bool]:
    """进程可执行文件名 + 是否受保护（拿不到句柄通常意味着对方以管理员/更高权限运行）。"""
    if pid <= 0:
        return ("", False)
    handle = api.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ("", True)
    try:
        buffer = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if not api.kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return ("", True)
        return (os.path.basename(buffer.value), False)
    finally:
        api.kernel32.CloseHandle(handle)


def _window_info(hwnd: int, api: _Api | None = None) -> WinWindow | None:
    """按句柄取一个窗口的完整信息（不过滤：最小化/无标题的句柄也能解析）。"""
    api = api or _api()
    if api is None or hwnd <= 0:
        return None
    if not api.user32.IsWindow(hwnd):
        return None
    pid_value = wintypes.DWORD(0)
    api.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid_value))
    pid = int(pid_value.value)
    process, protected = _process_name(api, pid)
    left, top, width, height = _window_rect(api, hwnd)
    client_left, client_top, client_width, client_height = _client_rect(api, hwnd)
    return WinWindow(
        hwnd=int(hwnd),
        pid=pid,
        process=process,
        title=_window_text(api, hwnd),
        class_name=_class_name(api, hwnd),
        left=left,
        top=top,
        width=width,
        height=height,
        client_left=client_left,
        client_top=client_top,
        client_width=client_width,
        client_height=client_height,
        minimized=bool(api.user32.IsIconic(hwnd)),
        protected=protected,
    )


def _raw_window(api: _Api, hwnd: int) -> dict[str, Any]:
    info = _window_info(hwnd, api)
    if info is None:
        return {}
    closed = bool(info.width <= 0 or info.height <= 0)
    return {
        "hwnd": info.hwnd,
        "pid": info.pid,
        "process": info.process,
        "title": info.title,
        "class_name": info.class_name,
        "left": info.left,
        "top": info.top,
        "width": info.width,
        "height": info.height,
        "client_left": info.client_left,
        "client_top": info.client_top,
        "client_width": info.client_width,
        "client_height": info.client_height,
        "minimized": info.minimized,
        "protected": info.protected,
        "visible": bool(api.user32.IsWindowVisible(hwnd)) and not closed,
        "tool_window": bool(api.user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW),
        "cloaked": _is_cloaked(api, hwnd),
    }


def _exclude_process(process: str) -> bool:
    """GamePilot 自己的窗口不列（它也会出现在 EnumWindows 里）。"""
    name = os.path.basename(process).lower()
    return name.startswith("gamepilot")


def _enumerate_raw(api: _Api, include_own: bool) -> list[dict[str, Any]]:
    own_pid = os.getpid()
    raw: list[dict[str, Any]] = []

    def _callback(hwnd: int, _lparam: int) -> bool:
        try:
            pid_value = wintypes.DWORD(0)
            api.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid_value))
            pid = int(pid_value.value)
            if not include_own and pid == own_pid:
                return True
            item = _raw_window(api, hwnd)
            if not item:
                return True
            if not include_own and _exclude_process(str(item.get("process", ""))):
                return True
            raw.append(item)
        except Exception as exc:  # 单个坏窗口不能拖垮整次枚举
            logger.debug("枚举窗口失败 hwnd=%s: %s", hwnd, exc)
        return True

    callback = _WNDENUMPROC(_callback)
    api.user32.EnumWindows(callback, 0)
    return raw


def list_windows(include_own: bool = False) -> list[WinWindow]:
    """当前可以当设备用的窗口（按 EnumWindows 的 z 序返回，最前面的在前）。"""
    api = _api()
    if api is None:
        return []
    return filter_windows(_enumerate_raw(api, include_own=include_own))


def discover() -> list[DeviceInfo]:
    """设备列表里的「本机窗口（Windows）」入口；具体窗口由界面上的选择器给。"""
    if not available():
        return []
    count = len(list_windows(include_own=False))
    note = f"{count} 个可选窗口" if count else "没有可选窗口"
    return [
        DeviceInfo(
            id=PICKER_DEVICE_ID,
            uri="Windows:///?hwnd=0",
            name=f"本机窗口（Windows）· {note}",
            kind=KIND_WINDOWS,
            status=STATUS_DISCOVERED,
            serial="windows",
            model="Windows 窗口自动化",
        )
    ]


def window_list_payload(include_own: bool = False) -> dict[str, Any]:
    """`window.list` 的 Windows 分支（界面直接拿 `uri`/`deviceId` 连接）。"""
    if not available():
        return {
            "platform": sys.platform,
            "allowed": False,
            "note": "Windows 窗口自动化只在 Windows 上可用",
            "windows": [],
        }
    windows = list_windows(include_own=include_own)
    note = f"{len(windows)} 个可选窗口" if windows else "没有可选窗口（先打开游戏窗口，再点刷新）"
    return {
        "platform": "win32",
        "allowed": True,
        "note": note,
        "windows": [window.to_dict() for window in windows],
    }


# ---------- 抓图 ----------


def _create_dib(
    api: _Api, width: int, height: int
) -> tuple[wintypes.HDC, wintypes.HBITMAP, ctypes.c_void_p, wintypes.HDC]:
    """建一块 32bpp、自上而下的 DIB（返回 memdc / hbitmap / bits / screen_dc）。"""
    screen_dc = api.user32.GetDC(None)
    mem_dc = api.gdi32.CreateCompatibleDC(screen_dc)
    bmi = _BITMAPINFO()
    bmi.bmiHeader.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth = int(width)
    bmi.bmiHeader.biHeight = -int(height)  # 负数 = 自上而下，省一次翻转
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32
    bmi.bmiHeader.biCompression = 0  # BI_RGB
    bits = ctypes.c_void_p()
    hbitmap = api.gdi32.CreateDIBSection(screen_dc, ctypes.byref(bmi), DIB_RGB_COLORS, ctypes.byref(bits), None, 0)
    return mem_dc, hbitmap, bits, screen_dc


def _read_dib(bits: ctypes.c_void_p, width: int, height: int) -> np.ndarray | None:
    if not bits.value or width <= 0 or height <= 0:
        return None
    buffer = ctypes.string_at(bits.value, width * height * 4)
    pixels = np.frombuffer(buffer, dtype=np.uint8)
    if pixels.size < width * height * 4:
        return None
    bgra = pixels[: width * height * 4].reshape(height, width, 4)
    # Windows DIB 是 BGRA（第 4 字节未用）；引擎内部统一 BGR
    return np.ascontiguousarray(bgra[:, :, :3])


def _with_dib(api: _Api, width: int, height: int, draw: Any) -> np.ndarray | None:
    """建 DIB → 交给 draw(memdc) 画 → 读回 ndarray → 清理。"""
    mem_dc = wintypes.HDC()
    hbitmap = wintypes.HBITMAP()
    bits = ctypes.c_void_p()
    screen_dc = wintypes.HDC()
    try:
        mem_dc, hbitmap, bits, screen_dc = _create_dib(api, width, height)
        if not mem_dc or not hbitmap or not bits.value:
            return None
        old = api.gdi32.SelectObject(mem_dc, hbitmap)
        try:
            if not draw(mem_dc):
                return None
            return _read_dib(bits, width, height)
        finally:
            if old:
                api.gdi32.SelectObject(mem_dc, old)
    finally:
        if hbitmap:
            api.gdi32.DeleteObject(hbitmap)
        if mem_dc:
            api.gdi32.DeleteDC(mem_dc)
        if screen_dc:
            api.user32.ReleaseDC(None, screen_dc)


def _capture_printwindow(api: _Api, hwnd: int, width: int, height: int, flags: int) -> np.ndarray | None:
    def draw(mem_dc: wintypes.HDC) -> bool:
        return bool(api.user32.PrintWindow(hwnd, mem_dc, flags))

    return _with_dib(api, width, height, draw)


def _capture_screen_region(api: _Api, left: int, top: int, width: int, height: int) -> np.ndarray | None:
    def draw(mem_dc: wintypes.HDC) -> bool:
        screen_dc = api.user32.GetDC(None)
        try:
            return bool(api.gdi32.BitBlt(mem_dc, 0, 0, width, height, screen_dc, left, top, SRCCOPY))
        finally:
            api.user32.ReleaseDC(None, screen_dc)

    return _with_dib(api, width, height, draw)


def _capture_window_dc(api: _Api, hwnd: int, width: int, height: int) -> np.ndarray | None:
    def draw(mem_dc: wintypes.HDC) -> bool:
        window_dc = api.user32.GetDC(hwnd)
        try:
            return bool(api.gdi32.BitBlt(mem_dc, 0, 0, width, height, window_dc, 0, 0, SRCCOPY))
        finally:
            api.user32.ReleaseDC(hwnd, window_dc)

    return _with_dib(api, width, height, draw)


def _crop_client(window: WinWindow, image: np.ndarray) -> np.ndarray | None:
    """整窗抓图 → 按客户区偏移裁剪（PrintWindow 不支持 CLIENTONLY 时的兜底）。"""
    offset_x = max(0, window.client_left - window.left)
    offset_y = max(0, window.client_top - window.top)
    width = min(window.client_width, image.shape[1] - offset_x)
    height = min(window.client_height, image.shape[0] - offset_y)
    if width <= 0 or height <= 0:
        return None
    return np.ascontiguousarray(image[offset_y : offset_y + height, offset_x : offset_x + width])


# ---------- Windows Graphics Capture（官方 WGC，可选依赖 windows-capture） ----------


def wgc_available() -> bool:
    """本机能不能走 WGC 抓图（需要可选的 `windows-capture` 包）。"""
    if sys.platform != "win32":
        return False
    try:
        return importlib.util.find_spec("windows_capture") is not None
    except Exception:
        return False


class _WgcGrabber:
    """后台 WGC 抓图线程：回调里裁好客户区，永远只保留最新一帧 BGR。

    WGC 是微软官方 API（Win10 1903+）：按窗口抓、支持 D3D/GPU 渲染、被别的窗口
    遮挡也能拿到内容，延迟和 CPU 占用都明显低于 `PrintWindow`。
    """

    def __init__(self, window: WinWindow) -> None:
        self.hwnd = window.hwnd
        self._window = window
        self._lock = threading.Lock()
        self._latest: np.ndarray | None = None
        self._error: str | None = None
        self._control: Any = None
        self._capture: Any = None

    def update_window(self, window: WinWindow) -> None:
        with self._lock:
            self._window = window

    def _crop(self, frame: Any) -> np.ndarray | None:
        with self._lock:
            window = self._window
        buffer = frame.frame_buffer
        height, width = buffer.shape[:2]
        offset_x = max(0, window.client_left - window.left)
        offset_y = max(0, window.client_top - window.top)
        crop_w = min(window.client_width, width - offset_x)
        crop_h = min(window.client_height, height - offset_y)
        if crop_w <= 0 or crop_h <= 0:
            return None
        # WGC 帧是 BGRA（整窗，含标题栏）；裁到客户区后取前 3 通道 → BGR
        return np.ascontiguousarray(buffer[offset_y : offset_y + crop_h, offset_x : offset_x + crop_w, :3])

    def start(self) -> bool:
        try:
            from windows_capture import WindowsCapture
        except Exception as exc:
            logger.debug("windows-capture 不可用: %s", exc)
            return False
        try:
            capture = WindowsCapture(
                cursor_capture=False,
                draw_border=False,
                window_hwnd=self.hwnd,
                minimum_update_interval=40,  # ≈25fps，够状态机用，省 memcpy
            )
        except Exception as exc:
            with self._lock:
                self._error = f"WGC 初始化失败: {exc}"
            return False

        def on_frame_arrived(frame: Any, _control: Any) -> None:
            try:
                image = self._crop(frame)
            except Exception as exc:
                with self._lock:
                    self._error = f"WGC 帧处理失败: {exc}"
                return
            if image is not None:
                with self._lock:
                    self._latest = image
                    self._error = None

        def on_closed() -> None:
            with self._lock:
                self._error = "WGC 会话结束（目标窗口可能已关闭）"

        capture.event(on_frame_arrived)
        capture.event(on_closed)
        try:
            control = capture.start_free_threaded()
        except Exception as exc:
            with self._lock:
                self._error = f"WGC 启动失败: {exc}"
            return False
        with self._lock:
            self._capture = capture
            self._control = control
        return True

    def latest(self, timeout: float = 0.6) -> tuple[np.ndarray | None, str | None]:
        """取最新一帧；还没有帧就最多等 timeout 秒。返回 (帧, 错误)。"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if self._latest is not None:
                    return self._latest, None
                if self._error is not None:
                    return None, self._error
            time.sleep(0.01)
        with self._lock:
            return self._latest, self._error

    def close(self) -> None:
        with self._lock:
            control = self._control
            self._control = None
            self._capture = None
            self._latest = None
        if control is not None:
            with contextlib.suppress(Exception):
                control.stop()
            with contextlib.suppress(Exception):
                control.wait()


# ---------- 控制器 ----------


@register
class WindowsWindowController(Controller):
    """URI：``Windows:///?hwnd=<十进制>``，也支持 ``?pid=`` / ``?title=`` / ``?exe=`` / ``?class=``。"""

    scheme = "Windows"
    kind = "windows"
    description = "Windows 本机窗口（按窗口句柄抓图 + SendInput/PostMessage 控制）"

    def __init__(
        self,
        device_id: str = "",
        hwnd: str | int = "",
        pid: str | int = "",
        title: str = "",
        exe: str = "",
        class_name: str = "",
        post: str = "global",
        capture: str = "auto",
        activate: bool = True,
        restore_cursor: bool = True,
        cursor: bool = False,
        **options: Any,
    ) -> None:
        super().__init__(device_id or f"windows:{hwnd or pid or title}", **options)
        self.hwnd_ref = parse_handle(hwnd)
        try:
            self.pid_ref = int(pid) if pid not in (None, "") else 0
        except (TypeError, ValueError):
            self.pid_ref = 0
        self.title_ref = str(title or "").strip()
        self.exe_ref = str(exe or "").strip()
        # URI 里 `?class=...` 会落到 **options（class 不是合法 Python 形参名）
        self.class_ref = str(class_name or options.pop("class", "") or "").strip()
        options.pop("class", None)
        post_value = str(post).lower()
        self.post = post_value if post_value in ("message", "sync", "hybrid") else "global"
        self.capture = (
            str(capture).lower() if str(capture).lower() in ("auto", "wgc", "printwindow", "screen") else "auto"
        )
        self.activate = bool(activate)
        self.restore_cursor = bool(restore_cursor)
        # 后台消息模式下的"光标跟随"：部分游戏/Slate UI 用系统光标位置（而不是消息里的
        # lParam）算点击落点。打开它会在手势期间临时把指针放到目标点、抬手后放回原处，
        # 但**不激活、不抢焦点** —— 是纯消息模式失败时的中间档。
        self.cursor_follow = bool(cursor)
        self.channel = "win32"
        self.link_note = ""
        self._target: WinWindow | None = None
        self._last_frame: np.ndarray | None = None
        self.capture_method = ""
        self._wgc: _WgcGrabber | None = None
        self._cursor_origin: tuple[int, int] | None = None
        self._gesture_active = False
        #: 兼容模式（hybrid）：动作前抢焦点、动作后还原给原来的前台窗口
        self._previous_foreground = 0

    # ---------- 生命周期 ----------

    def connect(self) -> None:
        api = _api()
        if api is None:
            raise RuntimeError("Windows 窗口自动化只在 Windows 上可用")
        window = self._resolve_window(api)
        if window is None:
            raise RuntimeError(self._resolve_error())
        if window.client_width <= 0 or window.client_height <= 0:
            raise RuntimeError(
                f"窗口「{window.label}」的客户区是 0×0，抓不到画面"
                "（窗口可能刚启动/已最小化；先打开游戏窗口、还原后再挑一次）"
            )
        self._target = window
        self._last_frame = None
        self.capture_method = ""
        frame = self._capture(api)
        self._last_frame = frame
        self._connected = True
        if self.post == "global":
            mode = "前台 SendInput"
        elif self.post == "hybrid":
            mode = "兼容（动作时临时激活，做完还原焦点）"
        elif self.post == "sync":
            mode = "后台同步 SendMessage" + ("+光标" if self.cursor_follow else "")
        else:
            mode = "后台 PostMessage" + ("+光标" if self.cursor_follow else "")
        protected = " · 目标进程权限更高（建议以管理员运行 GamePilot）" if window.protected else ""
        self.link_note = (
            f"{window.process or '未知进程'} · {window.title or '（无标题）'}"
            f"（{frame.shape[1]}×{frame.shape[0]} 客户区）· 输入={mode} · 抓图={self.capture_method}{protected}"
        )
        logger.info("Windows 窗口已绑定: %s", self.link_note)

    def _resolve_window(self, api: _Api) -> WinWindow | None:
        # 显式句柄：不过滤（最小化/无标题也允许绑定，连上后再报画面问题）
        if self.hwnd_ref:
            return _window_info(self.hwnd_ref, api)
        candidates = list_windows(include_own=True)
        if self.pid_ref:
            for item in candidates:
                if item.pid == self.pid_ref:
                    return item
        if self.title_ref:
            needle = self.title_ref.lower()
            for item in candidates:
                if needle in item.title.lower():
                    return item
        if self.exe_ref:
            needle = self.exe_ref.lower()
            for item in candidates:
                if needle in item.process.lower():
                    return item
        if self.class_ref:
            needle = self.class_ref.lower()
            for item in candidates:
                if needle in item.class_name.lower():
                    return item
        return None

    def _resolve_error(self) -> str:
        hints = "、".join(
            part
            for part in (
                f"句柄 {self.hwnd_ref}" if self.hwnd_ref else "",
                f"pid {self.pid_ref}" if self.pid_ref else "",
                f"标题包含「{self.title_ref}」" if self.title_ref else "",
                f"进程「{self.exe_ref}」" if self.exe_ref else "",
                f"类名「{self.class_ref}」" if self.class_ref else "",
            )
            if part
        )
        return (
            f"没找到目标窗口（{hints or '没有给任何窗口标识'}）。"
            "窗口可能已关闭或改了标题 —— 在设备弹层「本机窗口」里刷新后重新绑定一个窗口，"
            "或用 `Windows:///?hwnd=<句柄>` 直接指定"
        )

    @property
    def display_name(self) -> str:
        return self._target.label if self._target is not None else ""

    @property
    def resolution(self) -> Size:
        if self._last_frame is not None:
            return (int(self._last_frame.shape[1]), int(self._last_frame.shape[0]))
        if self._target is not None:
            return self._target.client_size
        return (0, 0)

    @property
    def preferred_fps(self) -> float:
        """WGC 单帧约 3ms，引擎循环别被默认 8fps 卡住；界面仍按 device.stream 取帧。"""
        return 20.0

    @property
    def link_fps(self) -> float:
        return 0.0

    # ---------- 抓图 ----------

    def _refresh_target(self, api: _Api) -> WinWindow:
        if self._target is None:
            raise RuntimeError("窗口控制器未连接")
        info = _window_info(self._target.hwnd, api)
        if info is None:
            raise RuntimeError(f"目标窗口已关闭（#0x{self._target.hwnd:X}）；重新在设备弹层里绑定一个窗口再连接")
        self._target = info
        return info

    def _capture(self, api: _Api) -> np.ndarray:
        window = self._target
        if window is None:
            raise RuntimeError("窗口控制器未连接")
        width, height = window.client_size

        # 1) 官方 WGC 优先：GPU 窗口/被遮挡窗口都能抓，帧率也更高
        if self.capture in ("auto", "wgc"):
            if self._wgc is None and wgc_available():
                grabber = _WgcGrabber(window)
                if grabber.start():
                    self._wgc = grabber
                    logger.info("Windows 窗口抓图通道: WGC（%s）", window.label)
                elif self.capture == "wgc":
                    raise RuntimeError("WGC 启动失败：目标窗口可能已关闭，或缺少 windows-capture 组件")
            if self._wgc is not None:
                self._wgc.update_window(window)
                wgc_frame, error = self._wgc.latest(0.6 if self._last_frame is None else 0.05)
                if wgc_frame is not None and not black_frame(wgc_frame):
                    if self.capture_method != "wgc":
                        self.capture_method = "wgc"
                    return wgc_frame
                if error is not None:
                    logger.warning("WGC 抓图失败，回退 PrintWindow/BitBlt: %s", error)
                    self._wgc.close()
                    self._wgc = None
                if self.capture == "wgc":
                    raise RuntimeError(f"WGC 抓图失败：{error or '0.6s 内没有收到帧'}")

        attempts: list[tuple[str, Any]] = []
        if self.capture in ("auto", "printwindow"):
            attempts.append(
                (
                    "printwindow",
                    lambda: _capture_printwindow(api, window.hwnd, width, height, PW_CLIENTONLY | PW_RENDERFULLCONTENT),
                )
            )
            attempts.append(
                ("printwindow", lambda: _capture_printwindow(api, window.hwnd, width, height, PW_CLIENTONLY))
            )
            attempts.append(("printwindow-full", lambda: self._capture_full(api, window)))
        if self.capture in ("auto", "screen") and not window.minimized:
            attempts.append(
                (
                    "screen",
                    lambda: _capture_screen_region(api, window.client_left, window.client_top, width, height),
                )
            )
            attempts.append(("window-dc", lambda: _capture_window_dc(api, window.hwnd, width, height)))
        if not attempts:
            raise RuntimeError(f"抓图方式不可用: capture={self.capture}（可选 auto / wgc / printwindow / screen）")

        # 上次成功的方式优先（自动模式下不同方式之间来回切会让识别抖动）
        if self.capture_method:
            attempts.sort(key=lambda item: 0 if item[0] == self.capture_method else 1)

        last_error = ""
        for name, attempt in attempts:
            image: np.ndarray | None
            try:
                image = attempt()
            except Exception as exc:
                last_error = f"{name}: {type(exc).__name__}: {exc}"
                continue
            if image is None:
                last_error = f"{name}: 返回空画面"
                continue
            if black_frame(image):
                last_error = f"{name}: 抓到全黑画面"
                continue
            if self.capture_method != name:
                logger.info("Windows 窗口抓图方式: %s（%s）", name, window.label)
                self.capture_method = name
            return image
        raise RuntimeError(self._capture_error(window, last_error))

    def _capture_full(self, api: _Api, window: WinWindow) -> np.ndarray | None:
        image = _capture_printwindow(api, window.hwnd, window.width, window.height, PW_RENDERFULLCONTENT)
        if image is None:
            return None
        return _crop_client(window, image)

    def _capture_error(self, window: WinWindow, last_error: str) -> str:
        hints = []
        if window.minimized:
            hints.append("目标窗口已最小化：先还原窗口（PrintWindow 对最小化窗口经常是黑屏）")
        hints.append("独占全屏（exclusive fullscreen）抓不到：把游戏改成「窗口化 / 无边框窗口」")
        hints.append("目标以管理员运行而 GamePilot 不是：用管理员身份运行 GamePilot（UIPI 会拦下输入）")
        if self.capture == "printwindow":
            hints.append("可以试 capture=screen（要求窗口可见、未被遮挡）")
        if self.capture == "wgc":
            hints.append("WGC 需要 Windows 10 1903+ 和可选依赖 windows-capture；也可以 capture=auto 自动回退")
        return f"抓不到窗口画面（{last_error}）。排查建议：\n- " + "\n- ".join(hints)

    def screenshot(self) -> np.ndarray:
        api = _api()
        if api is None:
            raise RuntimeError("Windows 窗口自动化只在 Windows 上可用")
        if self._target is None:
            raise RuntimeError("窗口控制器未连接")
        self._refresh_target(api)
        frame = self._capture(api)
        self._last_frame = frame
        return frame

    def to_dict(self) -> dict[str, Any]:
        data = super().to_dict()
        data.update(
            {
                "channel": self.channel,
                "linkNote": self.link_note,
                "window": self._target.to_dict() if self._target else None,
                "post": self.post,
                "cursorFollow": self.cursor_follow,
                "capture": self.capture_method or self.capture,
                "activate": self.activate,
                "restoreCursor": self.restore_cursor,
            }
        )
        return data

    # ---------- 输入 ----------

    def _is_foreground(self, api: _Api, hwnd: int) -> bool:
        return int(api.user32.GetForegroundWindow() or 0) == hwnd

    def _ensure_foreground(self, api: _Api) -> None:
        """SendInput 会发给前台窗口：先把目标切到前台，切不过去就报错（不能点错地方）。

        Windows 的 `SetForegroundWindow` 对后台进程有限制（"前台锁"）。这里按可靠性
        依次尝试：`SwitchToThisWindow` → AttachThreadInput + SetForegroundWindow →
        模拟一次 Alt 键（把自己的输入算成"用户最近输入"，解锁前台切换）→
        SetWindowPos 置顶。全失败才报错，错误里给出可执行的替代方案。
        """
        if not self.activate or self._target is None:
            return
        hwnd = self._target.hwnd
        if self._is_foreground(api, hwnd):
            return
        if api.user32.IsIconic(hwnd):
            api.user32.ShowWindow(hwnd, SW_RESTORE)
        title = self._target.title or self._target.process

        # 1) 未文档化但广泛可用：直接切到目标窗口（很多情况下比 SetForegroundWindow 宽松）
        try:
            api.user32.SwitchToThisWindow(hwnd, True)
        except Exception as exc:  # pragma: no cover - 老系统
            logger.debug("SwitchToThisWindow 失败: %s", exc)
        time.sleep(0.03)
        if self._is_foreground(api, hwnd):
            return

        # 2) 附加输入线程 + SetForegroundWindow（经典组合）
        current_tid = int(api.kernel32.GetCurrentThreadId())
        target_tid = int(api.user32.GetWindowThreadProcessId(hwnd, None))
        attached = False
        try:
            if current_tid and target_tid:
                attached = bool(api.user32.AttachThreadInput(current_tid, target_tid, True))
            api.user32.BringWindowToTop(hwnd)
            api.user32.SetForegroundWindow(hwnd)
            api.user32.SetFocus(hwnd)
        finally:
            if attached:
                api.user32.AttachThreadInput(current_tid, target_tid, False)
        time.sleep(0.03)
        if self._is_foreground(api, hwnd):
            return

        # 3) 模拟一次 Alt：系统把我们的进程算成"最近有输入"，随后允许前台切换
        try:
            self._send_key_global(api, VK_MENU, up=False)
            self._send_key_global(api, VK_MENU, up=True)
            api.user32.SetForegroundWindow(hwnd)
            time.sleep(0.05)
        except Exception as exc:  # pragma: no cover - SendInput 被安全软件拦
            logger.debug("Alt 键解锁前台失败: %s", exc)
        if self._is_foreground(api, hwnd):
            return

        # 4) 置顶（不移动/不缩放）后再切前台
        api.user32.ShowWindow(hwnd, SW_SHOW)
        api.user32.SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
        api.user32.SetForegroundWindow(hwnd)
        time.sleep(0.03)
        if self._is_foreground(api, hwnd):
            return

        raise RuntimeError(
            f"没能把窗口「{title}」切到前台，为避免点到别的窗口已中止。"
            "手动点一下目标窗口再试；或改用 `post=message`（后台消息，不抢焦点；"
            "部分游戏不响应）；若目标以管理员运行，请用管理员身份运行 GamePilot"
        )

    def _screen_abs(self, api: _Api, screen_x: int, screen_y: int) -> tuple[int, int]:
        vx = int(api.user32.GetSystemMetrics(SM_XVIRTUALSCREEN))
        vy = int(api.user32.GetSystemMetrics(SM_YVIRTUALSCREEN))
        vw = max(1, int(api.user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)))
        vh = max(1, int(api.user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)))
        nx = round((screen_x - vx) * 65535 / max(1, vw - 1))
        ny = round((screen_y - vy) * 65535 / max(1, vh - 1))
        return max(0, min(65535, nx)), max(0, min(65535, ny))

    def _send_global(self, api: _Api, flags: int, screen: tuple[int, int] | None = None) -> None:
        entry = _INPUT()
        entry.type = INPUT_MOUSE
        entry.union.mi = _MOUSEINPUT(
            dx=0,
            dy=0,
            mouseData=0,
            dwFlags=flags,
            time=0,
            dwExtraInfo=0,
        )
        if screen is not None:
            abs_x, abs_y = self._screen_abs(api, screen[0], screen[1])
            entry.union.mi.dx = abs_x
            entry.union.mi.dy = abs_y
            entry.union.mi.dwFlags = flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
        sent = int(api.user32.SendInput(1, ctypes.byref(entry), ctypes.sizeof(_INPUT)))
        if sent != 1:
            raise RuntimeError(f"SendInput 失败（错误码 {ctypes.get_last_error()}）")

    def _send_key_global(self, api: _Api, vk: int, up: bool) -> None:
        entry = _INPUT()
        entry.type = INPUT_KEYBOARD
        entry.union.ki = _KEYBDINPUT(
            wVk=vk,
            wScan=int(api.user32.MapVirtualKeyW(vk, 0)),
            dwFlags=KEYEVENTF_KEYUP if up else 0,
            time=0,
            dwExtraInfo=0,
        )
        sent = int(api.user32.SendInput(1, ctypes.byref(entry), ctypes.sizeof(_INPUT)))
        if sent != 1:
            raise RuntimeError(f"SendInput 键盘事件失败（错误码 {ctypes.get_last_error()}）")

    def _deliver_message(self, api: _Api, hwnd: int, message: int, wparam: int, lparam: int) -> None:
        """按当前通道投递一条窗口消息：sync = SendMessageTimeout，message = PostMessage。"""
        if self.post == "sync":
            result = ctypes.c_size_t(0)
            delivered = api.user32.SendMessageTimeoutW(
                hwnd,
                message,
                wparam,
                lparam,
                SMTO_ABORTIFHUNG,
                SEND_MESSAGE_TIMEOUT_MS,
                ctypes.byref(result),
            )
            if not delivered:
                raise RuntimeError(
                    f"SendMessageTimeout 失败（hwnd=0x{hwnd:X}，错误码 {ctypes.get_last_error()}）；"
                    f"目标 {SEND_MESSAGE_TIMEOUT_MS}ms 内没有响应（卡死/权限更高）；"
                    "可以换「后台·纯消息」或「前台」模式"
                )
            return
        if not api.user32.PostMessageW(hwnd, message, wparam, lparam):
            raise RuntimeError(
                f"PostMessage 失败（hwnd=0x{hwnd:X}，错误码 {ctypes.get_last_error()}）；"
                "目标可能以更高权限运行，试试用管理员运行 GamePilot"
            )

    def _send_mouse_message(self, api: _Api, message: int, screen_x: int, screen_y: int, wparam: int = 0) -> None:
        """把鼠标消息投给屏幕点下**真正接收输入的子窗口**（坐标换算成该窗口客户区）。"""
        if self._target is None:
            raise RuntimeError("窗口控制器未连接")
        hwnd, x, y = _deepest_child(api, self._target.hwnd, screen_x, screen_y)
        lparam = ((y & 0xFFFF) << 16) | (x & 0xFFFF)
        self._deliver_message(api, hwnd, message, wparam, lparam)

    def _post_key_message(self, api: _Api, vk: int, up: bool) -> None:
        if self._target is None:
            raise RuntimeError("窗口控制器未连接")
        scan = int(api.user32.MapVirtualKeyW(vk, 0))
        lparam = 0xC0000000 | (scan << 16) | 1 if up else (scan << 16) | 1
        message = WM_KEYUP if up else WM_KEYDOWN
        self._deliver_message(api, self._target.hwnd, message, vk, lparam)

    def touch(self, phase: str, x: float, y: float) -> None:
        """实时触控：down/move/up。全局模式在 down 激活窗口、在 up 把指针放回原处。"""
        api = _api()
        if api is None:
            raise RuntimeError("Windows 窗口自动化只在 Windows 上可用")
        window = self._refresh_target(api)
        if phase not in ("down", "move", "up"):
            raise ValueError(f"phase 必须是 down/move/up，收到: {phase}")
        # 防御：没有 down 的 move 一律丢弃。前端失焦丢过 pointerup 时会残留"正在拖"的状态，
        # 之后鼠标只是在画面上悬停就会不断发 move；hybrid/光标跟随模式会因此把系统指针
        # 拽到游戏窗口上（用户看到"鼠标一放到画面就被吸走"，录制也没法框选）。
        if phase == "move" and not self._gesture_active:
            return
        px, py = client_point(window, x, y)
        screen = (window.client_left + px, window.client_top + py)
        if self.post in ("message", "sync"):
            # 有些游戏/Slate UI 用系统光标位置算点击落点（而不是消息 lParam）；
            # cursor=1 时手势期间把指针放到目标点，抬手后放回 —— 不激活、不抢焦点。
            if phase == "down":
                self._gesture_active = True
            if self.cursor_follow:
                if phase == "down":
                    point = _POINT()
                    if api.user32.GetCursorPos(ctypes.byref(point)):
                        self._cursor_origin = (int(point.x), int(point.y))
                    api.user32.SetCursorPos(screen[0], screen[1])
                elif phase == "move":
                    api.user32.SetCursorPos(screen[0], screen[1])
            if phase == "down":
                self._send_mouse_message(api, WM_MOUSEMOVE, screen[0], screen[1])
                self._send_mouse_message(api, WM_LBUTTONDOWN, screen[0], screen[1], MK_LBUTTON)
            elif phase == "move":
                self._send_mouse_message(api, WM_MOUSEMOVE, screen[0], screen[1], MK_LBUTTON)
            else:
                self._send_mouse_message(api, WM_LBUTTONUP, screen[0], screen[1])
                self._gesture_active = False
                if self.cursor_follow:
                    self._restore_cursor(api)
            return

        if self.post == "hybrid":
            # 兼容模式：游戏只认真实输入 → 动作前把目标窗口切到前台，动作后把焦点还原给
            # 用户原来的窗口。会有很短的焦点闪烁，但单次点击/按键能真正生效。
            if phase == "down":
                self._previous_foreground = int(api.user32.GetForegroundWindow() or 0)
                self._ensure_foreground(api)
                self._gesture_active = True
                if self.restore_cursor:
                    point = _POINT()
                    if api.user32.GetCursorPos(ctypes.byref(point)):
                        self._cursor_origin = (int(point.x), int(point.y))
                self._send_global(api, MOUSEEVENTF_MOVE, screen)
                self._send_global(api, MOUSEEVENTF_LEFTDOWN)
            elif phase == "move":
                self._send_global(api, MOUSEEVENTF_MOVE, screen)
            else:
                self._send_global(api, MOUSEEVENTF_LEFTUP)
                time.sleep(0.06)
                self._gesture_active = False
                self._restore_cursor(api)
                self._restore_previous_focus(api)
            return

        if phase == "down":
            self._ensure_foreground(api)
            self._gesture_active = True
            if self.restore_cursor:
                point = _POINT()
                if api.user32.GetCursorPos(ctypes.byref(point)):
                    self._cursor_origin = (int(point.x), int(point.y))
            self._send_global(api, MOUSEEVENTF_MOVE, screen)
            self._send_global(api, MOUSEEVENTF_LEFTDOWN)
        elif phase == "move":
            self._send_global(api, MOUSEEVENTF_MOVE, screen)
        else:
            self._send_global(api, MOUSEEVENTF_LEFTUP)
            self._gesture_active = False
            self._restore_cursor(api)

    def _restore_previous_focus(self, api: _Api) -> None:
        """兼容模式收尾：把前台还给动作前的窗口（失败只记 debug，不打断自动化）。"""
        previous = self._previous_foreground
        self._previous_foreground = 0
        if not previous or self._target is None or previous == self._target.hwnd:
            return
        if not api.user32.IsWindow(previous):
            return
        try:
            api.user32.SetForegroundWindow(previous)
        except Exception as exc:  # pragma: no cover - 系统偶尔拒绝还原焦点
            logger.debug("还原前台窗口失败（继续）: %s", exc)

    def _restore_cursor(self, api: _Api) -> None:
        if self._cursor_origin is None:
            return
        api.user32.SetCursorPos(self._cursor_origin[0], self._cursor_origin[1])
        self._cursor_origin = None

    def click(
        self,
        x: float,
        y: float,
        duration: float = 0.05,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        play_tap(self.touch, (x, y), duration, path)

    def swipe(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        duration: float = 0.3,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        play_swipe_path(self.touch, resolve_swipe_points((x1, y1), (x2, y2), duration, path), duration)

    def press(self, name: str) -> None:
        """按键：名字 → Windows 虚拟键码（和安卓/iOS/macOS 的按键名保持同一套）。"""
        key = name.strip().lower()
        vk = WINDOW_KEYS.get(key)
        if vk is None:
            raise ValueError(f"Windows 不支持的按键: {name}（支持: {', '.join(sorted(WINDOW_KEYS))}）")
        api = _api()
        if api is None:
            raise RuntimeError("Windows 窗口自动化只在 Windows 上可用")
        if self.post in ("message", "sync"):
            self._post_key_message(api, vk, up=False)
            time.sleep(0.02)
            self._post_key_message(api, vk, up=True)
            return
        if self.post == "hybrid":
            self._previous_foreground = int(api.user32.GetForegroundWindow() or 0)
            try:
                self._ensure_foreground(api)
                self._send_key_global(api, vk, up=False)
                time.sleep(0.02)
                self._send_key_global(api, vk, up=True)
                time.sleep(0.06)
            finally:
                self._restore_previous_focus(api)
            return
        self._ensure_foreground(api)
        self._send_key_global(api, vk, up=False)
        time.sleep(0.02)
        self._send_key_global(api, vk, up=True)

    def text(self, value: str) -> None:
        api = _api()
        if api is None:
            raise RuntimeError("Windows 窗口自动化只在 Windows 上可用")
        units = _utf16_units(value)
        if self.post in ("message", "sync"):
            if self._target is None:
                raise RuntimeError("窗口控制器未连接")
            for unit in units:
                self._deliver_message(api, self._target.hwnd, WM_CHAR, unit, 1)
                time.sleep(0.005)
            return
        if self.post == "hybrid":
            self._previous_foreground = int(api.user32.GetForegroundWindow() or 0)
            try:
                self._ensure_foreground(api)
                for unit in units:
                    entry = _INPUT()
                    entry.type = INPUT_KEYBOARD
                    entry.union.ki = _KEYBDINPUT(
                        wVk=0,
                        wScan=unit,
                        dwFlags=KEYEVENTF_UNICODE,
                        time=0,
                        dwExtraInfo=0,
                    )
                    api.user32.SendInput(1, ctypes.byref(entry), ctypes.sizeof(_INPUT))
                    entry.union.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                    api.user32.SendInput(1, ctypes.byref(entry), ctypes.sizeof(_INPUT))
                    time.sleep(0.005)
                time.sleep(0.06)
            finally:
                self._restore_previous_focus(api)
            return
        self._ensure_foreground(api)
        for unit in units:
            entry = _INPUT()
            entry.type = INPUT_KEYBOARD
            entry.union.ki = _KEYBDINPUT(
                wVk=0,
                wScan=unit,
                dwFlags=KEYEVENTF_UNICODE,
                time=0,
                dwExtraInfo=0,
            )
            api.user32.SendInput(1, ctypes.byref(entry), ctypes.sizeof(_INPUT))
            entry.union.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
            api.user32.SendInput(1, ctypes.byref(entry), ctypes.sizeof(_INPUT))
            time.sleep(0.005)

    def close(self) -> None:
        if self._wgc is not None:
            self._wgc.close()
            self._wgc = None
        self._target = None
        self._last_frame = None
        super().close()


def _utf16_units(value: str) -> list[int]:
    """字符串 → UTF-16 码元（代理对拆成两个，SendInput/WM_CHAR 都按码元发）。"""
    data = value.encode("utf-16-le")
    return [int.from_bytes(data[index : index + 2], "little") for index in range(0, len(data), 2)]


__all__ = [
    "BLACK_FRAME_THRESHOLD",
    "MIN_WINDOW_SIZE",
    "PICKER_DEVICE_ID",
    "WINDOW_KEYS",
    "WinWindow",
    "WindowsWindowController",
    "available",
    "black_frame",
    "client_point",
    "discover",
    "filter_windows",
    "list_windows",
    "parse_handle",
    "wgc_available",
    "window_list_payload",
    "window_uri",
]
