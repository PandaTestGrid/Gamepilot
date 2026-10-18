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

import contextlib
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, ClassVar, NoReturn

import numpy as np

from .base import (
    KIND_ANDROID,
    KIND_EMULATOR,
    STATUS_DISCOVERED,
    STATUS_FAILED,
    SUPPORTED_KEYS,
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


# `dumpsys SurfaceFlinger --display-id`：
#   Display 4619827144452474627 (HWC display 3): port=3 pnpId=GGL displayName="mumuscreen003"
_SF_DISPLAY_RE = re.compile(r'Display\s+(\d+)\s+\(HWC display \d+\):.*?displayName="([^"]*)"')
# `dumpsys display` 的 `mBaseDisplayInfo=DisplayInfo{"名字", displayId N, … real W x H, … uniqueId "local:物理id", …}`
# 只认 mBaseDisplayInfo：mOverrideDisplayInfo 是旋转后的尺寸，会把宽高反过来。
_DISPLAY_INFO_RE = re.compile(
    r'mBaseDisplayInfo=DisplayInfo\{"([^"]*)",\s*displayId\s+(\d+),.*?real\s+(\d+)\s+x\s+(\d+).*?uniqueId\s+"local:(\d+)"'
)
# `dumpsys activity activities`：`Display #4 (activities from top to bottom):` 之后跟 topResumedActivity
_ACTIVITY_DISPLAY_RE = re.compile(r"^\s*Display #(\d+) \(activities", re.MULTILINE)
_TOP_ACTIVITY_RE = re.compile(r"topResumedActivity=ActivityRecord\{[^}]*?\s([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)/")


@dataclass
class DisplayInfo:
    """一块能单独抓屏的 Android 屏（模拟器里一个标签页一块）。"""

    id: int  # 逻辑 display id：界面上显示的"屏号"，也是 scrcpy 的 display_id
    name: str  # 屏名（mumuscreen003 / 内置屏幕）
    physical_id: int | None = None  # 物理 id：逻辑屏号重排后仍靠它认同一块屏
    size: Size | None = None
    top_app: str | None = None  # 这块屏最上层应用的包名（给用户认屏用）
    primary: bool = False

    @property
    def label(self) -> str:
        return f"屏{self.id}（{self.name}）" if self.name else f"屏{self.id}"


def parse_surfaceflinger_displays(output: str) -> list[tuple[int, str]]:
    """`dumpsys SurfaceFlinger --display-id` → [(物理 id, 屏名)]，顺序即屏幕顺序。"""
    return [(int(match.group(1)), match.group(2)) for match in _SF_DISPLAY_RE.finditer(output)]


def parse_display_infos(output: str) -> dict[int, tuple[int, str, Size]]:
    """`dumpsys display` → {物理 id: (逻辑 id, 屏名, 尺寸)}。

    用物理 id 做键：SurfaceFlinger 叫它 mumuscreen000，DisplayManager 叫它"内置屏幕"——
    名字对不上，只有 uniqueId 里的物理 id 是两边都有的。
    """
    found: dict[int, tuple[int, str, Size]] = {}
    for match in _DISPLAY_INFO_RE.finditer(output):
        name, logical, width, height, physical = match.groups()
        found[int(physical)] = (int(logical), name, (int(width), int(height)))
    return found


def parse_top_apps(output: str) -> dict[int, str]:
    """`dumpsys activity activities` → {逻辑 display id: 最上层应用包名}。"""
    tops: dict[int, str] = {}
    current: int | None = None
    for line in output.splitlines():
        head = _ACTIVITY_DISPLAY_RE.match(line)
        if head:
            current = int(head.group(1))
            continue
        if current is None or current in tops:
            continue
        top = _TOP_ACTIVITY_RE.search(line)
        if top:
            tops[current] = top.group(1)
    return tops


def merge_displays(surfaceflinger: str, display: str = "", activities: str = "") -> list[DisplayInfo]:
    """三份 dumpsys 拼出「有实际窗口、能单独连的屏」列表（纯函数）。

    SurfaceFlinger 会把 MuMu 预留的空屏槽也报出来；只有 activity 已落到该屏，
    才算一个打开的应用窗口。主屏即使没有前台应用也始终保留。
    非 MuMu 的外接屏没有这个预留槽行为，不用 activity 过滤。
    """
    infos = parse_display_infos(display)
    tops = parse_top_apps(activities)
    out: list[DisplayInfo] = []
    for index, (physical, name) in enumerate(parse_surfaceflinger_displays(surfaceflinger)):
        entry = infos.get(physical)
        logical = 0  # 第一块（port=0）永远是主屏
        logical_name = name
        size: Size | None = None
        if entry is not None:
            logical, logical_name, size = entry
        elif index != 0:
            # DisplayManager 没登记这块屏：没有逻辑 id 就没法在界面上选它，跳过
            continue
        if logical != 0 and (name or logical_name).lower().startswith("mumuscreen") and logical not in tops:
            # MuMu 预分配了 display，但空槽没有 Activity，也不会有 scrcpy 首帧。
            # 旧实现把每个槽位当成窗口，因此无论打开几个都固定返回三块黑屏。
            continue
        out.append(
            DisplayInfo(
                id=logical,
                name=name or logical_name,
                physical_id=physical,
                size=size,
                top_app=tops.get(logical),
                primary=logical == 0,
            )
        )
    # 按屏号排序（SurfaceFlinger 是按 port 报的，跟屏号不一定同序），主屏在最前
    out.sort(key=lambda item: item.id)
    return out


def _adb_binary() -> str:
    """adb 可执行文件：优先 adbutils 自带的那份，找不到再退回 PATH。"""
    try:
        import adbutils

        return str(adbutils.adb_path())
    except Exception:
        import shutil

        return shutil.which("adb") or "adb"


def _adb_shell(serial: str, *args: str) -> str | None:
    """跑一次 `adb -s <serial> shell …`；失败返回 None（调用方各自降级）。"""
    import subprocess

    command = [_adb_binary(), "-s", serial, "shell", *args]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as exc:
        logger.debug("adb shell %s 失败: %s", " ".join(args), exc)
        return None
    if result.returncode != 0:
        logger.debug("adb shell %s 退出码 %s: %s", " ".join(args), result.returncode, result.stderr.strip()[:200])
        return None
    return result.stdout


def list_displays(serial: str) -> list[DisplayInfo]:
    """列出一台设备能单独抓的屏。**不抛异常**：拿不到就当成"只有主屏"。"""
    surfaceflinger = _adb_shell(serial, "dumpsys", "SurfaceFlinger", "--display-id") or ""
    entries = parse_surfaceflinger_displays(surfaceflinger)
    if len(entries) <= 1:
        # 普通手机走到这就结束了（一次 adb 调用）；有多块屏才继续查（两次）
        return merge_displays(surfaceflinger)
    display_dump = _adb_shell(serial, "dumpsys", "display") or ""
    activity_dump = _adb_shell(serial, "dumpsys", "activity", "activities") or ""
    return merge_displays(surfaceflinger, display_dump, activity_dump)


def make_display_uri(serial: str, display: int, physical: int | None = None) -> str:
    """`display` 给 scrcpy 选当前逻辑屏，`physical` 给会话一个不会随标签页重排变化的身份。"""
    uri = f"Android:///?serial={serial}&display={display}"
    return f"{uri}&physical={physical}" if physical is not None else uri


def display_devices(serial: str, base: DeviceInfo, displays: list[DisplayInfo]) -> list[DeviceInfo]:
    """只把已打开的附屏展开成设备列表里的一行（主屏沿用原来那一行）。

    纯函数：单测直接构造 displays 喂进来，不需要真机。
    """
    extra: list[DeviceInfo] = []
    for display in displays:
        if display.primary or (display.name.lower().startswith("mumuscreen") and not display.top_app):
            # 防止其他调用方直接传入预留屏槽，绕过 merge_displays 的过滤。
            continue
        name = f"{base.name} · 屏{display.id}"
        if display.top_app:
            # 包名放前面：设备行是截断显示的，放后面会被截掉（这条是给用户认屏的主要线索）
            name = f"{name} · {display.top_app}"
        elif display.name:
            name = f"{name}（{display.name}）"
        extra.append(
            DeviceInfo(
                # MuMu 关闭/打开标签页会重新分配逻辑 id；物理 id 才是这块窗口的稳定身份。
                id=f"{base.id}:{display.physical_id if display.physical_id is not None else display.id}",
                uri=make_display_uri(serial, display.id, display.physical_id),
                name=name,
                kind=base.kind,
                status=base.status,
                serial=serial,
                model=base.model,
                product=base.product,
                resolution=display.size,
            )
        )
    return extra


# Windows 上的主流模拟器**不会**自动出现在 `adb devices` 里（只有 AVD 的 `emulator-5554` 会），
# 必须先 `adb connect 127.0.0.1:<端口>`。不做这步，MuMu / 雷电 / 夜神开着也"识别不到模拟器"。
_MUMU12_PORTS: tuple[int, ...] = tuple(16384 + 32 * index for index in range(8))  # MuMu 12 多开：16384 + 32n
_EMULATOR_ADB_PORTS: tuple[int, ...] = (
    *_MUMU12_PORTS,
    7555,  # MuMu 6 / MuMu 12 的兼容端口
    5555,  # 雷电 / BlueStacks / MuMu 的兼容端口
    62001,  # 夜神
    62025,
    21503,  # 逍遥
    21513,
)
# MuMu 12 会同时监听 16384 / 7555 / 5555 指向**同一台**模拟器：
# 只要 16384 系有一个开着，就不再去连这两个别名，否则同一台模拟器会在列表里出现三次。
_MUMU12_ALIAS_PORTS = frozenset({7555, 5555})


def _port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.15) -> bool:
    """本机端口是否在监听（回环探测，几乎不耗时）。"""
    import socket

    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def emulator_ports_to_connect(listed_serials: set[str], is_open: Any = _port_open) -> list[int]:
    """哪些模拟器端口需要补一次 `adb connect`（纯函数 + 可注入探测，便于单测）。

    - 端口没在监听 → 模拟器没开，跳过；
    - `127.0.0.1:<端口>` 或 `emulator-<端口-1>`（雷电/AVD 的自动注册名）已在 adb 列表里 → 已连，跳过；
    - MuMu 12 的别名端口（7555/5555）在 16384 系已开时跳过，避免同一台模拟器重复出现。
    """
    opened = [port for port in _EMULATOR_ADB_PORTS if is_open(port)]
    if any(port in _MUMU12_PORTS for port in opened):
        opened = [port for port in opened if port not in _MUMU12_ALIAS_PORTS]
    wanted: list[int] = []
    for port in opened:
        if f"127.0.0.1:{port}" in listed_serials or f"emulator-{port - 1}" in listed_serials:
            continue
        wanted.append(port)
    return wanted


