"""iOS 设备支持（**仅 iOS ≥ 17.4**）。

采集：pymobiledevice3 用户态 RSD 隧道 + **DVT 截图循环**（实测 iPhone 15 Pro Max / iOS 26.6.2：
128ms/张 ≈ 7.8fps、2796x1290；和 adb screencap 一个量级，对模板匹配足够）。

控制：同一条隧道上的 CoreDevice HID
- 触摸：`UniversalHIDServiceService.send_touchscreen(CONTACT/RELEASE, x, y)`，坐标 0..65535
- 按键：`IndigoHIDService.send_button(usage_page, usage_code, DOWN/UP)`
- 文本：`create_keyboard_service()` + `send_keyboard()`

**为什么不是 QuickTime**（实测结论，别再走弯路）：

1. macOS 上 ffmpeg/avfoundation **看不到** iOS 屏幕采集设备 —— 它属于 Continuity/External
   类型，进程没有 `NSCameraUseContinuityCameraDeviceType` 声明就会被系统隐藏；
   配置 1~6 全试过都不出现（ffmpeg 自己也警告这个 key）。
2. pymobiledevice3 的隧道投屏（`DisplayService.startmediastream`）在 iOS 26 上直接报
   "Remote control requires iOS 27.0 or later"。
3. pymobiledevice3 的 HID 文档提到"触摸注入需要媒体流在跑"，但实测 **iOS 26.6.2 上不需要**
   （UniversalHIDService 连上就能注入，触摸/按键都生效）。

**USB 配置的真相**（用 pyusb 测绘了 6 套配置，见 `ios_usb.py`）：
把设备切到配置 2 之后 **usbmux 通路会消失**（配置 2 只有 PTP + 音频 + HID），
所以"QuickTime 独占设备、别的连不上"就是这么来的。正常数据通路在配置 6（11 条接口），
本实现**不切配置**；`ios_usb.survey()` 只做诊断。

`UserspaceRsdTunnel` 是**进程级单例**，一个进程同时只能带一台 iOS 设备（多台要拆进程）。
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Any

import numpy as np

from . import ios_usb
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


# 界面方向（UIInterfaceOrientation）：和 SpringBoard 返回的方向码一致
ORIENT_PORTRAIT = 1
ORIENT_PORTRAIT_UPSIDE_DOWN = 2
ORIENT_LANDSCAPE_LEFT = 3
ORIENT_LANDSCAPE_RIGHT = 4

ORIENTATION_NAMES = {
    ORIENT_PORTRAIT: "竖屏",
    ORIENT_PORTRAIT_UPSIDE_DOWN: "竖屏（倒置）",
    ORIENT_LANDSCAPE_LEFT: "横屏（左）",
    ORIENT_LANDSCAPE_RIGHT: "横屏（右）",
}


def to_digitizer(x: float, y: float, orientation: int) -> tuple[float, float]:
    """把"当前画面里的归一化坐标"换算成 **HID digitizer 坐标**。

    iOS 的触摸注入坐标系是**硬件竖屏**的：界面转到横屏后，直接送 (x, y) 会整体错位
    （实机验证：横屏下点「7」键会点到别处，显示区出现 `888×333.`）。
    用计算器做量化探针逐个方向测过，方向码 4（横屏右）对应 (x, y) → (y, 1-x)：
    在这个变换下点 5 次「7」→ 显示区亮像素 +6060（真的键入了 5 个数字），
    其余三种候选映射分别是 0 / +947 / +164。
    """
    if orientation == ORIENT_PORTRAIT_UPSIDE_DOWN:
        return (1.0 - x, 1.0 - y)
    if orientation == ORIENT_LANDSCAPE_LEFT:
        return (1.0 - y, x)
    if orientation == ORIENT_LANDSCAPE_RIGHT:
        return (y, 1.0 - x)
    return (x, y)


def _version_tuple(text: str) -> tuple[int, ...]:
    parts = re.findall(r"\d+", text or "")
    return tuple(int(item) for item in parts[:3]) or (0,)


def version_supported(version: str) -> bool:
    """是否达到最低版本要求（iOS ≥ 17.4）。"""
    return _version_tuple(version) >= IOS_MIN_VERSION


def pymobiledevice3_available() -> bool:
    return shutil.which("pymobiledevice3") is not None


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


class TunnelSession:
    """iOS 用户态隧道 + DVT 采集（进程级单例：一次一台设备）。

    **为什么不是 QuickTime**：macOS 上 ffmpeg/avfoundation 看不到 iOS 屏幕采集设备
    （它属于 Continuity/External 类型，进程没有 `NSCameraUseContinuityCameraDeviceType`
    声明就会被系统隐藏；实测 config 1~6 全都不出现）。而 pymobiledevice3 的隧道投屏
    （DisplayService.startmediastream）在 iOS 26 上直接报 "requires iOS 27.0 or later"。
    所以 17.4 ~ 26.x 这条区间用 **DVT 截图循环**出帧：实测 128ms/张 ≈ 7.8fps、2796x1290，
    对模板匹配足够（和 adb screencap 一个量级）。

    隧道不需要 sudo（UserspaceRsdTunnel），也不需要切 USB 配置
    （配置 6 = 正常数据通路；切到配置 2 反而会让 usbmux 消失 —— 那才是"QT 独占"的真相）。
    """

    def __init__(self, udid: str, *, fps: float = 8.0) -> None:
        self.udid = udid
        self.fps = fps
        self.size: Size = (0, 0)
        self.fps_actual = 0.0
        self.frames = 0
        self.error: str | None = None
        self._loop: Any = None
        self._thread: threading.Thread | None = None
        self._tunnel: Any = None
        self._rsd: Any = None
        self._dvt: Any = None
        self._shot: Any = None
        self._frame: np.ndarray | None = None
        self._frame_id = 0
        self.failures = 0
        self.reconnects = 0
        self.last_frame_at = 0.0
        self._lock = threading.Lock()
        self._event = threading.Event()
        self._stop = threading.Event()
        self._task: Any = None

    # ---------- 事件循环（pymobiledevice3 全是 async） ----------

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

        self._thread = threading.Thread(target=runner, name="ios-tunnel", daemon=True)
        self._thread.start()
        ready.wait(timeout=5)
        return self._loop

    def run(self, coro: Any, timeout: float = 30.0) -> Any:
        import asyncio

        loop = self._ensure_loop()
        return asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=timeout)

    # ---------- 连接 ----------

    def start(self, timeout: float = 25.0) -> None:
        self.run(self._astart(), timeout=timeout)
        deadline = time.time() + timeout
        while time.time() < deadline and self._frame is None:
            time.sleep(0.05)
        if self._frame is None:
            raise RuntimeError(f"iOS 采集没有出帧: {self.error or '未知原因'}")

    async def _astart(self) -> None:
        from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel
        from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
        from pymobiledevice3.services.dvt.instruments.screenshot import Screenshot

        tunnel = UserspaceRsdTunnel(serial=self.udid)
        rsd = await tunnel.aopen()
        self._tunnel = tunnel
        self._rsd = rsd
        provider = DvtProvider(rsd)
        self._dvt = await provider.__aenter__()
        service = Screenshot(self._dvt)
        await service.connect()
        self._shot = service
        logger.info("iOS 隧道就绪: %s (iOS %s)", self.udid, getattr(rsd, "product_version", "?"))
        self.last_frame_at = time.time()
        self._task = self._loop.create_task(self._loop_shots())

    # ---------- 采集 ----------

    async def _loop_shots(self) -> None:
        import asyncio

        import cv2

        interval = 1.0 / max(1.0, self.fps)
        window_start = time.time()
        window_count = 0
        while not self._stop.is_set():
            begin = time.time()
            try:
                raw = await self._shot.get_screenshot()
                image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
                if image is not None:
                    with self._lock:
                        self._frame = image
                        self._frame_id += 1
                        self.size = (int(image.shape[1]), int(image.shape[0]))
                    self.last_frame_at = time.time()
                    self.failures = 0
                    self._event.set()
                    self.frames += 1
                    window_count += 1
                    elapsed = time.time() - window_start
                    if elapsed >= 2.0:
                        self.fps_actual = window_count / elapsed
                        window_count = 0
                        window_start = time.time()
            except Exception as exc:
                self.error = f"{type(exc).__name__}: {exc}"
                self.failures += 1
                logger.warning("iOS 截图失败(%d): %s", self.failures, self.error)
                # 连续失败说明 DVT 会话废了：重建它（隧道留着，HID 不受影响），别让画面永久冻结
                if self.failures == 3:
                    await self._reopen_dvt()
                await asyncio.sleep(0.5)
            remain = interval - (time.time() - begin)
            if remain > 0:
                await asyncio.sleep(remain)

    async def _reopen_dvt(self) -> None:
        """重建 DVT 截图会话（隧道与 HID 不动）。"""
        from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
        from pymobiledevice3.services.dvt.instruments.screenshot import Screenshot

        logger.warning("iOS 采集重连中（第 %d 次）", self.reconnects + 1)
        with contextlib_suppress():
            if self._dvt is not None:
                await self._dvt.__aexit__(None, None, None)
        self._dvt = None
        self._shot = None
        try:
            provider = DvtProvider(self._rsd)
            self._dvt = await provider.__aenter__()
            service = Screenshot(self._dvt)
            await service.connect()
            self._shot = service
            self.reconnects += 1
            self.error = None
            logger.info("iOS 采集已重连（第 %d 次）", self.reconnects)
        except Exception as exc:
            self.error = f"重连失败: {type(exc).__name__}: {exc}"
            logger.warning("iOS 采集重连失败: %s", self.error)

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

    def rsd(self) -> Any:
        return self._rsd

    def close(self) -> None:
        self._stop.set()

        async def cleanup() -> None:
            if self._task is not None:
                self._task.cancel()
                with contextlib_suppress():
                    await self._task
            if self._dvt is not None:
                with contextlib_suppress():
                    await self._dvt.__aexit__(None, None, None)
            if self._tunnel is not None:
                with contextlib_suppress():
                    await self._tunnel.aclose()

        with contextlib_suppress():
            self.run(cleanup(), timeout=10)
        if self._thread is not None:
            self._loop.call_soon_threadsafe(self._loop.stop) if self._loop else None
            self._thread.join(timeout=2)


# ---------------------------------------------------------------------- #
# pymobiledevice3 CoreDevice HID
# ---------------------------------------------------------------------- #


class HidBridge:
    """CoreDevice HID（触摸 / 按键 / 文本），跑在自己的 asyncio 事件循环里。

    UserspaceRsdTunnel 是进程级单例，所以这里也做成"一个进程一台设备"。
    """

    def __init__(self, udid: str) -> None:
        self.udid = udid
        self._session: TunnelSession | None = None
        self._uhs: Any = None
        self._indigo: Any = None
        self._keyboard_id: int | None = None
        self.connected = False
        self.error: str | None = None

    # ---------- 生命周期 ----------

    def attach(self, session: TunnelSession) -> None:
        """复用采集那条隧道：UserspaceRsdTunnel 是进程级单例，不能开第二条。"""
        self._session = session

    def run(self, coro: Any, timeout: float = 20.0) -> Any:
        if self._session is None:
            raise RuntimeError("HID 未绑定隧道")
        return self._session.run(coro, timeout=timeout)

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

        assert self._session is not None
        rsd = self._session.rsd()
        if rsd is None:
            raise RuntimeError("隧道还没就绪")
        uhs = UniversalHIDServiceService(rsd)
        await uhs.connect()
        self._uhs = uhs
        try:
            indigo = IndigoHIDService(rsd)
            await indigo.connect()
            self._indigo = indigo
        except Exception as exc:  # 按键不可用不该挡住触摸
            logger.warning("Indigo（按键）不可用: %s", exc)
            self._indigo = None
        logger.info("iOS HID 就绪: %s（触摸 ✓%s）", self.udid, " 按键 ✓" if self._indigo else "")

    @property
    def alive(self) -> bool:
        return self.connected and self._uhs is not None

    def reconnect(self) -> None:
        """HID 服务断了就重开（隧道留着，不用动采集）。"""
        logger.warning("iOS HID 重连中: %s", self.udid)
        self.close()
        self._uhs = None
        self._indigo = None
        self._keyboard_id = None
        self.connect()

    def close(self) -> None:
        async def cleanup() -> None:
            for service in (self._uhs, self._indigo):
                if service is None:
                    continue
                with contextlib_suppress():
                    await service.close()

        with contextlib_suppress():
            self.run(cleanup(), timeout=10)
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
    """URI: ``iOS:///?udid=xxxx``（仅 iOS ≥ 17.4）。

    采集：pymobiledevice3 用户态隧道 + DVT 截图循环（实测 ~8fps / 2796x1290）
    控制：同一条隧道上的 CoreDevice HID（UHS 触摸 0..65535 + Indigo 按键 + 虚拟键盘）
    连接前会跑一次 USB 配置测绘：只有当设备不在"有数据通路"的配置上时才提示需要切回来
    （切到配置 2 会让 usbmux 消失，那正是"QuickTime 独占"的真相）。
    """

    scheme = "iOS"
    kind = "ios"
    description = "iPhone / iPad（DVT 采集 + pymobiledevice3 HID，仅 17.4+）"

    def __init__(self, device_id: str = "", udid: str = "", fps: float = 8.0, **options: Any) -> None:
        super().__init__(device_id or f"{KIND_IOS}:{udid}", **options)
        self.udid = udid
        self._display_name = ""
        self._orientation: int = ORIENT_PORTRAIT
        self._orientation_at: float = 0.0
        self._orientation_service: Any = None
        self._orientation_lockdown: Any = None
        self._last_aspect: str = ""
        self.channel = "dvt"
        self.link_note = ""
        self.usb_report = ""
        self._session: TunnelSession | None = None
        self._hid: HidBridge | None = None
        self._last_frame: np.ndarray | None = None
        self._frame_seq = 0
        self._fps = fps

    @property
    def display_name(self) -> str:
        return self._display_name

    # ---------- 连接 ----------

    def connect(self) -> None:
        device = next((item for item in list_devices() if item.udid == self.udid), None)
        if device is None:
            raise RuntimeError(
                f"找不到 iOS 设备: {self.udid}（`pymobiledevice3 usbmux list` 里没有）。"
                "常见原因：线只能充电、手机锁着、没点『信任此电脑』，"
                "或者设备被切到了没有数据通路的 USB 配置（跑 `python -m gamepilot.devices.ios_usb` 看一眼）"
            )
        if not device.supported():
            raise RuntimeError(
                f"这台设备是 iOS {device.version}，只支持 {IOS_MIN_VERSION[0]}.{IOS_MIN_VERSION[1]}+"
                "（低版本没有用户态 RSD 隧道）"
            )
        self._display_name = f"{device.name} (iOS {device.version})" if device.version else device.name
        if not pymobiledevice3_available():
            raise RuntimeError("缺少 pymobiledevice3（uv sync --extra ios 或 brew install pymobiledevice3）")

        self._report_usb_config()
        session = TunnelSession(self.udid, fps=self._fps)
        session.start()
        self._session = session
        self.channel = "dvt"
        self.link_note = f"DVT 采集（{session.size[0]}x{session.size[1]}）"
        if self.usb_report:
            self.link_note += f" · {self.usb_report}"

        bridge = HidBridge(self.udid)
        bridge.attach(session)
        bridge.connect()
        self._hid = bridge
        self._refresh_orientation(force=True)
        self._connected = True

    async def _aquery_orientation(self) -> int:
        """（会话循环里执行）查当前界面方向。"""
        if self._orientation_service is None:
            from pymobiledevice3.lockdown import create_using_usbmux
            from pymobiledevice3.services.springboard import SpringBoardServicesService

            lockdown = await create_using_usbmux(serial=self.udid)
            service = SpringBoardServicesService(lockdown=lockdown)
            await service.connect()
            self._orientation_lockdown = lockdown
            self._orientation_service = service
            logger.info("iOS 界面方向查询就绪")
        return int(await self._orientation_service.get_interface_orientation())

    def _refresh_orientation(self, force: bool = False) -> None:
        """刷新缓存的界面方向：每秒最多查一次；画面比例一变（旋转）立刻查。

        iOS 的 HID digitizer 是硬件竖屏坐标系，界面转横屏后必须做变换，
        所以要不断知道"现在是哪个方向"。
        """
        now = time.time()
        if not force and now - self._orientation_at < 1.0:
            return
        self._orientation_at = now
        if self._session is None:
            return
        try:
            previous = self._orientation
            self._orientation = self._session.run(self._aquery_orientation(), timeout=8)
            if self._orientation != previous:
                logger.info(
                    "iOS 界面方向: %s（触摸坐标会做对应旋转）",
                    ORIENTATION_NAMES.get(self._orientation, self._orientation),
                )
        except Exception as exc:
            logger.debug("查界面方向失败（按竖屏处理）: %s", exc)

    @property
    def orientation(self) -> int:
        return self._orientation

    def _report_usb_config(self) -> None:
        """只测绘、不擅自切换：切错配置会让设备从 usbmux 上消失。"""
        try:
            devices = ios_usb.survey()
        except Exception as exc:  # 测绘失败不影响连接
            logger.debug("USB 配置测绘失败: %s", exc)
            return
        if not devices:
            self.usb_report = "USB 层没看到 Apple 设备"
            return
        device = devices[0]
        current = next((item for item in device.configurations if item.value == device.current), None)
        self.usb_report = f"USB 配置 {device.current}（{current.paths if current else '?'} 条通路）"

    # ---------- 采集 ----------

    @property
    def resolution(self) -> Size:
        if self._session is not None and self._session.size != (0, 0):
            return self._session.size
        return (0, 0)

    @property
    def link_fps(self) -> float:
        return float(self._session.fps_actual) if self._session is not None else 0.0

    def _stalled(self, seconds: float = 6.0) -> bool:
        session = self._session
        return session is not None and time.time() - session.last_frame_at > seconds

    def reconnect(self) -> None:
        """整套重连：隧道 + DVT 采集 + HID（隧道级故障时才需要）。"""
        logger.warning("iOS 采集卡住，整套重连: %s", self.udid)
        if self._hid is not None:
            self._hid.close()
            self._hid = None
        if self._session is not None:
            self._session.close()
            self._session = None
        session = TunnelSession(self.udid, fps=self._fps)
        session.start()
        self._session = session
        bridge = HidBridge(self.udid)
        bridge.attach(session)
        bridge.connect()
        self._hid = bridge
        self.link_note = f"DVT 采集（{session.size[0]}x{session.size[1]}，已重连）"

    def screenshot(self) -> np.ndarray:
        if self._session is None:
            raise RuntimeError("iOS 采集未启动")
        size = self._session.size
        aspect = "landscape" if size[0] > size[1] else "portrait"
        if aspect != self._last_aspect:
            self._last_aspect = aspect
            self._refresh_orientation(force=True)  # 旋转了：立刻更新方向
        if self._stalled():
            # 卡住超过 6 秒：先重建 DVT，再不行就整套重连
            self._session.run(self._session._reopen_dvt())
            if self._stalled():
                self.reconnect()
        frame = self._session.latest_frame(timeout=0.0)
        if frame is None:
            frame = self._session.latest_frame(timeout=1.5)
        if frame is not None:
            self._last_frame = frame
            self._frame_seq = self._session.frame_id
            return frame
        if self._last_frame is not None:
            return self._last_frame
        raise RuntimeError(f"iOS 采集没有画面: {self._session.error or '未知原因'}")

    def to_dict(self) -> dict[str, Any]:
        data = super().to_dict()
        data.update(
            {
                "channel": self.channel,
                "linkNote": self.link_note,
                "linkFps": round(self.link_fps, 1),
                "udid": self.udid,
                "usb": self.usb_report,
                # 当前界面方向（横屏错位排查用）
                "orientation": self._orientation,
                "orientationName": ORIENTATION_NAMES.get(self._orientation, str(self._orientation)),
            }
        )
        return data

    # ---------- 控制 ----------

    def _hid_or_raise(self) -> HidBridge:
        if self._hid is None or not self._hid.connected:
            raise RuntimeError("iOS 控制通道未就绪")
        return self._hid

    def _with_hid(self, action: str, call: Any) -> Any:
        """执行一次 HID 操作；断线就自动重连并重试一次，再不行给一句人话。"""
        try:
            return call(self._hid_or_raise())
        except (BrokenPipeError, ConnectionError, ConnectionResetError, OSError) as exc:
            logger.warning("iOS 控制通道断了（%s:%s），自动重连后重试", action, exc)
            self._recover_hid()
            try:
                return call(self._hid_or_raise())
            except (BrokenPipeError, ConnectionError, ConnectionResetError, OSError) as again:
                # 隧道整个没了：整套重连一次
                logger.warning("重试仍失败（%s），整套重连", again)
                self.reconnect()
                try:
                    return call(self._hid_or_raise())
                except Exception as final:
                    raise RuntimeError(
                        f"iOS 控制通道暂时不可用（{type(final).__name__}）。"
                        "隧道可能被系统回收了，已自动重连；请再操作一次"
                    ) from final

    def _recover_hid(self) -> None:
        """优先只重开 HID 服务（便宜），隧道死了才整套重连。"""
        session = self._session
        bridge = self._hid
        try:
            if bridge is None:
                raise RuntimeError("没有 HID")
            bridge.attach(session) if session is not None else None
            bridge.reconnect()
        except Exception as exc:
            logger.warning("只重开 HID 失败（%s），改整套重连", exc)
            self.reconnect()

    def touch(self, phase: str, x: float, y: float) -> None:
        if phase not in ("down", "move", "up"):
            raise ValueError(f"phase 必须是 down/move/up，收到: {phase}")
        self._refresh_orientation()
        dx, dy = to_digitizer(x, y, self._orientation)
        point = (round(dx * DIGITIZER_MAX), round(dy * DIGITIZER_MAX))
        self._with_hid("touch", lambda hid: hid.touch(phase, *point))

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
        self._with_hid("press", lambda hid: hid.press(name))

    def text(self, value: str) -> None:
        self._with_hid("text", lambda hid: hid.text(value))

    def close(self) -> None:
        if self._hid is not None:
            self._hid.close()
            self._hid = None
        if self._session is not None:
            self._session.close()
            self._session = None
        super().close()
