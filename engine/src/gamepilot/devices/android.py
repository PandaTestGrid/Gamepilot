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

import cv2
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

    def __init__(self, device_id: str = "", serial: str = "", **options: Any) -> None:
        prefer_scrcpy = bool(options.pop("prefer_scrcpy", True))
        super().__init__(device_id or make_device_id(serial), **options)
        self.serial = serial
        self.prefer_scrcpy = prefer_scrcpy
        self._client_device: Any = None
        self._resolution: Size | None = None
        # scrcpy 视频通道（H.264，~28fps）；为 None 时回退 adb 截图（~1.8fps）
        self._scrcpy: Any = None
        self.channel = "screencap"
        self.link_note = ""
        self._last_frame: Any = None
        self._frame_seq = 0  # scrcpy 解码帧号：画面没变时用来复用 JPEG 编码

    def connect(self) -> None:
        import adbutils

        self._client_device = adbutils.adb.device(serial=self.serial) if self.serial else adbutils.adb.device()
        state = self._client_device.get_state()
        if state != "device":
            raise RuntimeError(f"设备 {self.serial} 状态异常: {state}")
        self._resolution = None
        self._connected = True
        self._start_scrcpy()

    @property
    def resolution(self) -> Size:
        if self._scrcpy is not None and self._scrcpy.canvas_size != (0, 0):
            # scrcpy 生效时画面就是视频画布：坐标必须与画布一致
            return (int(self._scrcpy.canvas_size[0]), int(self._scrcpy.canvas_size[1]))
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
        """抓一帧（BGR）。

        直接走 `adb exec-out screencap -p`（不经过 adbutils 的截图封装）：
        实测 OPPO A57 / USB 2.0 上 PNG 通道 0.55s/帧，而 adbutils 那条路径会先失败
        再回退，要 1.7s。原始二进制 screencap（3.6MB/帧）在这个设备上更慢（1.7s），
        所以 PNG 是当前最优解。

        第 3 块换 scrcpy 通道（H.264 硬解 + 精确触控），目标 30~60ms。
        """
        if self._scrcpy is not None:
            # _scrcpy / _last_frame 都是 Any（可选依赖），这里显式收窄回 ndarray
            # 非阻塞拿当前帧：scrcpy 只在画面变化时才出帧，静止时等"新帧"会白等一秒
            frame: np.ndarray | None = self._scrcpy.latest_frame(timeout=0.0)
            if frame is None:
                frame = self._scrcpy.latest_frame(timeout=1.0)  # 还没有任何帧时才等首帧
            if frame is not None:
                self._last_frame = frame
                self._frame_seq = int(getattr(self._scrcpy, "frame_id", 0))
                return frame
            cached: np.ndarray | None = self._last_frame
            if cached is not None:
                return cached
            raise RuntimeError("scrcpy 通道暂时没有画面")

        raw = self._exec_out_png()
        if raw:
            image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is not None:
                return image
        if self._client_device is None:
            raise RuntimeError("设备未连接")
        pil_image = self._client_device.screenshot()
        return np.asarray(pil_image.convert("RGB"))[:, :, ::-1].copy()

    # ------------------------------------------------------------------ #
    # scrcpy 投屏通道
    # ------------------------------------------------------------------ #

    def _start_scrcpy(self) -> None:
        """建立 scrcpy 通道；失败就回退 adb 截图并把原因记下来（不抛异常）。"""
        if not self.prefer_scrcpy:
            return
        try:
            from .scrcpy import ScrcpyChannel, find_server_jar

            jar = find_server_jar()
            if jar is None:
                self.link_note = "未找到 scrcpy-server，回退 adb 截图（约 1.8fps）"
                logger.warning(self.link_note)
                return
            channel = ScrcpyChannel(serial=str(self.serial), adb_path=self._adb_binary(), server_jar=jar)
            channel.start()
            self._scrcpy = channel
            self.channel = "scrcpy"
            self.link_note = f"scrcpy {channel.video_size[0]}×{channel.video_size[1]}"
            logger.info("投屏通道: scrcpy %s", channel.video_size)
        except Exception as exc:
            self._scrcpy = None
            self.channel = "screencap"
            self.link_note = f"scrcpy 不可用（{type(exc).__name__}: {exc}），回退 adb 截图"
            logger.warning(self.link_note)

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

    def _exec_out_png(self) -> bytes | None:
        """一次 exec-out 抓帧；失败返回 None 由调用方回退。"""
        import subprocess

        command = [self._adb_binary()]
        if self.serial:
            command += ["-s", str(self.serial)]  # argv 只能是字符串，别让 int 混进来
        command += ["exec-out", "screencap", "-p"]
        try:
            # stdin 必须是 DEVNULL：引擎的 stdin 是 JSON-RPC 协议管道，
            # 一旦被子进程继承，adb 会去转发它（变慢，且有污染协议流的风险）
            result = subprocess.run(command, capture_output=True, timeout=15, check=False, stdin=subprocess.DEVNULL)
        except Exception as exc:
            # 必须留痕：静默回退到 adbutils 会慢 3 倍，就是这条把问题藏了整整一轮排查
            logger.warning("exec-out screencap 失败，回退到 adbutils（会慢很多）: %s", exc)
            return None
        if result.returncode != 0 or not result.stdout:
            return None
        return result.stdout

    def _to_pixels(self, x: float, y: float) -> tuple[int, int]:
        width, height = self.resolution
        return round(x * width), round(y * height)

    def click(self, x: float, y: float) -> None:
        if self._scrcpy is not None:
            self._scrcpy.click(x, y)  # 毫秒级，不用 fork adb 进程
            return
        if self._client_device is None:
            raise RuntimeError("设备未连接")
        self._client_device.click(*self._to_pixels(x, y))

    def swipe(self, x1: float, y1: float, x2: float, y2: float, duration: float = 0.3) -> None:
        if self._scrcpy is not None:
            self._scrcpy.swipe(x1, y1, x2, y2, duration=duration)
            return
        if self._client_device is None:
            raise RuntimeError("设备未连接")
        px1, py1 = self._to_pixels(x1, y1)
        px2, py2 = self._to_pixels(x2, y2)
        self._client_device.swipe(px1, py1, px2, py2, duration=max(0.05, duration))

    def key(self, name: str) -> None:
        if self._client_device is None:
            raise RuntimeError("设备未连接")
        self._client_device.keyevent(name)

    def text(self, value: str) -> None:
        if self._client_device is None:
            raise RuntimeError("设备未连接")
        self._client_device.send_keys(value)

    def shell(self, command: str) -> str:
        if self._client_device is None:
            raise RuntimeError("设备未连接")
        output = self._client_device.shell(command)
        return output if isinstance(output, str) else str(output)