def connect_local_emulators(client: Any, listed_serials: set[str], is_open: Any = None) -> bool:
    """给没出现在 adb 里的本机模拟器补 `adb connect`；返回是否新连上了至少一台。"""
    connected = False
    # `is_open` 的默认值要在调用时取 `_port_open`：写成默认参数会在 def 时就绑定，
    # 单测 monkeypatch 换探测函数就失效了。
    for port in emulator_ports_to_connect(listed_serials, is_open or _port_open):
        address = f"127.0.0.1:{port}"
        try:
            answer = str(client.connect(address, timeout=3))
        except Exception as exc:  # 连不上不是错误：端口可能只是被别的程序占着
            logger.debug("adb connect %s 失败: %s", address, exc)
            continue
        logger.info("adb connect %s → %s", address, answer)
        if answer.lower().startswith(("connected to", "already connected")):
            connected = True
    return connected


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
        # 本机模拟器（MuMu/雷电/夜神…）要先 adb connect 才会出现；补连后重新列一次
        if connect_local_emulators(client, {entry.serial for entry in entries}):
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

        extras: list[DeviceInfo] = []
        if include_resolution:
            info.resolution = _query_resolution(serial)
            # 多屏设备（模拟器把每个标签页放到一块独立屏上）：主屏以外的屏各列一行，
            # 点那一行就直接连到那块屏（见 devices/android.py 顶部「多屏」一节）
            extras = display_devices(serial, info, list_displays(serial))
        devices.append(info)
        devices.extend(extras)

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

    画面与控制都只走 scrcpy 的 H.264 视频通道：拿不到首帧、断流、控制 socket 断了
    一律报错让会话重连。没有 adb 截图、也没有 adb input 那套慢速降级。
    """

    scheme = "Android"
    description = "安卓真机/模拟器（adbutils）"

    def __init__(
        self,
        device_id: str = "",
        serial: str = "",
        display: int | str = 0,
        physical: int | str | None = None,
        **options: Any,
    ) -> None:
        super().__init__(device_id or make_device_id(serial), **options)
        self.serial = serial
        # 主屏不带 display；附屏用物理 id 定位同一窗口，逻辑 id 只供 scrcpy/Android input 使用。
        self.display = int(display) if display not in (None, "", 0, "0") else 0
        self.physical = int(physical) if physical not in (None, "", 0, "0") else None
        self._client_device: Any = None
        self._resolution: Size | None = None
        self._display_info: DisplayInfo | None = None
        self._scrcpy: Any = None
        self._video_error = ""  # 视频断掉的原因：screenshot 直接抛它，不假装还在抓图
        self.channel = "scrcpy"
        self.link_note = ""
        self._last_frame: Any = None
        self._frame_seq = 0  # scrcpy 解码帧号：画面没变时用来复用 JPEG 编码
        self._last_display_check = 0.0

    def connect(self) -> None:
        import adbutils

        self._client_device = adbutils.adb.device(serial=self.serial) if self.serial else adbutils.adb.device()
        state = self._client_device.get_state()
        if state != "device":
            raise RuntimeError(f"设备 {self.serial} 状态异常: {state}")
        self._resolution = None
        self._resolve_display()
        self._connected = True
        self._start_scrcpy()

    def _resolve_display(self) -> None:
        """把 URI 里的 `display` 解析成具体那块屏。**解析不到就报错**：

        模拟器的标签页关掉后屏号会被系统回收/重排，静默退回主屏会连到"别的屏"上，
        用户看到的是错的画面却不知道。
        """
        if not self.display and self.physical is None:
            # 多屏模拟器须指定 display，否则可能连到空附屏。
            # 设备列表仍然只给主屏 URI；连接时内部查出主屏的物理 id，scrcpy 明确选它。
            self._display_info = next((item for item in list_displays(str(self.serial)) if item.primary), None)
            return
        # 一旦找到过物理屏，就不要再按旧逻辑屏号猜：那个数字可能已被另一个窗口复用。
        physical = self.physical or (self._display_info.physical_id if self._display_info else None)
        for item in list_displays(str(self.serial)):
            if not item.primary and item.name.lower().startswith("mumuscreen") and not item.top_app:
                # 手输旧 URI / 扫描结果过期时也不能连预分配空槽。
                continue
            if (physical is not None and item.physical_id == physical) or (
                physical is None and (item.id == self.display or item.physical_id == self.display)
            ):
                self._display_info = item
                self.display = item.id
                logger.info("连接屏 %s（%s）", item.id, item.name)
                return
        raise RuntimeError(f"屏幕 {self.display} 没有已打开的应用窗口（或窗口已关闭）；请刷新列表后重新添加")

    def _display_suffix(self) -> str:
        """通道说明里带上屏号，状态栏一眼看出连的是哪块屏。"""
        if self._display_info is None:
            return ""
        if self._display_info.primary:
            return "（主屏）"
        return f"（屏 {self._display_info.id} {self._display_info.name}）"

    @property
    def resolution(self) -> Size:
        if self._scrcpy is not None and self._scrcpy.canvas_size != (0, 0):
            # scrcpy 生效时画面就是视频画布：坐标必须与画布一致
            return (int(self._scrcpy.canvas_size[0]), int(self._scrcpy.canvas_size[1]))
        if self._resolution is not None:
            # 还没建 scrcpy 时只能按系统报告的尺寸猜（可能没算旋转）。
            return self._resolution
        if self._display_info is not None and not self._display_info.primary and self._display_info.size is not None:
            # 非主屏不能问 `wm size`：它只回答主屏那块
            return self._display_info.size
        if not self._connected or self._client_device is None:
            raise RuntimeError("设备未连接")
        size = parse_wm_size(str(self._client_device.shell("wm size")))
        if size is None:
            raise RuntimeError(f"无法解析设备分辨率（serial={self.serial}）")
        self._resolution = size
        return size

    def screenshot(self) -> np.ndarray:
        """抓一帧（BGR）。只走 scrcpy 视频通道：拿不到画面就抛错，交给会话层重连。"""
        self._validate_scrcpy_target()
        if self._scrcpy is None:
            raise RuntimeError(self._video_error or "scrcpy 视频通道未启动")
        # 非阻塞拿当前帧：scrcpy 只在画面变化时才出帧，静止时等"新帧"会白等一秒
        frame: np.ndarray | None = self._scrcpy.latest_frame(timeout=0.0)
        if frame is None:
            frame = self._scrcpy.latest_frame(timeout=1.0)
        if frame is None:
            self._lose_video("流中断（未收到画面）")
        self._last_frame = frame
        self._frame_seq = int(getattr(self._scrcpy, "frame_id", 0))
        return frame

    def _validate_scrcpy_target(self, *, force: bool = False) -> None:
        """活的视频流也要核对物理屏：MuMu 重排逻辑 id 后，旧 server 可能继续推错屏。"""
        info = self._display_info
        if self._scrcpy is None:
            return
        if not self._scrcpy.alive:
            self._lose_video("流中断")
        if info is None or info.primary or info.physical_id is None:
            return
        now = time.monotonic()
        if not force and now - self._last_display_check < 3.0:
            return
        self._last_display_check = now
        dump = _adb_shell(str(self.serial), "dumpsys", "display")
        if not dump:
            return  # 本次枚举失败不能据此判定已关闭；下次核对继续尝试
        screens = parse_display_infos(dump)
        if not screens:
            return
        current = screens.get(info.physical_id)
        if current is None:
            self._lose_video("目标屏已关闭；请刷新窗口列表后重新添加")
        if current[0] != info.id:
            # 逻辑屏号变了就不能再读旧 display_id 上的帧：重连时按新 id 重建服务
            self._lose_video("屏号已变化，请刷新窗口列表后重新添加")

    def _start_scrcpy(self) -> None:
        """必须收到第一张解码帧才算连接成功：拿不到画面直接报错，不降级到 adb 截图。"""
        channel: Any = None
        try:
            from .scrcpy import ScrcpyChannel, find_server_jar

            jar = find_server_jar()
            if jar is None:
                raise RuntimeError("未找到 scrcpy-server.jar，无法投屏；请重新安装 GamePilot")
            channel = ScrcpyChannel(
                serial=str(self.serial),
                adb_path=self._adb_binary(),
                server_jar=jar,
                # 非主屏：只镜像这块屏，视频与触控都跟着走
                display_id=self._display_info.id if self._display_info is not None else None,
            )
            channel.start()
            first = channel.latest_frame(timeout=2.0)
            if first is None:
                raise RuntimeError("视频首帧未到")
            self._last_frame = first
            self._frame_seq = int(channel.frame_id)
            self._scrcpy = channel
            self._video_error = ""
            self.link_note = f"scrcpy {channel.video_size[0]}×{channel.video_size[1]}{self._display_suffix()}"
            logger.info("投屏通道: scrcpy %s", channel.video_size)
        except Exception as exc:
            if channel is not None:
                with contextlib.suppress(Exception):
                    channel.close()
            self._scrcpy = None
            self._video_error = f"scrcpy 投屏启动失败：{exc}"
            self.link_note = f"{self._video_error}{self._display_suffix()}"
            logger.warning(self.link_note)
            raise RuntimeError(self._video_error) from exc

    def _lose_video(self, reason: str) -> NoReturn:
        """视频通道没了就彻底断开：清掉通道并抛错，让会话报 failed 触发重连。

        以前这里会悄悄改成 ADB 截图继续跑，等于用 1.8fps 的画面冒充投屏；
        现在只有 scrcpy 这一条路，断了就明说，让界面重连。
        """
        channel = self._scrcpy
        self._scrcpy = None
        self._last_frame = None
        self._resolution = None
        if channel is not None:
            with contextlib.suppress(Exception):
                channel.close()
        if self._display_info is not None:
            with contextlib.suppress(RuntimeError):
                self._resolve_display()  # 标签页重排后，输入目标的逻辑 id 也要跟着更新
        self.channel = "scrcpy"
        self._video_error = f"scrcpy 视频{reason}，请重连设备{self._display_suffix()}"
        self.link_note = self._video_error
        logger.warning(self.link_note)
        raise RuntimeError(self._video_error)

    def _require_control(self) -> Any:
        """输入必须走 scrcpy 控制通道：没有通道直接报错，不再降级到 adb input。"""
        if self._scrcpy is None:
            raise RuntimeError(self._video_error or "scrcpy 视频通道未启动，请重连设备")
        return self._scrcpy

    def _lose_control(self, exc: BaseException) -> NoReturn:
        """控制 socket 断了就报错重连：不再拿 adb input 顶上（那会把延迟藏起来）。"""
        self._scrcpy = None
        self.channel = "scrcpy"
        self._video_error = f"scrcpy 控制通道断开（{exc}），请重连设备{self._display_suffix()}"
        self.link_note = self._video_error
        logger.warning(self.link_note)
        raise RuntimeError(self._video_error)

    @property
    def link_fps(self) -> float:
        return float(getattr(self._scrcpy, "fps", 0.0)) if self._scrcpy is not None else 0.0

    def to_dict(self) -> dict[str, Any]:
        data = super().to_dict()
        data.update({"channel": self.channel, "linkNote": self.link_note, "linkFps": round(self.link_fps, 1)})
        return data

    def close(self) -> None:
        if self._scrcpy is not None:
            try:
                self._scrcpy.close()
            except Exception:
                logger.debug("关闭 scrcpy 通道失败", exc_info=True)
            self._scrcpy = None
        super().close()

    def _adb_binary(self) -> str:
        cached = getattr(self, "_adb_path", None)
        if cached:
            return str(cached)
        import shutil

        try:
            import adbutils

            path = adbutils.adb_path()
        except Exception:
            path = shutil.which("adb") or "adb"
        self._adb_path = path
        return str(path)

    def _to_pixels(self, x: float, y: float) -> tuple[int, int]:
        width, height = self.resolution
        return round(x * width), round(y * height)

    def touch(self, phase: str, x: float, y: float) -> None:
        """实时触控事件（down/move/up）：只走 scrcpy 控制通道。"""
        if phase == "down":
            self._validate_scrcpy_target(force=True)
        channel = self._require_control()
        try:
            channel.touch(phase, x, y)
        except (BrokenPipeError, ConnectionError, OSError) as exc:
            self._lose_control(exc)

    def click(
        self,
        x: float,
        y: float,
        duration: float = 0.05,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        self._validate_scrcpy_target(force=True)
        channel = self._require_control()
        try:
            channel.click(x, y, duration=duration, path=path)
        except (BrokenPipeError, ConnectionError, OSError) as exc:
            self._lose_control(exc)

    def swipe(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        duration: float = 0.3,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        self._validate_scrcpy_target(force=True)
        channel = self._require_control()
        try:
            channel.swipe(x1, y1, x2, y2, duration=duration, path=path)
        except (BrokenPipeError, ConnectionError, OSError) as exc:
            self._lose_control(exc)

    # 常用按键（scrcpy 控制通道注入 keycode）
    KEYCODES: ClassVar[dict[str, int]] = {
        "back": 4,
        "home": 3,
        "recents": 187,
        "power": 26,
        "volume_up": 24,
        "volume_down": 25,
        "enter": 66,
        "delete": 67,
    }

    def press(self, name: str) -> None:
        """按一个功能键（back/home/recents/power/volume_up/volume_down/enter/delete）。"""
        keycode = self.KEYCODES.get(name) if name in SUPPORTED_KEYS else None
        if keycode is None:
            raise ValueError(f"不支持的按键: {name}（可用: {', '.join(sorted(SUPPORTED_KEYS))}）")
        self._validate_scrcpy_target(force=True)
        channel = self._require_control()
        try:
            channel.key(keycode)
        except (BrokenPipeError, ConnectionError, OSError) as exc:
            self._lose_control(exc)

    def key(self, name: str) -> None:
        self.press(name)

    def text(self, value: str) -> None:
        """输入一段文本：走 scrcpy 的 INJECT_TEXT，不调 adb。"""
        self._validate_scrcpy_target(force=True)
        channel = self._require_control()
        try:
            channel.text(value)
        except (BrokenPipeError, ConnectionError, OSError) as exc:
            self._lose_control(exc)

    def shell(self, command: str) -> str:
        if self._client_device is None:
            raise RuntimeError("设备未连接")
        output = self._client_device.shell(command)
        return output if isinstance(output, str) else str(output)
