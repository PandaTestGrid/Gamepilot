"""iOS ≥ 17.4：RSD 隧道 + DVT 截图；CoreDevice HID 触摸/按键/键盘。

不用 QuickTime/ffmpeg 采集（macOS 无 Continuity 声明时不可见；iOS 26 上隧道投屏需 27+）。
不切 USB 配置（配置 2 会断 usbmux）。`UserspaceRsdTunnel` 每进程一台设备。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import shutil
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..core.bezier_trajectory import play_swipe_path, play_tap, resolve_swipe_points
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
from .ios_mux import MuxBridge
from .ios_qt import QuickTimeCapture

logger = logging.getLogger("gamepilot.devices.ios")

KIND_IOS = "ios"

# 用户态隧道（PyTCP 的栈）是**进程级单例**：一个引擎进程同时只能带一台 iOS 设备（见模块 docstring）。
# 这里记着"谁在用这个额度"，第二台在碰隧道**之前**就给出人话原因，而不是把 pymobiledevice3 的
# 英文异常（a userspace tunnel is already active in this process）糊到界面上。
_TUNNEL_SLOT: tuple[str, str] | None = None  # (udid, 显示名)
_TUNNEL_SLOT_LOCK = threading.Lock()

# 额度只是"许可证"：它不保证库那边的隧道真的拆掉了（start 超时/没出帧时最容易漏）。
# `_LIVE_SESSION` 才是"谁真的握着 PyTCP 那条隧道"——下一次同设备连接要能先把它收掉。
_LIVE_SESSION: TunnelSession | None = None
_LIVE_LOCK = threading.Lock()

# 建隧道/拆隧道一次只允许一个：pymobiledevice3 的单例检查在各自的事件循环里，
# 跨会话（两套事件循环）没有互斥，必须由我们串起来。
_TUNNEL_TRANSITION_LOCK = threading.RLock()


def _active_tunnel_handle() -> Any:
    """pymobiledevice3 眼里那条活着的隧道句柄（没导入过模块就说明不可能有）。"""
    module = sys.modules.get("pymobiledevice3.remote.userspace_tunnel")
    if module is None:
        return None
    return getattr(module, "_active_tunnel", None)


def _userspace_tunnel_active() -> bool:
    """以**库的实际状态**为准判断进程里还有没有用户态隧道。

    不能只看 `_TUNNEL_SLOT`：额度在 `close()` 里已经还了、库里的单例却还挂着的时候，
    下一次连接会绕过额度直接撞上英文异常。
    """
    module = sys.modules.get("pymobiledevice3.remote.userspace_tunnel")
    if module is None:
        return False
    return _active_tunnel_handle() is not None or bool(getattr(module, "USERSPACE_ACTIVE", False))


def _wait_userspace_released(timeout: float) -> bool:
    """等库那边把隧道放掉（close 可能正把最后一个协程收尾）。"""
    deadline = time.time() + timeout
    while True:
        if not _userspace_tunnel_active():
            return True
        if time.time() >= deadline:
            return False
        time.sleep(0.05)


def _stale_tunnel_message(name: str = "") -> str:
    owner = f"「{name}」的" if name else "上一次"
    return (
        f"引擎进程里还留着{owner} iOS 用户态隧道没释放（一个进程同时只能有一条）。"
        "先把设备断开、等一两秒再连；还不行就重启引擎"
    )


def _live_session() -> TunnelSession | None:
    with _LIVE_LOCK:
        return _LIVE_SESSION


def _set_live_session(session: TunnelSession) -> TunnelSession | None:
    """登记"现在谁握着隧道"，返回被顶掉的上一个会话。"""
    global _LIVE_SESSION
    with _LIVE_LOCK:
        previous, _LIVE_SESSION = _LIVE_SESSION, session
        return previous


def _clear_live_session(session: TunnelSession) -> None:
    global _LIVE_SESSION
    with _LIVE_LOCK:
        if _LIVE_SESSION is session:
            _LIVE_SESSION = None


def _reset_tunnel_globals() -> None:
    """清掉库里的隧道单例标记，让下一次 aopen 能重新建栈。

    仅在**回收不了**的死隧道上使用（隧道是在已经关掉的事件循环里开的）。
    """
    module = sys.modules.get("pymobiledevice3.remote.userspace_tunnel")
    if module is not None:
        # 模块属性在 mypy 里没声明，用 getattr 取到模块对象再赋值可以同时满足
        # ruff（禁止 setattr 常量名）和 mypy（禁止未知属性）。
        with contextlib_suppress():
            vars(module)["_active_tunnel"] = None
        with contextlib_suppress():
            vars(module)["USERSPACE_ACTIVE"] = False
    with contextlib_suppress():
        from pymobiledevice3.remote import tunnel_service

        tunnel_service.USE_USERSPACE_TUNNEL = False


def _clear_dead_stack() -> None:
    """把死循环里留下的 PyTCP 子系统收干净，允许重新建栈。

    PyTCP 的 ARP/ND worker 是绑在**创建它们的事件循环**上的 Task：循环已经关掉时，
    这些 Task 永远不会变成 ``done()``，于是下一次 ``add_interface`` 会在
    ``subsystem.start()`` 的 double-start 断言上直接炸。这里按接口逐个处理：
    先在新循环里 cancel（cancel 本身不依赖旧循环调度），再清掉接口表与任务引用。
    """

    def _stop_subsystems() -> None:
        try:
            from pmd_pytcp import stack as pytcp_stack
        except Exception:
            return
        for ifindex in list(pytcp_stack.interfaces.keys()):
            handler = pytcp_stack.interfaces[ifindex]
            for name in ("_arp_cache", "_nd_cache", "_arp_rx", "_arp_tx", "_ip6_nd_rx", "_ip6_nd_tx"):
                subsystem = getattr(handler, name, None)
                task = getattr(subsystem, "_task", None) if subsystem is not None else None
                if task is not None and subsystem is not None:
                    with contextlib_suppress():
                        task.cancel()
                    with contextlib_suppress():
                        subsystem._task = None  # 死循环里的 Task 永远不会 done()

    async def _inside_loop() -> None:
        _stop_subsystems()

    with contextlib_suppress():
        _run_isolated(_inside_loop(), timeout=10.0)
    _stop_subsystems()  # 兜底：循环外也能 cancel

    with contextlib_suppress():
        from pmd_pytcp import stack as pytcp_stack

        for ifindex in list(pytcp_stack.interfaces.keys()):
            with contextlib_suppress():
                pytcp_stack.interfaces.pop(ifindex)
        vars(pytcp_stack)["_pmd3_inited"] = False


def _friendly_tunnel_error(exc: BaseException) -> BaseException:
    """库里那条单例异常翻成人话（最后一道兜底：前面的清理都失败时也不能直接糊英文）。"""
    text = str(exc)
    if "ARP Cache.start() called while a worker is still running" in text or "ND Cache.start()" in text:
        logger.warning("PyTCP 栈里还留着上一条隧道的 worker: %s", text)
        return RuntimeError(
            "上一条 iOS 隧道所在的 PyTCP 栈没能停干净（上一次引擎异常退出留下的）。"
            "请重启引擎后再连接；如果仍不行，请重新插拔 iPhone。"
        )
    if "userspace tunnel is already active" not in text:
        return exc
    # 原文留在日志里：界面上说人话，排障时还看得到是单例冲突
    logger.warning("pymobiledevice3 用户态隧道单例冲突: %s", exc)
    return RuntimeError(
        "引擎进程里已经有一条 iOS 用户态隧道（一个进程同时只能带一台 iPhone）。"
        "先把现在连着的 iPhone 断开，等一两秒再连这台；如果还报同样的错，重启引擎"
    )


def _force_release_stale_tunnel(udid: str) -> None:
    """把同一台设备遗留的用户态隧道彻底拆掉（幂等，没残留就立刻返回）。

    pymobiledevice3 是进程级单例，而且 PyTCP 的 ARP/会话 worker 必须在**创建它的
    那个事件循环**里停掉。所以顺序是：
    1. 先让旧 TunnelSession 自己 close（停采集、拆 DVT、关隧道、停循环）；
    2. 若库里还挂着句柄，再用一次性隔离循环补最后一刀。
    """
    stale = _live_session()
    if stale is not None and stale.udid == udid:
        logger.warning("发现同一台设备的旧会话，先拆掉: %s", udid)
        with contextlib_suppress():
            stale.close()
        _clear_live_session(stale)

    handle = _active_tunnel_handle()
    if handle is None:
        return
    if getattr(handle, "serial", None) not in (None, udid):
        return
    logger.warning("发现同一台设备的残留隧道，自动回收: %s", udid)

    async def _release() -> None:
        with contextlib_suppress():
            await handle.aclose()
        with contextlib_suppress():
            temp = _active_tunnel_handle()
            if temp is not None and temp is not handle:
                await temp.aclose()

    # PyTCP 的 worker 绑在创建它们的事件循环上，必须在**那个循环**里 stop 才会
    # 真正 done()。所以能拿到旧循环时，优先在原循环里收。
    owner_loop = _loop_owning_tunnel(handle)
    if owner_loop is not None and not owner_loop.is_closed() and owner_loop.is_running():
        with contextlib_suppress():
            future = asyncio.run_coroutine_threadsafe(_release(), owner_loop)
            future.result(timeout=20.0)

    if _userspace_tunnel_released():
        return

    with contextlib_suppress():
        _run_isolated(_release(), timeout=20.0)
    if _userspace_tunnel_released():
        return

    logger.warning("残留隧道所属事件循环已关闭，清理 PyTCP 栈与库单例: %s", udid)
    _clear_dead_stack()
    _reset_tunnel_globals()
    if not _userspace_tunnel_released():
        raise RuntimeError(
            "上一次 iOS 隧道是在已经关闭的事件循环里开的，PyTCP 的工作线程无法安全回收。"
            "请重启引擎（或重新插拔 iPhone）后再连接。"
        )


def _loop_owning_tunnel(handle: Any) -> Any:
    """找到创建这条隧道的事件循环（PyTCP worker 必须在它上面 stop）。"""
    for session in (_live_session(),):
        if session is not None and getattr(session, "_tunnel", None) is handle:
            loop = getattr(session, "_loop", None)
            if loop is not None and not loop.is_closed():
                return loop
    return None


def _userspace_tunnel_released() -> bool:

    """库级句柄确实没了，且 PyTCP 没有还挂着的接口。"""
    if _active_tunnel_handle() is not None:
        return False
    try:
        from pmd_pytcp import stack as pytcp_stack
    except Exception:
        return True
    return len(pytcp_stack.interfaces) == 0


def _claim_tunnel_slot(udid: str, name: str) -> None:

    """占额度：被别的设备占着就报「先断开哪一台」。

    额度空着但库里的隧道还活着（上一次没关干净）也要在这里说清楚：同一台设备的
    残留交给 `TunnelSession.start()` 接管，别的设备/没有句柄的残留只能让人先处理。
    """
    global _TUNNEL_SLOT
    with _TUNNEL_SLOT_LOCK:
        owner = _TUNNEL_SLOT
        if owner is not None and owner[0] != udid:
            raise RuntimeError(f"一次只能连一台 iPhone：先断开「{owner[1]}」再连这台")
        if _userspace_tunnel_active():
            stale = _live_session()
            handover = stale is not None and stale.udid == udid
            if not handover:
                # 是不是**同一台设备**的残留？是就再给一次回收机会，不打断用户
                handle = _active_tunnel_handle()
                same_device = handle is not None and getattr(handle, "serial", None) in (None, udid)
                if same_device:
                    _force_release_stale_tunnel(udid)
                    handover = True
            if not handover and not _wait_userspace_released(1.5):
                raise RuntimeError(_stale_tunnel_message(owner[1] if owner else ""))
        _TUNNEL_SLOT = (udid, name)


def _release_tunnel_slot(udid: str) -> None:
    global _TUNNEL_SLOT
    with _TUNNEL_SLOT_LOCK:
        if _TUNNEL_SLOT is not None and _TUNNEL_SLOT[0] == udid:
            _TUNNEL_SLOT = None


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
    # iOS 没有安卓那几个键，这里做个映射，工作流两边都能用
    "back": (0x0C, 0x40),  # 用 Home 代替"返回"
    "recents": (0x0C, 0x40),
    "enter": (0x0C, 0x28),
    "delete": (0x0C, 0x2A),
}

DIGITIZER_MAX = 65535

# 单次 HID 调用的等待上限：交互路径要"快速失败"，不能把 RPC 挂到超时
HID_CALL_TIMEOUT = 2.0


# 界面方向（UIInterfaceOrientation）：值跟 UIKit 的枚举、SpringBoard 返回的方向码一致。
# 注意别按"手机往哪转"来记：3 = LandscapeRight（Home 在右），4 = LandscapeLeft（Home 在左）。
ORIENT_PORTRAIT = 1
ORIENT_PORTRAIT_UPSIDE_DOWN = 2
ORIENT_LANDSCAPE_RIGHT = 3  # Home 在右
ORIENT_LANDSCAPE_LEFT = 4  # Home 在左

ORIENTATION_NAMES = {
    ORIENT_PORTRAIT: "竖屏",
    ORIENT_PORTRAIT_UPSIDE_DOWN: "竖屏（倒置）",
    ORIENT_LANDSCAPE_RIGHT: "横屏（Home 在右）",
    ORIENT_LANDSCAPE_LEFT: "横屏（Home 在左）",
}

# SpringBoard / pymobiledevice3：3=常见横屏（Home 在右），4=Home 在左。
# 不要按「手机往哪转」来记，Apple 的 Left/Right 是 Home 键位置。
_LANDSCAPE_CODES = (ORIENT_LANDSCAPE_RIGHT, ORIENT_LANDSCAPE_LEFT)


def effective_orientation(orientation: int, width: int = 0, height: int = 0) -> int:
    """方向码和截图缓冲对不上时的兜底：**以界面方向为准，不按缓冲形状判断**。

    HID digitizer 固定在物理玻璃的**竖屏轴**上（`mainTouchscreen` 永远用
    natural portrait 坐标，见 `to_digitizer`），跟这一帧 DVT 截图是横是竖无关，
    所以缓冲已经是横屏时也**不能**把旋转省掉。
    方向码还停在竖屏（查询失败 / 还没刷新 / 压根不认识）而缓冲已经是横屏时，
    按最常见的横屏方向（Home 在右 = 3）兜底 —— 总比原样送进去偏 90° 好。
    宽高未知时保留方向码。
    """
    if width > height > 0 and orientation not in _LANDSCAPE_CODES:
        return ORIENT_LANDSCAPE_RIGHT
    return orientation


def orient_screenshot(image: np.ndarray, orientation: int) -> np.ndarray:
    """把 DVT 原图转到当前界面方向，让投屏/框选/点击共用横屏坐标系。

    DVT 常常交出硬件竖屏像素；手机已经横过来时必须把图转成宽>高，
    否则画面栏仍按竖屏控制。图本身已经是横的就不再转。
    """
    if image.ndim < 2:
        return image
    import cv2

    already_landscape = image.shape[1] > image.shape[0]
    if orientation == ORIENT_PORTRAIT_UPSIDE_DOWN:
        return cv2.rotate(image, cv2.ROTATE_180)
    # 3 = Home 在右：竖屏缓冲逆时针转 90° 才是用户看到的横屏
    if orientation == ORIENT_LANDSCAPE_RIGHT:
        return image if already_landscape else cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
    # 4 = Home 在左：竖屏缓冲顺时针转 90°
    if orientation == ORIENT_LANDSCAPE_LEFT:
        return image if already_landscape else cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
    return image


def to_digitizer(
    x: float,
    y: float,
    orientation: int,
    size: Size | None = None,
) -> tuple[float, float]:
    """把"当前画面里的归一化坐标"换算成 **HID digitizer 坐标**。

    `mainTouchscreen` 的 digitizer 固定在**物理玻璃的竖屏轴**上
    （natural portrait，Home 在底边），不会跟着界面转。所以不管投屏这一帧
    是横是竖，横屏的点击都必须旋回竖屏玻璃坐标：

    - Home 在右（方向码 3，竖屏画面逆时针转 90° 后才是横屏）：(x, y) → (1-y, x)
    - Home 在左（方向码 4，竖屏画面顺时针转 90° 后才是横屏）：(x, y) → (y, 1-x)

    `size` 是原始截图的宽高，只用来在方向码缺失时兜底（见
    `effective_orientation`），不参与换算本身。
    """
    if size is not None:
        orientation = effective_orientation(orientation, size[0], size[1])
    if orientation == ORIENT_PORTRAIT_UPSIDE_DOWN:
        return (1.0 - x, 1.0 - y)
    # 3 = Home 在右（画面是竖屏缓冲逆时针转 90°）：点画面 (x,y) → 竖屏玻璃 (1-y, x)
    if orientation == ORIENT_LANDSCAPE_RIGHT:
        return (1.0 - y, x)
    # 4 = Home 在左（画面是竖屏缓冲顺时针转 90°）：(x,y) → (y, 1-x)
    if orientation == ORIENT_LANDSCAPE_LEFT:
        return (y, 1.0 - x)
    return (x, y)


def _version_tuple(text: str) -> tuple[int, ...]:
    parts = re.findall(r"\d+", text or "")
    return tuple(int(item) for item in parts[:3]) or (0,)


def version_known(version: str) -> bool:
    """版本号是否真的读到了（空串 = lockdown 没读到，不代表版本低）。"""
    return bool(re.search(r"\d", version or ""))


def version_supported(version: str) -> bool:
    """是否达到最低版本要求（iOS ≥ 17.4）。

    版本未知时返回 True：读不到版本通常是上一轮隧道残留/设备忙，
    把它误报成"只支持 17.4+"会把真正的连接原因盖掉。
    """
    if not version_known(version):
        return True
    return _version_tuple(version) >= IOS_MIN_VERSION


def _pymobiledevice3_cli() -> str | None:
    """当前解释器 venv 里的 CLI，或 PATH 上的 pymobiledevice3。"""
    import sys

    scripts = Path(sys.executable).resolve().parent
    for name in ("pymobiledevice3", "pymobiledevice3.exe"):
        candidate = scripts / name
        if candidate.is_file():
            return str(candidate)
    return shutil.which("pymobiledevice3")


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


async def _read_lockdown_info(udid: str, connection: str) -> dict[str, Any]:
    """在同一个事件循环里创建、读取并关闭 lockdown。"""
    from pymobiledevice3.lockdown import create_using_usbmux

    lockdownd = await asyncio.wait_for(
        create_using_usbmux(serial=udid, autopair=False, connection_type=connection),
        timeout=3,
    )
    try:
        return dict(lockdownd.short_info or {})
    finally:
        with contextlib.suppress(Exception):
            await lockdownd.close()


def normalize_udid(value: str) -> str:
    """统一 UDID 写法：iOS 的 UDID 是 8-16 位十六进制，界面上常带横线。

    ``00008150000E348811C0401C`` 与 ``00008150-000E348811C0401C`` 是同一台设备，
    比较时必须归一化，否则会出现"设备明明在列表里却说找不到"。
    """
    return (value or "").replace("-", "").strip().lower()


def list_devices() -> list[IosDevice]:
    """通过 pymobiledevice3 的进程内 usbmux 客户端读取设备；不需要 iTunes。

    冻结包和开发态走同一条路径。曾经调用 `python -m pymobiledevice3 ...`，
    冻结后 `-m` 会被 PyInstaller 丢掉，CLI 打印帮助后还返回 0，将真实错误
    伪装成“没有 iPhone”。这里直接调用库，异常交给设备发现的 iOS 分支展示。
    """
    from pymobiledevice3 import usbmux

    payload = _run_isolated(asyncio.wait_for(usbmux.list_devices(), timeout=15), timeout=20.0)
    devices: list[IosDevice] = []
    for item in payload:
        udid = str(item.serial or "")
        if not udid:
            continue
        connection = str(item.connection_type or "USB")
        try:
            # 创建和关闭必须在同一个事件循环里：跨线程 close 会让
            # Windows proactor 的 socket transport 失去归属，GC 时报未关闭。
            info = _run_isolated(
                _read_lockdown_info(udid, connection),
                timeout=10.0,
            )
        except Exception as exc:
            # 未信任/离线设备仍然应出现在列表里，后续连接会给出准确修复建议。
            logger.debug("读取 iOS %s 基础信息失败: %s", udid, exc)
            info = {}
        finally:
            pass
        devices.append(
            IosDevice(
                udid=udid,
                name=str(info.get("DeviceName") or info.get("ProductType") or "iOS 设备"),
                version=str(info.get("ProductVersion") or ""),
                connection=connection,
            )
        )
    return devices


_SCREEN_SIZE_CACHE: dict[str, Size] = {}


def screen_size(udid: str) -> Size | None:
    """读 iOS 屏幕的**像素**分辨率（lockdown 的 `com.apple.mobile.iTunes` 域）。

    为什么在发现阶段读：iOS 的分辨率本来只有连上之后才从采集管道里知道（DVT 画布尺寸），
    而"这台是什么屏"是挑设备时就要看的信息 —— 用户反馈"iOS 设备没有看到设备分辨率"。
    `ScreenWidth / ScreenHeight` 就是像素（iPhone 13 Pro → 1170×2532），
    和 Android 的 `wm size` 是同一层含义。

    读一次要开一条 lockdown 会话（~0.5s），所以只缓存**成功**的结果；
    没配对 / 没信任 / 隧道被占 / 读不到 —— 一律返回 None（列表照常出现，那一格显示 `—`），
    绝不因为拿不到分辨率就让设备从列表里消失。
    """
    cached = _SCREEN_SIZE_CACHE.get(udid)
    if cached is not None:
        return cached
    try:
        size: Size | None = _run_isolated(_read_screen_size(udid), timeout=20.0)
    except Exception as exc:  # 任何失败都只是"拿不到"：发现流程不能因为它挂掉
        logger.debug("读取 iOS 屏幕尺寸失败 %s: %s", udid, exc)
        return None
    if size is not None:
        _SCREEN_SIZE_CACHE[udid] = size
    return size


def _run_isolated(coro: Any, timeout: float = 20.0) -> Any:
    """在自己的线程里跑完一个协程，并彻底关掉事件循环。

    为什么不用 ``asyncio.run``：Windows 的 Proactor 事件循环收尾时偶尔会留下
    未关闭的 socket transport，GC 才报 ``unclosed transport``。发现阶段会反复调用
    这里，泄漏会一路带进 pytest 和长时间运行。独立线程 + 显式 close 能收干净。
    """
    box: dict[str, Any] = {}
    finished = threading.Event()

    def runner() -> None:
        # 显式用 ProactorEventLoop：Windows 上 new_event_loop() 的默认策略
        # 在关闭后偶尔会把 socket transport 留到 GC，触发 unclosed transport。
        loop = asyncio.ProactorEventLoop() if hasattr(asyncio, "ProactorEventLoop") else asyncio.new_event_loop()
        try:
            asyncio.set_event_loop(loop)
            box["value"] = loop.run_until_complete(asyncio.wait_for(coro, timeout=timeout))
        except BaseException as exc:  # 原样交回调用方
            box["error"] = exc
        finally:
            # 关键：transport.close() 是异步的。协程返回后立刻 close() 循环，
            # 关闭回调没机会跑，Windows proactor 就会在 GC 时报
            # "unclosed transport"。先让循环空转一小会儿把它排干。
            with contextlib.suppress(Exception):
                loop.run_until_complete(asyncio.sleep(0.25))
            with contextlib.suppress(Exception):
                loop.run_until_complete(loop.shutdown_asyncgens())
            with contextlib.suppress(Exception):
                loop.run_until_complete(loop.shutdown_default_executor())
            asyncio.set_event_loop(None)
            with contextlib.suppress(Exception):
                loop.close()
            finished.set()

    thread = threading.Thread(target=runner, name="ios-async-once", daemon=True)
    thread.start()
    if not finished.wait(timeout + 5.0):
        raise TimeoutError("iOS 异步任务超时")
    if "error" in box:
        raise box["error"]
    return box.get("value")


async def _read_screen_size(udid: str) -> Size | None:
    from pymobiledevice3.lockdown import create_using_usbmux

    lockdown = await asyncio.wait_for(create_using_usbmux(serial=udid), timeout=8)
    try:
        values = await asyncio.wait_for(lockdown.get_value(domain="com.apple.mobile.iTunes"), timeout=8)
    finally:
        # 及时关闭 lockdown，避免 GC 时 StreamWriter 警告在 pytest 里判失败。
        with contextlib.suppress(Exception):
            await lockdown.close()
    if not isinstance(values, dict):
        return None
    width = values.get("ScreenWidth")
    height = values.get("ScreenHeight")
    if isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0:
        return (int(width), int(height))
    return None


def _collect_transports() -> None:
    """回收 asyncio proactor 遗留的 socket transport（只回收已关闭的）。"""
    import gc

    gc.collect()


def discover() -> list[DeviceInfo]:
    """给 device.list 用的发现函数（只返回达标的设备）。"""
    out: list[DeviceInfo] = []
    try:
        devices = list_devices()  # 内部已经是隔离事件循环，收尾干净
    finally:
        # Windows 的 proactor 收尾偶尔会留下未关闭的 socket transport；
        # 发现会被反复调用，这里主动回收一次，别把泄漏带进长时间运行。
        _collect_transports()
    for device in devices:
        out.append(
            DeviceInfo(
                id=f"{KIND_IOS}:{device.udid}",
                uri=device.uri,
                name=f"{device.name} (iOS {device.version or '?'})",
                kind=KIND_IOS if device.supported() else KIND_ANDROID,
                status=STATUS_DISCOVERED if device.supported() else STATUS_FAILED,
                serial=device.udid,
                model=device.name,
                # 发现阶段就把分辨率读出来（读不到就是 None，界面显示 —）
                resolution=screen_size(device.udid) if device.supported() else None,
                error=None if device.supported() else f"仅支持 iOS {IOS_MIN_VERSION[0]}.{IOS_MIN_VERSION[1]}+",
            )
        )
    return out


class TunnelSession:
    """RSD 隧道 + DVT 截图（单例，一进程一台设备）。不切 USB 配置。"""

    def __init__(self, udid: str, *, fps: float = 8.0, name: str = "") -> None:
        self.udid = udid
        self.name = name
        self.fps = fps
        self.size: Size = (0, 0)
        self.fps_actual = 0.0
        self.frames = 0
        #: 最近两帧的**到达**时间（采集线程写入，不是 screenshot() 的调用时间）
        self._last_arrival_at = 0.0
        self._prev_arrival_at = 0.0
        self.error: str | None = None
        self._loop: Any = None
        self._thread: threading.Thread | None = None
        self._tunnel: Any = None
        self._rsd: Any = None
        self._dvt: Any = None
        self._shot: Any = None
        self._frame: np.ndarray | None = None
        self._encoded: bytes | None = None
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

    def submit(self, coro: Any) -> None:
        """只丢进事件循环，不等待结果（触摸路径绝不能被这类杂事卡住）。"""
        import asyncio

        loop = self._ensure_loop()
        asyncio.run_coroutine_threadsafe(coro, loop)

    # ---------- 连接 ----------

    def start(self, timeout: float = 25.0) -> None:
        """建隧道 + 等第一帧；**任何失败都把自己收干净**。

        以前这里 `run(...)` 一把梭：超时/没出帧时控制器还没把 session 挂到 `self._session`，
        隧道就漏在 pymobiledevice3 的进程级单例里；下一次连接撞上英文异常
        "a userspace tunnel is already active in this process"。
        """
        with _TUNNEL_TRANSITION_LOCK:
            previous = _set_live_session(self)
            if previous is not None and previous is not self:
                if previous.udid != self.udid:
                    _set_live_session(previous)  # 还没动手，先还原
                    raise RuntimeError(f"一次只能连一台 iPhone：先断开「{previous.name or previous.udid}」再连这台")
                # 同一台设备上一次没收干净：先拆旧的，再开新的
                logger.warning("iOS 隧道重连：先拆掉同一台设备的旧会话 %s", self.udid)
                previous.close()
            if _userspace_tunnel_active() and not _wait_userspace_released(2.0):
                _clear_live_session(self)
                raise RuntimeError(_stale_tunnel_message(previous.name if previous else ""))
            from concurrent.futures import TimeoutError as FutureTimeoutError

            try:
                loop = self._ensure_loop()
                future = asyncio.run_coroutine_threadsafe(self._astart(), loop)
                try:
                    future.result(timeout)
                except FutureTimeoutError as exc:
                    # 超时的协程还在跑：取消并等它退出来，否则半条隧道会留在库的单例里
                    future.cancel()
                    with contextlib_suppress():
                        future.result(5.0)
                    raise RuntimeError(f"iOS 隧道建立超过 {timeout:g}s 没完成（设备锁着？）") from exc
            except BaseException as exc:
                self.close()
                friendly = _friendly_tunnel_error(exc)
                if friendly is exc:
                    raise
                raise friendly from exc

        deadline = time.time() + timeout
        while time.time() < deadline and self._frame is None and not self._stop.is_set():
            time.sleep(0.05)
        if self._frame is None:
            try:
                if self._stop.is_set():
                    raise RuntimeError("iOS 连接已取消")
                raise RuntimeError(f"iOS 采集没有出帧: {self.error or '未知原因'}")
            finally:
                self.close()

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
            shot = self._shot  # 采集线程可能正被 close()/_reopen_dvt() 拆掉
            if shot is None:
                if self._stop.is_set():
                    break
                await asyncio.sleep(0.2)
                continue
            try:
                raw = await shot.get_screenshot()
                image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
                if image is not None:
                    with self._lock:
                        self._frame = image
                        # 原始截图字节也留着：子进程那条路要转发它（不重新编码一次）
                        self._encoded = bytes(raw)
                        self._frame_id += 1
                        self.size = (int(image.shape[1]), int(image.shape[0]))
                    self.last_frame_at = now_arrival = time.time()
                    self._prev_arrival_at = self._last_arrival_at
                    self._last_arrival_at = now_arrival
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

    def latest_encoded(self, timeout: float = 0.0) -> bytes | None:
        """最近一帧的**原始截图字节**（子进程转发用；进程内直接用 latest_frame）。"""
        if timeout > 0:
            self._event.wait(timeout)
        with self._lock:
            return self._encoded

    @property
    def frame_id(self) -> int:
        return self._frame_id

    @property
    def alive(self) -> bool:
        return not self._stop.is_set()

    def rsd(self) -> Any:
        return self._rsd

    def close(self) -> None:
        """拆隧道；返回时尽量保证库里的进程级单例真的空出来了。幂等。

        以前的写法是 ``run(cleanup(), timeout=10)`` 一把梭：超时就把异常吞掉、照停事件循环，
        最容易留下"额度已经还了、库里的隧道还在"的状态 —— 下一次连接直接撞英文单例异常。
        现在超时会取消清理协程再等一会儿，并且**以库的状态为准**做最后兜底。
        """
        with _TUNNEL_TRANSITION_LOCK:
            self._stop.set()
            loop = self._loop
            thread = self._thread
            if loop is not None and not loop.is_closed():
                from concurrent.futures import TimeoutError as FutureTimeoutError

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
                    # aopen 成功、句柄还没挂到 self._tunnel 就被取消/超时的窗口里，
                    # 库里那条隧道只剩 `_active_tunnel` 一个引用：在同一个循环里关掉它。
                    active = _active_tunnel_handle()
                    if active is not None and getattr(active, "serial", None) == self.udid:
                        with contextlib_suppress():
                            await active.aclose()
                    self._task = None
                    self._dvt = None
                    self._shot = None
                    self._tunnel = None
                    self._rsd = None

                future = asyncio.run_coroutine_threadsafe(cleanup(), loop)
                try:
                    future.result(timeout=15.0)
                except FutureTimeoutError:
                    logger.warning("关闭 iOS 隧道超时：取消清理协程 %s", self.udid)
                    future.cancel()
                    with contextlib_suppress():
                        future.result(3.0)
                except Exception:
                    logger.warning("关闭 iOS 隧道时出错: %s", self.udid, exc_info=True)
                with contextlib_suppress():
                    loop.call_soon_threadsafe(loop.stop)
            if thread is not None:
                thread.join(timeout=2)
            if loop is not None and not loop.is_closed():
                # 只 stop 不 close 会漏掉循环自己的 self-pipe（ResourceWarning），
                # 半开状态下反复重连尤其明显。
                with contextlib_suppress():
                    loop.close()
            self._loop = None
            self._thread = None
            if not _userspace_tunnel_active():
                _clear_live_session(self)
            else:
                logger.warning("iOS 隧道仍未释放（%s）：留给下一次连接接管", self.udid)


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
        logger.info(
            "iOS HID 已连接: %s（触摸服务 ✓%s）；触摸是否落地取决于系统 auth gate，见 touch_gate_note",
            self.udid,
            " 按键 ✓" if self._indigo else "",
        )

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
        # 触摸是交互路径：宁可能快速失败，也不能挂着让界面等 10 秒
        self.run(self._touch(state, x, y), timeout=HID_CALL_TIMEOUT)

    def press(self, name: str) -> None:
        if name not in NAMED_BUTTONS:
            raise ValueError(f"iOS 不支持的按键: {name}")
        if self._indigo is None:
            raise RuntimeError("iOS 按键不可用（Indigo 未连上）")
        usage_page, usage_code = NAMED_BUTTONS[name]
        self.run(self._apress(usage_page, usage_code), timeout=HID_CALL_TIMEOUT)

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
        self.run(self._atext(value), timeout=HID_CALL_TIMEOUT)

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
    """吞掉清理阶段的任何异常（含 CancelledError）。

    这里不能用 ``suppress(Exception)``：协程被 cancel 时抛的是 ``BaseException``
    的 ``CancelledError``，一旦漏出去，后面的 ``aclose()`` 就不会执行 —— 表现就是
    "额度已还、库里的隧道还挂着"，下一次连接直接失败。
    """
    import contextlib

    return contextlib.suppress(BaseException)


async def asyncio_sleep(seconds: float) -> None:
    import asyncio

    await asyncio.sleep(seconds)


#: iOS 27 之前 `startmediastream` 会被设备拒绝（错误码 9021）。这条流同时是
#: Universal HID 触摸的 auth gate：流开不起来时，触摸报告会被 backboardd 静默丢弃。
def touch_gate_message(version: str = "") -> str:
    """触摸不生效时的说明（带上实际系统版本，别写死某个版本号）。"""
    ver = f"iOS {version} " if version else "当前系统"
    return (
        f"触摸未生效：{ver}拒绝了 startmediastream（9021），"
        "而 Universal HID 触摸必须由这条流打开 auth gate；"
        "Indigo 硬件按键（Home/音量/锁屏）与截图不受影响"
    )


TOUCH_GATE_BLOCKED = touch_gate_message()


@register
class IosController(Controller):
    """``iOS:///?udid=…``，≥17.4。DVT 截图 + 同隧道 HID；不切 USB 配置。"""

    scheme = "iOS"
    kind = "ios"
    description = "iPhone / iPad（DVT 采集 + pymobiledevice3 HID，仅 17.4+）"

    def __init__(
        self,
        device_id: str = "",
        udid: str = "",
        fps: float = 8.0,
        quicktime: bool = False,
        **options: Any,
    ) -> None:
        super().__init__(device_id or f"{KIND_IOS}:{udid}", **options)
        self.udid = udid
        self._display_name = ""
        self._orientation: int = ORIENT_PORTRAIT
        self._orientation_at: float = 0.0
        self._orientation_service: Any = None
        self._orientation_lockdown: Any = None
        self._last_aspect: str = ""
        self._orientation_querying = False
        self._orientation_warned = False
        self._recovering = False
        self.channel = "dvt"
        self.link_note = ""
        self.usb_report = ""
        self._session: TunnelSession | None = None
        self._hid: HidBridge | None = None
        self._last_frame: np.ndarray | None = None
        self._oriented_size: Size | None = None
        self._frame_seq = 0
        self._fps = fps
        # QuickTime（设备直推 H.264）优先；失败自动降到 DVT 截图，并把原因留给界面
        #: 是否尝试 QuickTime 码流（默认关：依赖私有 USB 配置，失败会拉低 usbmux）
        self._qt_enabled = bool(quicktime)
        self._qt: QuickTimeCapture | None = None
        #: QT 配置下把 0xFE 接口包装成本地 usbmuxd，保住控制通道
        self._mux: MuxBridge | None = None
        self._qt_degraded: str = ""
        self._qt_attempted = False
        #: 触摸可能"发送成功但不生效"时的说明（界面要能看见，不能假装正常）
        self.touch_gate_note: str = ""
        self._version: str = ""

    @property
    def display_name(self) -> str:
        return self._display_name

    # ---------- 连接 ----------

    def connect(self) -> None:
        self._recover_from_quicktime_config()
        # 从 QT 配置切回来后，usbmux 需要一点时间重新挂上设备
        device = None
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline:
            wanted = normalize_udid(self.udid)
            device = next((item for item in list_devices() if normalize_udid(item.udid) == wanted), None)
            if device is not None:
                break
            time.sleep(0.5)
        if device is None:
            raise RuntimeError(
                f"找不到 iOS 设备: {self.udid}（`pymobiledevice3 usbmux list` 里没有）。"
                "常见原因：线只能充电、手机锁着、没点『信任此电脑』，"
                "或者设备被切到了没有数据通路的 USB 配置（跑 `python -m gamepilot.devices.ios_usb` 看一眼）"
            )
        if version_known(device.version) and not device.supported():
            raise RuntimeError(
                f"这台设备是 iOS {device.version}，只支持 {IOS_MIN_VERSION[0]}.{IOS_MIN_VERSION[1]}+"
                "（低版本没有用户态 RSD 隧道）"
            )
        if not version_known(device.version):
            # 读不到版本不等于版本低：继续连，真不行会在建隧道那一步给出准确原因。
            logger.warning("没有读到 iOS 版本（%s），按支持版本继续尝试连接", self.udid)
        self._version = device.version or ""
        self._display_name = f"{device.name} (iOS {device.version})" if device.version else device.name

        # 同一台设备上一次没收到尾（引擎里还挂着隧道）：先接管并拆掉，
        # 再占额度。顺序反了会在"没有 live session 的残留"上直接报错。
        _force_release_stale_tunnel(self.udid)
        # 先占进程级额度，再碰隧道：第二台在这里就被挡下（不会走到隧道那一步）
        _claim_tunnel_slot(self.udid, self._display_name)
        try:
            self._report_usb_config()
            session = TunnelSession(self.udid, fps=self._fps, name=self._display_name)
            # **先挂上**再 start：start 半路失败（没出帧/超时）时下面的 close() 才能把它收干净。
            # 以前是 start() 成功后才赋值，失败就漏一条隧道在进程级单例里，重试直接撞英文异常。
            self._session = session
            session.start()
            self.channel = "dvt"
            self.link_note = f"DVT 采集（{session.size[0]}x{session.size[1]}）"
            if self.usb_report:
                self.link_note += f" · {self.usb_report}"

            bridge = HidBridge(self.udid)
            bridge.attach(session)
            bridge.connect()
            self._hid = bridge
            # 注意：这里**不要**去探测 startmediastream。那条调用会占用设备的媒体会话，
            # 反而把触控/截图这条本来能用的链路搅乱。
            # 所以只在显式开启时才试；默认保住截图 + 触控这条能用链路。
            if self._qt_enabled:
                self._try_quicktime()
            try:  # 首次必须拿到方向（横屏下第一次触摸就要对），这里同步等一小会儿
                self._orientation = self._session.run(self._aquery_orientation(), timeout=6)
                logger.info("iOS 界面方向: %s", ORIENTATION_NAMES.get(self._orientation, self._orientation))
            except Exception as exc:
                logger.warning("首次查界面方向失败（按竖屏处理）: %s", exc)
            self._connected = True
        except BaseException:
            # 半连接也要收干净：额度只有一个，漏一次这台就再也连不上了
            self.close()
            raise

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

        iOS 的 HID digitizer 是**硬件竖屏坐标系**，界面转横屏后必须做变换，
        所以要不断知道"现在是哪个方向"。查询失败时保留上次的值，并由
        `effective_orientation` 按画面比例兜底。
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
            self._orientation_warned = False
            if self._orientation != previous:
                logger.info(
                    "iOS 界面方向: %s（触摸坐标会做对应旋转）",
                    ORIENTATION_NAMES.get(self._orientation, self._orientation),
                )
        except Exception as exc:
            # 只警告一次：横屏触摸会由 effective_orientation 按画面比例兜底，
            # 但方向码要是猜的（Home 在左 vs 右），点起来会差 90°，得让人看见。
            if not self._orientation_warned:
                self._orientation_warned = True
                logger.warning(
                    "查界面方向失败（沿用 %s，横屏按画面比例兜底）: %s",
                    ORIENTATION_NAMES.get(self._orientation, self._orientation),
                    exc,
                )

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
            self.usb_report = "libusb0 未枚举到设备（不影响截图/触控）"
            return
        if len(devices) > 1:
            # 测绘结果里没有 udid，插了多台 Apple 设备时分不清哪条是这台：
            # 以前直接取第一条，状态栏会显示成"第一台 iPhone"的 USB 配置。
            self.usb_report = f"USB 层有 {len(devices)} 台 Apple 设备（未逐台核对配置）"
            return
        device = devices[0]
        current = next((item for item in device.configurations if item.value == device.current), None)
        self.usb_report = f"USB 配置 {device.current}（{current.paths if current else '?'} 条通路）"

    # ---------- 采集 ----------

    @property
    def resolution(self) -> Size:
        if self._oriented_size:
            return self._oriented_size
        if self._session is not None and self._session.size != (0, 0):
            return self._session.size
        return (0, 0)

    def _present_frame(self, frame: np.ndarray) -> np.ndarray:
        """按界面方向转正，并让 resolution 跟着转后的画面走。"""
        orientation = effective_orientation(self._orientation, frame.shape[1], frame.shape[0])
        oriented = orient_screenshot(frame, orientation)
        self._oriented_size = (int(oriented.shape[1]), int(oriented.shape[0]))
        return oriented

    @property
    def link_fps(self) -> float:
        qt = self._qt
        if qt is not None and qt.alive:
            return float(qt.fps)
        session = self._session
        if session is None:
            return 0.0
        if session.fps_actual:
            return float(session.fps_actual)
        # 采样窗口（2s）还没满时，用最近两帧的**到达间隔**估计。
        # 不能用 screenshot() 的耗时：它是取缓存帧，会算出几百 fps 的假数字。
        last = session._last_arrival_at
        prev = session._prev_arrival_at
        if last > 0 and prev > 0 and last > prev:
            return round(min(60.0, 1.0 / (last - prev)), 1)
        return 0.0

    def _recover_from_quicktime_config(self) -> None:
        """设备若还停在 QT 隐藏配置（上一次没收到尾），先把它放回普通配置。

        不这么做的话，`usbmux` 里根本看不到设备，连接会以"找不到设备"失败 ——
        而真正的原因是上一次 QuickTime 会话没清理干净。
        """
        try:
            from . import ios_qt

            device = ios_qt.open_apple_device(self.udid)
            if device is None:
                return
            found = ios_qt.find_quicktime_interface(device)
            if found is None:
                return
            logger.warning("设备仍在 QuickTime 配置（%s），先恢复普通配置", found[0])
            ios_qt.request_quicktime_config(False)
            # 句柄必须释放：否则 libusb0 还占着设备，Apple 服务重挂不上，
            # 紧接着的 list_devices() 就会看到空列表。
            with contextlib_suppress():
                import usb.util

                usb.util.dispose_resources(device)
            deadline = time.monotonic() + 15.0
            while time.monotonic() < deadline:
                probe = ios_qt.open_apple_device(self.udid)
                if probe is not None and ios_qt.find_quicktime_interface(probe) is None:
                    with contextlib_suppress():
                        import usb.util

                        usb.util.dispose_resources(probe)
                    logger.info("已恢复普通配置")
                    return
                time.sleep(0.5)
            logger.warning("恢复普通配置超时，设备可能仍需重新插拔")
        except Exception as exc:
            logger.debug("检查 QT 配置状态失败: %s", exc)

    # ---------- QuickTime（设备直推 H.264） ----------

    def _try_quicktime(self) -> None:
        """尝试切到 QuickTime 码流；失败就留在 DVT 截图，并把原因写进 link_note。

        为什么值得试：DVT 是「每次让手机合成一整张 PNG」（实测单帧 562ms / 5.4MB，
        约 1.3fps）；QuickTime 是设备持续推 H.264，主机只解码。

        关键约束：解锁 QT 配置会让设备**重新枚举并离开 usbmux**，所以这条路上
        原来的 RSD 隧道和 HID 一定失效。要么整条重建，要么彻底回滚到截图通道，
        不能留下半死状态。
        """
        if self._qt_attempted and self._qt is not None:
            return
        self._qt_attempted = True
        previous_note = self.link_note
        session = self._session
        size = session.size if session is not None else (0, 0)

        # 顺序很关键：
        #   1) QuickTimeCapture.start() 负责解锁 QT 配置并 claim 0x2A；
        #   2) 配置切过去之后 Apple 的 usbmux 就不管这台设备了，
        #      立刻用 0xFE 自建 usbmuxd，把 RSD/HID 接回来。
        # 反过来先起 mux 桥会因为还没进 QT 配置而拿不到 0xFE 接口。
        capture = QuickTimeCapture(
            self.udid,
            display_size=(float(size[0] or 1206), float(size[1] or 2622)),
        )
        try:
            capture.start(timeout=20.0)
        except Exception as exc:
            with contextlib_suppress():
                capture.close()
            self._qt_degraded = str(exc)
            self.channel = "dvt"
            logger.warning("QuickTime 不可用，继续用 DVT 截图: %s", exc)
            self._restore_after_quicktime(previous_note, exc)
            return

        self._qt = capture
        # QT 配置已经生效，现在接管 0xFE 保住控制
        try:
            self._mux = MuxBridge(self.udid)
            self._mux.start(timeout=15.0)
            logger.info("mux 桥就绪: %s", self._mux.address)
        except Exception as exc:
            logger.warning("mux 桥启动失败（控制会断）: %s", exc)
            with contextlib_suppress():
                if self._mux is not None:
                    self._mux.stop()
            self._mux = None
        rebuilt = self._restore_after_quicktime(previous_note, None)
        self.channel = "quicktime"
        self.link_note = f"QuickTime 码流（{capture.width}x{capture.height}）"
        if self.usb_report:
            self.link_note += f" · {self.usb_report}"
        if not rebuilt:
            logger.warning("QuickTime 已出画面，但触控通道没能重建")
        logger.info("iOS 已切到 QuickTime 采集: %sx%s", capture.width, capture.height)

    def _restore_after_quicktime(self, previous_note: str, error: Exception | None) -> bool:
        """QT 切换后重建 RSD 隧道 + HID；返回触控是否可用。"""
        old_hid = self._hid
        self._hid = None
        if old_hid is not None:
            with contextlib_suppress():
                old_hid.close()
        old_session = self._session
        self._session = None
        if old_session is not None:
            with contextlib_suppress():
                old_session.close()

        session: TunnelSession | None = None
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            probe = TunnelSession(self.udid, fps=self._fps, name=self._display_name)
            try:
                probe.start(timeout=20.0)
            except Exception as exc:
                with contextlib_suppress():
                    probe.close()
                logger.debug("QuickTime 切换后重建隧道未成功: %s", exc)
                time.sleep(2.0)
                continue
            session = probe
            break

        if session is None:
            self.channel = "dvt"
            self.link_note = f"截图通道中断（QuickTime 切换后无法恢复）：{error or '隧道未就绪'}"
            self._qt_degraded = str(error or "QuickTime 切换后隧道无法恢复")
            logger.error("QuickTime 切换后无法恢复隧道，请重新插拔设备")
            return False

        self._session = session
        self._oriented_size = None
        bridge = HidBridge(self.udid)
        bridge.attach(session)
        ok = True
        try:
            bridge.connect()
        except Exception as exc:
            ok = False
            logger.warning("QuickTime 切换后 HID 重建失败: %s", exc)
        self._hid = bridge if ok else None

        if error is None:
            self.link_note = previous_note
        else:
            self.channel = "dvt"
            self.link_note = (
                f"截图兜底（{session.size[0]}x{session.size[1]}，约 1fps / 单帧约 0.6s）：{error}"
            )
            if not ok:
                self.link_note += " · 触控通道未恢复，请重新插拔"
        return ok

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
        session = TunnelSession(self.udid, fps=self._fps, name=self._display_name)
        # 和 connect() 一样：先挂上再 start，失败时这里能收干净（否则重连失败又漏一条隧道）
        self._session = session
        try:
            session.start()
            bridge = HidBridge(self.udid)
            bridge.attach(session)
            bridge.connect()
        except BaseException:
            with contextlib_suppress():
                session.close()
            self._session = None
            self._hid = None
            raise
        self._hid = bridge
        self.link_note = f"DVT 采集（{session.size[0]}x{session.size[1]}，已重连）"
        self._qt_attempted = False
        self._try_quicktime()

    def screenshot(self) -> np.ndarray:
        qt = self._qt
        if qt is not None and qt.alive:
            frame = qt.latest_frame(timeout=0.05)
            if frame is not None:
                presented = self._present_frame(frame)
                self._last_frame = presented
                self._frame_seq = qt.frame_id
                return presented
            # 码流停了：立刻降回截图，别让界面停在最后一帧上装死
            logger.warning("QuickTime 画面中断，降级到 DVT 截图")
            self._qt_degraded = "QuickTime 画面中断"
            qt.close()
            self._qt = None
            self.channel = "dvt"
            if self._session is not None:
                self.link_note = f"截图兜底（已从码流降级）：{self._qt_degraded}"
        if self._session is None:
            raise RuntimeError("iOS 采集未启动")
        size = self._session.size
        aspect = "landscape" if size[0] > size[1] else "portrait"
        # DVT 常常不改像素宽高，不能只在「画面变横」时才问方向。
        self._refresh_orientation(force=aspect != self._last_aspect)
        self._last_aspect = aspect
        if self._stalled():
            # 卡住超过 6 秒：先重建 DVT，再不行就整套重连
            self._session.run(self._session._reopen_dvt())
            if self._stalled():
                self.reconnect()
        frame = self._session.latest_frame(timeout=0.0)
        if frame is None:
            frame = self._session.latest_frame(timeout=1.5)
        if frame is not None:
            presented = self._present_frame(frame)
            self._last_frame = presented
            self._frame_seq = self._session.frame_id
            return presented
        if self._last_frame is not None:
            return self._last_frame
        raise RuntimeError(f"iOS 采集没有画面: {self._session.error or '未知原因'}")

    def to_dict(self) -> dict[str, Any]:
        data = super().to_dict()
        data.update(
            {
                "channel": self.channel,
                "linkNote": self.link_note,
                "qtDegraded": self._qt_degraded or None,
                "touchGate": self.touch_gate_note or None,
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
        """执行一次 HID 操作。

        断线时返回错误并在后台重连，不在 RPC 里同步重连以免超时。
        """
        try:
            return call(self._hid_or_raise())
        except (BrokenPipeError, ConnectionError, ConnectionResetError, OSError) as exc:
            logger.warning("iOS 控制通道断了（%s: %s），已安排后台重连", action, exc)
            self._schedule_recovery()
            raise RuntimeError("iOS 控制通道断了（隧道被系统回收）。已在后台自动重连，1~2 秒后再点一次即可") from exc

    def _schedule_recovery(self) -> None:
        """后台重连：同一个时刻只允许一次。"""
        if self._recovering:
            return
        self._recovering = True

        def worker() -> None:
            try:
                self._recover_hid()
            except Exception as exc:
                logger.warning("后台重连失败: %s", exc)
            finally:
                self._recovering = False

        threading.Thread(target=worker, name="ios-hid-recover", daemon=True).start()

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
        raw = self._session.size if self._session is not None else None
        dx, dy = to_digitizer(x, y, self._orientation, raw)
        point = (round(dx * DIGITIZER_MAX), round(dy * DIGITIZER_MAX))
        if phase == "down":
            logger.info(
                "iOS 触摸: 画面(%.3f,%.3f) 原始截图=%s 方向码=%s 画面=%s → HID(%.3f,%.3f)",
                x,
                y,
                raw,
                self._orientation,
                self.resolution,
                dx,
                dy,
            )
        self._with_hid("touch", lambda hid: hid.touch(phase, *point))

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
        if name not in SUPPORTED_KEYS and name not in NAMED_BUTTONS:
            raise ValueError(f"不支持的按键: {name}")
        self._with_hid("press", lambda hid: hid.press(name))

    def text(self, value: str) -> None:
        self._with_hid("text", lambda hid: hid.text(value))

    def close(self) -> None:
        if self._mux is not None:
            with contextlib_suppress():
                self._mux.stop()
            self._mux = None
        if self._qt is not None:
            with contextlib_suppress():
                self._qt.close()
            self._qt = None
        if self._hid is not None:
            self._hid.close()
            self._hid = None
        if self._session is not None:
            self._session.close()
            self._session = None
        _release_tunnel_slot(self.udid)
        super().close()



