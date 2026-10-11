"""iOS 设备支持（**仅 iOS ≥ 17.4**）。

采集走 QuickTime 管线（macOS 的 CoreMediaIO "iOS Screen Capture"，也就是 QuickTime Player
用的那一 路）：ffmpeg `-f avfoundation` → MJPEG → PyAV 解码。

控制走 pymobiledevice3 的 CoreDevice（RSD 用户态隧道，不用 sudo）：
- 触摸：`UniversalHIDServiceService.send_touchscreen(CONTACT/RELEASE, x, y)`，坐标 0..65535
- 按键：`IndigoHIDService.send_button(usage_page, usage_code, DOWN/UP)`
- 文本：`create_keyboard_service()` + `send_keyboard()`

⚠️ 两个前提（踩过才知道的）：

1. **USB 配置要先切 config2**：macOS 上 QuickTime 会独占 USB 设备，之后 usbmux / RSD 隧道
   都连不上。所以采集之前必须先切配置 —— 各家机器上的做法不同，用环境变量
   `GAMEPILOT_IOS_USB_CONFIG_CMD` 指定你的命令；没设置时只记一条提示，不阻塞。
2. **触摸注入要有视频流在跑**：pymobiledevice3 的 HID 文档写明"media stream 必须已在运行，
   否则 backboardd 会把 report 丢掉"。所以顺序必须是：先起 QuickTime 采集，再注入触摸。
   （`connect()` 里就是按这个顺序做的。）

另外：pymobiledevice3 的 `UserspaceRsdTunnel` 是**进程级单例**，一个进程同时只能有一台
iOS 设备走隧道；多台 iOS 需要拆进程。
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Any

import numpy as np

from .base import (
    KIND_ANDROID,
    STATUS_DISCOVERED,
    STATUS_FAILED,
    SUPPORTED_KEYS,
    Controller,
    DeviceInfo,
    Size,
    register,
)

logger = logging.getLogger("gamepilot.devices.ios")

KIND_IOS = "ios"

# 只有 17.4+ 才有可用的用户态 RSD 隧道（不用 sudo 就能控制）
IOS_MIN_VERSION = (17, 4)

# QuickTime/avfoundation 采集设备名里的关键字（macOS 上 iPhone 会以设备名出现）
_QUICKTIME_NAME_HINTS = ("iphone", "ipad", "ios", "屏幕")

# Indigo 按键：名字 → (usage_page, usage_code)
NAMED_BUTTONS: dict[str, tuple[int, int]] = {
    "home": (0x0C, 0x40),
    "lock": (0x0C, 0x30),
    "power": (0x0C, 0x30),
    "volume_up": (0x0C, 0xE9),
    "volume_down": (0x0C, 0xEA),
    "mute": (0x0C, 0xE2),
    "siri": (0x0C, 0xCF),
    # iOS 没有安卓那几个键，这里做个映射，脚本两边都能用
    "back": (0x0C, 0x40),  # 用 Home 代替"返回"
    "recents": (0x0C, 0x40),
    "enter": (0x0C, 0x28),
    "delete": (0x0C, 0x2A),
}

DIGITIZER_MAX = 65535


def _version_tuple(text: str) -> tuple[int, ...]:
    parts = re.findall(r"\d+", text or "")
    return tuple(int(item) for item in parts[:3]) or (0,)


def version_supported(version: str) -> bool:
    """是否达到最低版本要求（iOS ≥ 17.4）。"""
    return _version_tuple(version) >= IOS_MIN_VERSION


def pymobiledevice3_available() -> bool:
    return shutil.which("pymobiledevice3") is not None


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


# ---------------------------------------------------------------------- #
# 设备发现
# ---------------------------------------------------------------------- #


@dataclass
class IosDevice:
    udid: str
    name: str
    version: str
    connection: str = "USB"

    @property
    def uri(self) -> str:
        return f"iOS:///?udid={self.udid}"

    def supported(self) -> bool:
        return version_supported(self.version)


def list_devices() -> list[IosDevice]:
    """`pymobiledevice3 usbmux list` → 设备列表（解析 JSON）。"""
    binary = shutil.which("pymobiledevice3")
    if binary is None:
        return []
    try:
        result = subprocess.run(
            [binary, "usbmux", "list"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("pymobiledevice3 usbmux list 失败: %s", exc)
        return []
    text = result.stdout.strip()
    if not text:
        return []
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("usbmux list 输出不是 JSON: %s", text[:200])
        return []
    devices: list[IosDevice] = []
    for item in payload if isinstance(payload, list) else []:
        if not isinstance(item, dict):
            continue
        udid = str(item.get("Identifier") or item.get("UniqueDeviceID") or "")
        if not udid:
            continue
        devices.append(
            IosDevice(
                udid=udid,
                name=str(item.get("DeviceName") or item.get("ProductType") or "iOS 设备"),
                version=str(item.get("ProductVersion") or ""),
                connection=str(item.get("ConnectionType") or "USB"),
            )
        )
    return devices


def discover() -> list[DeviceInfo]:
    """给 device.list 用的发现函数（只返回达标的设备）。"""
    out: list[DeviceInfo] = []
    for device in list_devices():
        out.append(
            DeviceInfo(
                id=f"{KIND_IOS}:{device.udid}",
                uri=device.uri,
                name=f"{device.name} (iOS {device.version or '?'})",
                kind=KIND_IOS if device.supported() else KIND_ANDROID,
                status=STATUS_DISCOVERED if device.supported() else STATUS_FAILED,
                serial=device.udid,
                model=device.name,
                resolution=None,
                error=None if device.supported() else f"仅支持 iOS {IOS_MIN_VERSION[0]}.{IOS_MIN_VERSION[1]}+",
            )
        )
    return out


# ---------------------------------------------------------------------- #
# QuickTime 采集
# ---------------------------------------------------------------------- #


def find_capture_device(ffmpeg: str, name_hint: str = "") -> tuple[int, str] | None:
    """在 `ffmpeg -f avfoundation -list_devices` 里找 iOS 采集设备。"""
    try:
        result = subprocess.run(
            [ffmpeg, "-f", "avfoundation", "-list_devices", "true", "-i", ""],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("列出 avfoundation 设备失败: %s", exc)
        return None
    stderr = result.stderr or ""
    in_video = False
    candidates: list[tuple[int, str]] = []
    for line in stderr.splitlines():
        if "AVFoundation video devices" in line:
            in_video = True
            continue
        if "AVFoundation audio devices" in line:
            break
        if not in_video:
            continue
        match = re.search(r"\[(\d+)\]\s+(.+?)\s*$", line)
        if match:
            candidates.append((int(match.group(1)), match.group(2)))
    if name_hint:
        for index, name in candidates:
            if name_hint.lower() in name.lower():
                return index, name
    for index, name in candidates:
        if any(hint in name.lower() for hint in _QUICKTIME_NAME_HINTS):
            return index, name
    return None


class QuickTimeCapture:
    """QuickTime（CoreMediaIO）屏幕采集：ffmpeg → MJPEG → PyAV。"""

    def __init__(
        self,
        ffmpeg: str,
        device_index: int,
        *,
        fps: int = 30,
        input_args: list[str] | None = None,
    ) -> None:
        self.ffmpeg = ffmpeg
        self.device_index = device_index
        self.fps = fps
        # 默认走 QuickTime（avfoundation）；测试里可以换成 lavfi 合成源，
        # 这样"ffmpeg → MJPEG → PyAV → ndarray"整条管线不依赖真机也能验
        self.input_args = input_args or [
            "-f",
            "avfoundation",
            "-framerate",
            str(fps),
            # 只取视频：音频会让 ffmpeg 去协商麦克风权限
            "-i",
            f"{device_index}:none",
        ]
        self.size: Size = (0, 0)
        self.fps_actual = 0.0
        self.frames = 0
        self.error: str | None = None
        self._frame: np.ndarray | None = None
        self._frame_id = 0
        self._lock = threading.Lock()
        self._event = threading.Event()
        self._stop = threading.Event()
        self._proc: subprocess.Popen[bytes] | None = None
        self._container: Any = None
        self._thread: threading.Thread | None = None

    def start(self, timeout: float = 12.0) -> None:
        import av

        command = [
            self.ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            *self.input_args,
            "-an",
            "-c:v",
            "mjpeg",
            "-q:v",
            "4",
            "-f",
            "mjpeg",
            "pipe:1",
        ]
        logger.info("QuickTime 采集: %s", " ".join(command))
        self._proc = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
        )
        assert self._proc.stdout is not None
        self._container = av.open(self._proc.stdout, format="mjpeg")
        self._thread = threading.Thread(target=self._loop, name="quicktime", daemon=True)
        self._thread.start()

        # 等首帧：界面需要分辨率，而且"视频流在跑"也是触摸注入的前提
        deadline = time.time() + timeout
        while time.time() < deadline and self._frame is None:
            time.sleep(0.1)
        if self._frame is None:
            raise RuntimeError(
                "QuickTime 采集没有出帧。检查：① 设备已解锁信任 ② 没被 QuickTime Player 独占 "
                "③ GAMEPILOT_IOS_USB_CONFIG_CMD 里的 config2 切换是否已执行"
            )

    def _loop(self) -> None:
        started = time.time()
        window = 0
        try:
            container = self._container
            if container is None or not hasattr(container, "decode"):
                return
            for frame in container.decode(video=0):
                image = frame.to_ndarray(format="bgr24")
                with self._lock:
                    self._frame = image
                    self._frame_id += 1
                    self.size = (int(image.shape[1]), int(image.shape[0]))
                self._event.set()
                self.frames += 1
                window += 1
                elapsed = time.time() - started
                if elapsed >= 2.0:
                    self.fps_actual = window / elapsed
                    window = 0
                    started = time.time()
        except Exception as exc:  # 流断了就记原因，别静默
            self.error = f"{type(exc).__name__}: {exc}"
            logger.warning("QuickTime 采集结束: %s", self.error)
        finally:
            self._stop.set()

    def latest_frame(self, timeout: float = 1.0) -> np.ndarray | None:
        if timeout > 0 and self._event.wait(timeout):
            self._event.clear()
        with self._lock:
            return None if self._frame is None else self._frame.copy()

    @property
    def frame_id(self) -> int:
        return self._frame_id

    @property
    def alive(self) -> bool:
        return not self._stop.is_set()

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        if self._proc is not None:
            if self._proc.poll() is None:
                self._proc.kill()
            self._proc.wait(timeout=5)
            # 管道要显式关：项目开了 filterwarnings=error，未关闭的句柄会直接判失败
            if self._proc.stdout is not None:
                with contextlib_suppress():
                    self._proc.stdout.close()
            self._proc = None
        container = self._container
        if container is not None:
            with contextlib_suppress():
                container.close()
            self._container = None


# ---------------------------------------------------------------------- #
# pymobiledevice3 CoreDevice HID
# ---------------------------------------------------------------------- #


class HidBridge:
    """CoreDevice HID（触摸 / 按键 / 文本），跑在自己的 asyncio 事件循环里。

    UserspaceRsdTunnel 是进程级单例，所以这里也做成"一个进程一台设备"。
    """

    def __init__(self, udid: str) -> None:
        self.udid = udid
        self._loop: Any = None
        self._thread: threading.Thread | None = None
        self._tunnel: Any = None
        self._rsd: Any = None
        self._uhs: Any = None
        self._indigo: Any = None
        self._keyboard_id: int | None = None
        self.connected = False
        self.error: str | None = None

    # ---------- 生命周期 ----------

    def _ensure_loop(self) -> Any:
        import asyncio

        if self._loop is not None:
            return self._loop
        ready = threading.Event()

        def runner() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
            ready.set()
            loop.run_forever()

        self._thread = threading.Thread(target=runner, name="ios-hid", daemon=True)
        self._thread.start()
        ready.wait(timeout=5)
        return self._loop

    def run(self, coro: Any, timeout: float = 20.0) -> Any:
        import asyncio

        loop = self._ensure_loop()
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        return future.result(timeout=timeout)

    def connect(self) -> None:
        try:
            self.run(self._aconnect())
            self.connected = True
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"
            raise

    async def _aconnect(self) -> None:
        from pymobiledevice3.remote.core_device.hid_service import (
            IndigoHIDService,
            UniversalHIDServiceService,
        )
        from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
        from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel

        tunnel = UserspaceRsdTunnel(serial=self.udid)
        await tunnel.aopen()
        self._tunnel = tunnel
        rsd = RemoteServiceDiscoveryService((tunnel.address, tunnel.port))
        await rsd.connect()
        self._rsd = rsd
        self._uhs = UniversalHIDServiceService(rsd)
        await self._uhs.connect()
        try:
            self._indigo = IndigoHIDService(rsd)
            await self._indigo.connect()
        except Exception as exc:  # 按键不可用不该挡住触摸
            logger.warning("Indigo（按键）不可用: %s", exc)
            self._indigo = None
        logger.info("iOS HID 就绪: %s", self.udid)

    def close(self) -> None:
        async def cleanup() -> None:
            for service in (self._uhs, self._indigo, self._rsd, self._tunnel):
                if service is None:
                    continue
                with contextlib_suppress():
                    await service.close()

        try:
            self.run(cleanup(), timeout=10)
        except Exception:
            logger.debug("关闭 iOS HID 失败", exc_info=True)
        self.connected = False

    # ---------- 触摸 ----------

    async def _touch(self, state: int, x: int, y: int) -> None:
        from pymobiledevice3.remote.core_device.hid_service import (
            DIGITIZER_SURFACE_MAIN_TOUCHSCREEN,
        )

        if self._uhs is None:
            raise RuntimeError("iOS 触摸不可用（HID 未连上）")
        await self._uhs.send_touchscreen(
            state,
            max(0, min(DIGITIZER_MAX, int(x))),
            max(0, min(DIGITIZER_MAX, int(y))),
            service_id=DIGITIZER_SURFACE_MAIN_TOUCHSCREEN,
        )

    def touch(self, phase: str, x: int, y: int) -> None:
        from pymobiledevice3.remote.core_device.hid_service import (
            TOUCHSCREEN_STATE_CONTACT,
            TOUCHSCREEN_STATE_RELEASE,
        )

        state = TOUCHSCREEN_STATE_RELEASE if phase == "up" else TOUCHSCREEN_STATE_CONTACT
        self.run(self._touch(state, x, y))

    def press(self, name: str) -> None:
        if name not in NAMED_BUTTONS:
            raise ValueError(f"iOS 不支持的按键: {name}")
        if self._indigo is None:
            raise RuntimeError("iOS 按键不可用（Indigo 未连上）")
        usage_page, usage_code = NAMED_BUTTONS[name]
        self.run(self._apress(usage_page, usage_code))

    async def _apress(self, usage_page: int, usage_code: int) -> None:
        from pymobiledevice3.remote.core_device.hid_service import (
            HID_BUTTON_STATE_DOWN,
            HID_BUTTON_STATE_UP,
        )

        assert self._indigo is not None
        await self._indigo.send_button(usage_page, usage_code, HID_BUTTON_STATE_DOWN)
        await asyncio_sleep(0.06)
        await self._indigo.send_button(usage_page, usage_code, HID_BUTTON_STATE_UP)

    def text(self, value: str) -> None:
        self.run(self._atext(value))

    async def _atext(self, value: str) -> None:
        from pymobiledevice3.remote.core_device.hid_service import ASCII_TO_HID

        if self._uhs is None:
            raise RuntimeError("iOS 文本输入不可用（HID 未连上）")
        if self._keyboard_id is None:
            self._keyboard_id = await self._uhs.create_keyboard_service()
        usages: list[tuple[int, bool]] = []
        for char in value:
            mapped = ASCII_TO_HID.get(char)
            if mapped is None:
                continue
            usage, shift = mapped
            usages.append((usage, shift))
            await self._uhs.send_keyboard(self._keyboard_id, usages=[u for u, _ in usages], modifier=shift)
            usages.clear()
            await asyncio_sleep(0.03)


def contextlib_suppress() -> Any:
    import contextlib

    return contextlib.suppress(Exception)


async def asyncio_sleep(seconds: float) -> None:
    import asyncio

    await asyncio.sleep(seconds)


# ---------------------------------------------------------------------- #
# 控制器
# ---------------------------------------------------------------------- #


@register
class IosController(Controller):
    """URI: ``iOS:///?udid=xxxx``（仅 iOS ≥ 17.4）。"""

    scheme = "iOS"
    description = "iPhone / iPad（QuickTime 采集 + pymobiledevice3 HID）"

    def __init__(self, device_id: str = "", udid: str = "", **options: Any) -> None:
        super().__init__(device_id or f"{KIND_IOS}:{udid}", **options)
        self.udid = udid
        self.channel = "quicktime"
        self.link_note = ""
        self._capture: QuickTimeCapture | None = None
        self._hid: HidBridge | None = None
        self._last_frame: np.ndarray | None = None
        self._frame_seq = 0
        self._capture_name = ""

    # ---------- 连接 ----------

    def connect(self) -> None:
        device = next((item for item in list_devices() if item.udid == self.udid), None)
        if device is None:
            raise RuntimeError(f"找不到 iOS 设备: {self.udid}（`pymobiledevice3 usbmux list` 里没有）")
        if not device.supported():
            raise RuntimeError(
                f"这台设备是 iOS {device.version}，只支持 {IOS_MIN_VERSION[0]}.{IOS_MIN_VERSION[1]}+"
                "（低版本没有可用的用户态 RSD 隧道）"
            )
        if not ffmpeg_available():
            raise RuntimeError("缺少 ffmpeg：QuickTime 采集要用它（brew install ffmpeg）")

        self._ensure_usb_config()
        self._start_capture(device)
        self._start_hid()
        self._connected = True

    def _ensure_usb_config(self) -> None:
        """起 QuickTime 之前先切 USB 配置，否则 QuickTime 独占设备、后面连不上。

        各家机器上的命令不一样，用 `GAMEPILOT_IOS_USB_CONFIG_CMD` 指定；
        没配置就只提示一条，不阻塞（也许用户已经手动切好了）。
        """
        command = os.environ.get("GAMEPILOT_IOS_USB_CONFIG_CMD", "").strip()
        if not command:
            self.link_note = "QuickTime 采集（未配置 GAMEPILOT_IOS_USB_CONFIG_CMD，USB 配置需自行切换）"
            logger.info(
                "提醒：macOS 上用 QuickTime 采集前要先切 USB 到 config2，否则 QuickTime 会独占设备；"
                "可用 GAMEPILOT_IOS_USB_CONFIG_CMD 指定切换命令"
            )
            return
        logger.info("切换 iOS USB 配置: %s", command)
        result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=60, check=False)
        if result.returncode != 0:
            raise RuntimeError(
                f"USB 配置切换失败（退出码 {result.returncode}）: {(result.stderr or result.stdout).strip()[:200]}"
            )
        self.link_note = "QuickTime 采集（已切换 USB 配置）"

    def _start_capture(self, device: IosDevice) -> None:
        ffmpeg = shutil.which("ffmpeg")
        assert ffmpeg is not None
        found = find_capture_device(ffmpeg, name_hint=device.name.split(" ")[0])
        if found is None:
            raise RuntimeError(
                "在 avfoundation 设备列表里找不到 iOS 采集设备。"
                "确认：① 设备已连接并信任 ② 已在 `系统设置 → 隐私与安全性 → 屏幕录制` 里给终端授权 "
                "③ 先切好 USB config2（QuickTime 独占时这里就看不到设备）"
            )
        index, name = found
        self._capture_name = name
        capture = QuickTimeCapture(ffmpeg, index)
        capture.start()
        self._capture = capture
        self.channel = "quicktime"
        note = self.link_note or "QuickTime 采集"
        self.link_note = f"{note} · {name}"

    def _start_hid(self) -> None:
        bridge = HidBridge(self.udid)
        bridge.connect()
        self._hid = bridge

    # ---------- 采集 ----------

    @property
    def resolution(self) -> Size:
        if self._capture is not None and self._capture.size != (0, 0):
            return self._capture.size
        return (0, 0)

    @property
    def link_fps(self) -> float:
        return float(self._capture.fps_actual) if self._capture is not None else 0.0

    def screenshot(self) -> np.ndarray:
        if self._capture is None:
            raise RuntimeError("iOS 采集未启动")
        frame = self._capture.latest_frame(timeout=0.0)
        if frame is None:
            frame = self._capture.latest_frame(timeout=1.0)
        if frame is not None:
            self._last_frame = frame
            self._frame_seq = self._capture.frame_id
            return frame
        if self._last_frame is not None:
            return self._last_frame
        raise RuntimeError(f"iOS 采集没有画面: {self._capture.error or '未知原因'}")

    def to_dict(self) -> dict[str, Any]:
        data = super().to_dict()
        data.update(
            {
                "channel": self.channel,
                "linkNote": self.link_note,
                "linkFps": round(self.link_fps, 1),
                "udid": self.udid,
            }
        )
        return data

    # ---------- 控制 ----------

    def _hid_or_raise(self) -> HidBridge:
        if self._hid is None or not self._hid.connected:
            raise RuntimeError("iOS HID 未连接")
        return self._hid

    def touch(self, phase: str, x: float, y: float) -> None:
        if phase not in ("down", "move", "up"):
            raise ValueError(f"phase 必须是 down/move/up，收到: {phase}")
        hid = self._hid_or_raise()
        hid.touch(phase, round(x * DIGITIZER_MAX), round(y * DIGITIZER_MAX))

    def click(self, x: float, y: float) -> None:
        self.touch("down", x, y)
        time.sleep(0.05)
        self.touch("up", x, y)

    def swipe(self, x1: float, y1: float, x2: float, y2: float, duration: float = 0.3) -> None:
        steps = max(4, int(duration / 0.02))
        self.touch("down", x1, y1)
        for index in range(1, steps + 1):
            ratio = index / steps
            self.touch("move", x1 + (x2 - x1) * ratio, y1 + (y2 - y1) * ratio)
            time.sleep(max(0.005, duration / steps))
        self.touch("up", x2, y2)

    def press(self, name: str) -> None:
        if name not in SUPPORTED_KEYS and name not in NAMED_BUTTONS:
            raise ValueError(f"不支持的按键: {name}")
        self._hid_or_raise().press(name)

    def text(self, value: str) -> None:
        self._hid_or_raise().text(value)

    def close(self) -> None:
        if self._hid is not None:
            self._hid.close()
            self._hid = None
        if self._capture is not None:
            self._capture.close()
            self._capture = None
        super().close()
