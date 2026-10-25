"""scrcpy 投屏通道（客户端实现，协议对齐 scrcpy 3.3.4 的 server）。

adb screencap PNG 太慢；本模块走 H.264 视频流 + 控制 socket（对齐 scrcpy 3.3.4）。

协议要点（源码依据：scrcpy v3.3.4 server/DesktopConnection.java、device/Streamer.java、
app/src/control_msg.c）：

1. socket 名：`scrcpy`（scid=-1）或 `scrcpy_%08x`；`tunnel_forward=true` 时**服务端**建 LocalServerSocket，
   客户端按 **video → audio → control** 的顺序去 connect；
2. 服务端在第一个 socket 上先写 1 个 dummy 字节（`send_dummy_byte`）；
3. 视频 socket 上先发 64 字节设备名（`send_device_meta`），
   再发 12 字节视频头：codec id / width / height（`send_codec_meta`）；
4. 之后每包 12 字节帧头：8 字节 `pts|flags`（bit63=config、bit62=keyframe）+ 4 字节 size；
5. 控制 socket 上是定长二进制报文；触摸报文 32 字节：
   `type(1) action(1) pointerId(8) x(4) y(4) w(2) h(2) pressure(2) actionButton(4) buttons(4)`。
"""

from __future__ import annotations

import contextlib
import logging
import os
import random
import re
import socket
import struct
import subprocess
import threading
import time
from typing import Any

import numpy as np

from ..core.bezier_trajectory import play_swipe_path, play_tap, resolve_swipe_points
from .base import normalize_touch_point, validate_touch_identity, validate_touch_owner


def _env_int(name: str, default: int) -> int:
    """读整型环境变量（采集参数允许用户按机器/模拟器调）。"""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("环境变量 %s=%r 不是整数，忽略", name, raw)
        return default


def _env_float(name: str, default: float) -> float:
    """读正浮点环境变量（首帧超时这类时间参数允许按机器/模拟器调）。"""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning("环境变量 %s=%r 不是数字，忽略", name, raw)
        return default
    if value <= 0:
        logger.warning("环境变量 %s=%r 必须大于 0，忽略", name, raw)
        return default
    return value


logger = logging.getLogger("gamepilot.devices.scrcpy")

# 与 vendor/scrcpy-server 的版本严格对应（协议随版本变化）
SCRCPY_VERSION = "3.3.4"
SOCKET_NAME = "scrcpy"

# 设备上 scrcpy server 的 Java 主类：用来从 `ps` 输出里认出残留进程
SERVER_CLASS = "com.genymobile.scrcpy.Server"

# 引擎进程内「某台设备已经清过残留 server」的登记表。清理只能在本进程第一次连这台
# 设备时做：之后本进程自己的多屏 server 正在跑，再清就会误杀自己（见 ensure_device_clean）。
_CONTROL_INIT_GUARD = threading.Lock()
_CLEAN_GUARD = threading.Lock()
_CLEANED_SERIALS: set[str] = set()

# `adb forward --list` 的一行：<serial> tcp:<port> localabstract:scrcpy_<scid>
_FORWARD_RE = re.compile(r"^(?P<serial>\S+)\s+tcp:(?P<port>\d+)\s+localabstract:scrcpy_(?P<scid>[0-9a-fA-F]+)\s*$")

# 控制报文
MSG_INJECT_KEYCODE = 0
MSG_INJECT_TEXT = 1
MSG_INJECT_TOUCH = 2
ACTION_DOWN = 0
ACTION_UP = 1
POINTER_ID_MOUSE = 1  # 与参考实现一致（scrcpy 客户端里鼠标事件用固定 pointer id）
BUTTON_PRIMARY = 1  # AMOTION_EVENT_BUTTON_PRIMARY

PACKET_FLAG_CONFIG = 1 << 63
PACKET_FLAG_KEY_FRAME = 1 << 62


def find_server_jar() -> str | None:
    """按优先级找 scrcpy-server：环境变量 → 仓库 vendor → 系统安装的 scrcpy。"""
    import shutil

    from gamepilot.runtime_paths import vendor_scrcpy_server

    bundled = vendor_scrcpy_server()
    candidates = [os.environ.get("GAMEPILOT_SCRCPY_SERVER"), str(bundled) if bundled.is_file() else None]
    here = os.path.dirname(os.path.abspath(__file__))
    repo_engine = os.path.abspath(os.path.join(here, "..", "..", ".."))
    candidates.append(os.path.join(repo_engine, "vendor", "scrcpy-server"))
    for share in ("/opt/homebrew/share/scrcpy", "/usr/local/share/scrcpy", "/usr/share/scrcpy"):
        candidates.append(os.path.join(share, "scrcpy-server"))
    scrcpy_bin = shutil.which("scrcpy")
    if scrcpy_bin:
        bindir = os.path.dirname(os.path.abspath(scrcpy_bin))
        candidates.append(os.path.join(bindir, "scrcpy-server"))
        candidates.append(os.path.abspath(os.path.join(bindir, "..", "share", "scrcpy", "scrcpy-server")))
    for env_key in ("LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"):
        root = os.environ.get(env_key)
        if root:
            candidates.append(os.path.join(root, "scrcpy", "scrcpy-server"))
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def _adb_quiet(adb_path: str, serial: str, *args: str, timeout: float = 8.0) -> subprocess.CompletedProcess[str] | None:
    """跑一条清理用的 adb 命令：失败只记 debug，绝不把清理异常抛给连接流程。"""
    command = [adb_path]
    if serial:
        command += ["-s", str(serial)]
    command += [str(arg) for arg in args]
    try:
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        logger.debug("adb %s 执行失败（清理残留进程时忽略）", " ".join(args[:2]), exc_info=True)
        return None


def _server_pids_from_ps(output: str, marker: str = "") -> list[int]:
    """从 `ps -A -o PID,ARGS` 输出里挑出真正的 scrcpy server 进程。

    `adb shell "<命令>"` 在设备上会多出一层 `sh -c <命令>` 包装进程，它的命令行
    同样带着 `com.genymobile.scrcpy.Server` / `scid=…`；只杀包装壳会把 server
    变成孤儿继续占着，所以这里把 `sh -c` 那行排除掉。
    """
    pids: list[int] = []
    for line in output.splitlines():
        line = line.strip()
        if SERVER_CLASS not in line:
            continue
        if marker and marker not in line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        args = parts[1].strip()
        if args.startswith("sh "):
            continue
        pids.append(int(parts[0]))
    return pids


def clean_stale_servers(serial: str, adb_path: str) -> int:
    """清掉设备上残留的 scrcpy server 和它们留下的 adb forward，返回杀掉的进程数。

    为什么要清：引擎被强杀 / 崩溃时，远端 `app_process` 的 scrcpy server 不一定
    跟着退出（编码器卡在 dequeue 时会一直挂着）。这些残留 server 占着编码器，
    新 server 的首帧就会从 ~0.2s 退化到数秒，最后表现成「视频首帧未到」反复失败，
    而每次失败如果没清干净又会再加一个 —— 只能主动清理来打破这个循环。
    """
    killed = 0
    listing = _adb_quiet(adb_path, serial, "shell", "ps", "-A", "-o", "PID,ARGS")
    if listing is not None and listing.returncode == 0:
        for pid in _server_pids_from_ps(listing.stdout):
            result = _adb_quiet(adb_path, serial, "shell", "kill", "-9", str(pid))
            if result is not None and result.returncode == 0:
                killed += 1
    # server 杀掉后 forward 也要收：否则这些端口会一直留在 adb server 里越积越多
    forwards = _adb_quiet(adb_path, serial, "forward", "--list")
    if forwards is not None and forwards.returncode == 0:
        for line in forwards.stdout.splitlines():
            match = _FORWARD_RE.match(line.strip())
            if match is not None and match.group("serial") == serial:
                _adb_quiet(adb_path, serial, "forward", "--remove", f"tcp:{match.group('port')}")
    return killed


def ensure_device_clean(serial: str, adb_path: str) -> None:
    """本进程第一次连某台设备时清一次残留 server（多屏幕会话之间不能互相误杀）。

    清理只能发生在本进程还没为这台设备起过 server 的时候；一旦登记过，后面的
    每块屏都直接跳过 —— 否则第二个屏连进来会把第一个屏正在用的 server 杀掉。
    """
    with _CLEAN_GUARD:
        if serial in _CLEANED_SERIALS:
            return
        _CLEANED_SERIALS.add(serial)
        try:
            killed = clean_stale_servers(serial, adb_path)
        except Exception:  # 清理是尽力而为：清不掉也不能挡住连接
            logger.debug("清理 %s 上的残留 scrcpy 进程失败", serial, exc_info=True)
            return
    if killed:
        logger.info("清理 %s 上残留的 scrcpy server %d 个", serial, killed)


class ScrcpyChannel:
    """一个设备的 scrcpy 视频 + 控制通道。"""

    def __init__(
        self,
        serial: str,
        adb_path: str,
        server_jar: str,
        *,
        max_size: int = 1920,
        max_fps: int = 30,
        bit_rate: int = 20_000_000,
        connect_timeout: float = 8.0,
        display_id: int | None = None,
    ) -> None:
        self.serial = serial
        self.adb_path = adb_path
        self.server_jar = server_jar
        # 默认按 1080p / 16Mbps 采：1280×8Mbps 下游戏小图标和文字会糊，
        # AI 识别/模板匹配都会跟着掉准；环境变量可覆盖（0 = 不限制，原生分辨率）
        self.max_size = _env_int("GAMEPILOT_SCRCPY_MAX_SIZE", max_size)
        self.max_fps = _env_int("GAMEPILOT_SCRCPY_MAX_FPS", max_fps)
        self.bit_rate = _env_int("GAMEPILOT_SCRCPY_BITRATE", bit_rate)
        self.connect_timeout = connect_timeout
        # 首帧等待上限（握手完成后等第一张解码帧）：MuMu 在编码器忙/刚被残留 server
        # 占过时，首个关键帧要 1~6s，原来固定 2s 会误判失败。环境变量可调。
        self.first_frame_timeout = _env_float("GAMEPILOT_SCRCPY_FIRST_FRAME_TIMEOUT", 5.0)
        # 多屏设备的模拟器（MuMu 这类）会把每个标签页放到一块独立的虚拟屏上：
        # `display_id` = 只镜像那一块屏（视频与输入事件都跟着走）。None = 默认屏。
        self.display_id = display_id

        self.video_size: tuple[int, int] = (0, 0)
        self.fps = 0.0
        self.frames_decoded = 0
        self._frame: np.ndarray | None = None
        self._frame_id = 0
        self._frame_lock = threading.Lock()
        self._frame_event = threading.Event()
        self._control: socket.socket | None = None
        self._control_lock = threading.RLock()
        self._control_error: str | None = None
        self._control_closed = False
        self._active_touches: dict[int, tuple[str, float, float]] = {}
        self._legacy_touch: tuple[int, int] | None = None
        self._video: socket.socket | None = None
        self._server: subprocess.Popen[str] | None = None
        self._decoder_thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._port = 0
        self._codec: Any = None
        self.error: str | None = None
        # 每次会话用随机 scid（socket 名 scrcpy_%08x）：屏幕上残留的旧 server 或别的会话
        # 不会误接到我们的连接上（第一次实现用固定 scid 就是这么卡住的）
        self.scid = random.randint(1, 0x7FFFFFFF)
        self.socket_name = f"{SOCKET_NAME}_{self.scid:08x}"
        self._server_log_lines: list[str] = []

    def start(self) -> None:
        import av  # 延迟导入：没有 PyAV 时由调用方回退到 adb 截图

        # 上一轮引擎异常退出会在设备上留下 server；它们占着编码器，首帧会越来越慢
        # （见 clean_stale_servers 的说明）。本进程第一次连这台设备时才清，多屏互不误杀。
        ensure_device_clean(self.serial, self.adb_path)
        self._port = _free_port()
        self._push_server()
        self._adb("forward", f"tcp:{self._port}", f"localabstract:{self.socket_name}")
        self._spawn_server()

        deadline = time.time() + self.connect_timeout
        last_error: Exception | None = None
        while time.time() < deadline:
            video: socket.socket | None = None
            try:
                video = _connect(self._port)
                video.settimeout(2.0)
                # dummy 字节：只有服务端真的在监听才读得到。
                # 不能只看 TCP 连接成功——adb forward 会先接住 TCP，设备端 abstract socket
                # 还没建好时它立刻关连接（表现就是这里的 EOF）
                _read_exactly(video, 1)
                self._video = video
                break
            except (OSError, EOFError) as exc:
                last_error = exc
                if video is not None:
                    video.close()
                time.sleep(0.25)
        if self._video is None:
            raise RuntimeError(f"连不上 scrcpy 视频 socket: {last_error} | server: {self.server_log()[:300]}")

        # control socket 必须在读视频元数据**之前**连上：
        # 服务端 open() 会按 video → audio → control 的顺序 accept，audio 关掉时它也阻塞在
        # control 的 accept 上，连不上它就一直不发设备名（这就是第一次握手卡住的原因）
        control = _connect(self._port)
        control.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        control.settimeout(1.0)  # 关闭/故障清理不能永久卡在 sendall。
        self._control = control

        # 64 字节设备名
        _read_exactly(self._video, 64)
        # 12 字节视频头：codec id + width + height
        header = _read_exactly(self._video, 12)
        codec_id, width, height = struct.unpack(">III", header)
        if codec_id == 0:
            raise RuntimeError("服务端拒绝了视频流（可能是采集被占用）")
        self.video_size = (width, height)
        logger.info("scrcpy 视频就绪: codec=%s %sx%s", hex(codec_id), width, height)

        self._video.settimeout(None)  # 握手完毕：解码线程要长时间阻塞读
        self._codec = av.CodecContext.create("h264", "r")
        self._decoder_thread = threading.Thread(target=self._decode_loop, name=f"scrcpy-{self.serial}", daemon=True)
        self._decoder_thread.start()

    def close(self) -> None:
        with self._control_guard():
            try:
                self.release_touches()
            except (OSError, RuntimeError):
                logger.debug("关闭时释放触点失败", exc_info=True)
            finally:
                self._active_touches.clear()
                self._legacy_touch = None
                self._control_closed = True
        self._stop.set()
        for sock in (self._video, self._control):
            if sock is not None:
                with contextlib.suppress(OSError):
                    sock.close()
        if self._decoder_thread is not None:
            self._decoder_thread.join(timeout=2)
        if self._server is not None and self._server.poll() is None:
            self._server.kill()
        if self._server is not None:
            with contextlib.suppress(subprocess.TimeoutExpired):
                self._server.wait(timeout=2)
        self._kill_remote_server()
        if self._port:
            try:
                self._adb("forward", "--remove", f"tcp:{self._port}")
            except Exception:  # 清理失败不影响退出
                logger.debug("清理 adb forward 失败", exc_info=True)
        if getattr(self, "_remote_jar", None):
            with contextlib.suppress(Exception):
                self._adb("shell", "rm", "-f", self._remote_jar)

    def _kill_remote_server(self) -> None:
        """按 scid 杀掉设备端的 server 进程（不能只依赖杀本地 adb 客户端）。

        编码器卡在 dequeue 时，server 收不到 socket 关闭事件，会一直挂在设备上；
        每失败一次留一个，后面新 server 的编码器初始化越来越慢，最后全是首帧超时。
        按 scid 精确匹配，只杀自己的那个，不会碰到同进程其它屏的 server。
        匹配到的是包装它的 `sh -c` 也要一起处理：包装壳是 server 的父进程，
        单杀壳会留下孤儿。
        """
        marker = f"scid={self.scid:08x}"
        listing = _adb_quiet(self.adb_path, self.serial, "shell", "ps", "-A", "-o", "PID,ARGS", timeout=5.0)
        if listing is None or listing.returncode != 0:
            return
        # 同时杀 `sh -c` 包装壳和 app_process：只杀壳会留下孤儿 server
        for line in listing.stdout.splitlines():
            if SERVER_CLASS not in line or marker not in line:
                continue
            pid = line.split(None, 1)[0]
            if pid.isdigit():
                _adb_quiet(self.adb_path, self.serial, "shell", "kill", "-9", pid, timeout=5.0)

    def latest_frame(self, timeout: float = 1.0) -> np.ndarray | None:
        """取最新解码帧；timeout 内没有新帧则返回 None。"""
        if self._frame_event.wait(timeout):
            self._frame_event.clear()
        with self._frame_lock:
            return None if self._frame is None else self._frame.copy()

    @property
    def frame_id(self) -> int:
        return self._frame_id

    @property
    def alive(self) -> bool:
        """视频流是否还活着。解码线程退出后为 False —— 此时画面会冻结在最后一帧。"""
        return not self._stop.is_set()

    @property
    def canvas_size(self) -> tuple[int, int]:
        return self.video_size

    def _control_guard(self) -> Any:
        # 兼容历史单测用 __new__ 构造的最小控制通道；真正连接在 __init__ 初始化。
        with _CONTROL_INIT_GUARD:
            if not hasattr(self, "_control_lock"):
                self._control_lock = threading.RLock()
                self._control_error = None
                self._control_closed = False
                self._active_touches = {}
                self._legacy_touch = None
        return self._control_lock

    @property
    def max_touch_points(self) -> int:
        with self._control_guard():
            return 10 if self._control is not None and not self._control_closed and self._control_error is None else 0

    def _send_control(self, payload: bytes) -> None:
        with self._control_guard():
            if self._control_error is not None:
                raise ConnectionError(self._control_error)
            if self._control_closed or self._control is None:
                raise RuntimeError("控制通道未就绪")
            try:
                self._control.sendall(payload)
            except OSError as exc:
                # sendall 可能已写了半个报文；此连接不能再发清理包或后续输入。
                self._control_error = f"scrcpy 控制通道断开：{exc}"
                self._active_touches.clear()
                self._legacy_touch = None
                raise

    def _finger_packet(self, action: int, pointer_id: int, x: float, y: float) -> bytes:
        width, height = self.video_size
        if width <= 0 or height <= 0:
            raise RuntimeError("视频尺寸未就绪")
        return struct.pack(
            ">BBQIIHHHII",
            MSG_INJECT_TOUCH,
            action,
            16 + pointer_id,
            round(x * (width - 1)),
            round(y * (height - 1)),
            width,
            height,
            0 if action == ACTION_UP else 65535,
            0,
            0,
        )

    def touch_down(self, x: float, y: float, *, pointer_id: int, owner: str) -> None:
        validate_touch_identity(pointer_id, owner)
        x, y = normalize_touch_point(x, y)
        with self._control_guard():
            previous = self._active_touches.get(pointer_id)
            if previous is not None:
                if previous[0] != owner:
                    raise ValueError(f"触点 {pointer_id} 已被其它 owner 占用")
                raise ValueError(f"触点 {pointer_id} 已按下")
            if len(self._active_touches) + int(self._legacy_touch is not None) >= 10:
                raise ValueError("设备最多同时支持 10 个触点")
            self._send_control(self._finger_packet(ACTION_DOWN, pointer_id, x, y))
            self._active_touches[pointer_id] = (owner, x, y)

    def touch_move(self, x: float, y: float, *, pointer_id: int, owner: str) -> None:
        validate_touch_identity(pointer_id, owner)
        x, y = normalize_touch_point(x, y)
        with self._control_guard():
            previous = self._active_touches.get(pointer_id)
            if previous is None:
                raise ValueError(f"触点 {pointer_id} 尚未按下")
            if previous[0] != owner:
                raise ValueError(f"触点 {pointer_id} 已被其它 owner 占用")
            self._send_control(self._finger_packet(ACTION_MOVE, pointer_id, x, y))
            self._active_touches[pointer_id] = (owner, x, y)

    def touch_up(self, *, pointer_id: int, owner: str) -> None:
        validate_touch_identity(pointer_id, owner)
        with self._control_guard():
            previous = self._active_touches.get(pointer_id)
            if previous is None:
                return  # finally / 重复 stop 的迟到抬手幂等。
            if previous[0] != owner:
                raise ValueError(f"触点 {pointer_id} 已被其它 owner 占用")
            self._send_control(self._finger_packet(ACTION_UP, pointer_id, previous[1], previous[2]))
            del self._active_touches[pointer_id]

    def release_touches(self, *, owner: str | None = None) -> None:
        if owner is not None:
            validate_touch_owner(owner)
        with self._control_guard():
            for pointer_id, (held_by, _x, _y) in reversed(list(self._active_touches.items())):
                if owner is None or held_by == owner:
                    self.touch_up(pointer_id=pointer_id, owner=held_by)
            if owner is None and self._legacy_touch is not None:
                self._send_touch(ACTION_UP, *self._legacy_touch)

    def touch(self, phase: str, x_norm: float, y_norm: float) -> None:
        """实时触控：一次只发一个事件（down / move / up）。

        这是"实时滑动"的关键 —— 拖动过程中每次 move 都单独发一个 32 字节报文，
        而不是等松手后合成一条滑动（合成滑动看起来是"延迟一下就跳过去"）。
        """
        if self._control is None:
            raise RuntimeError("控制通道未就绪")
        action = {"down": ACTION_DOWN, "move": ACTION_MOVE, "up": ACTION_UP}.get(phase)
        if action is None:
            raise ValueError(f"phase 必须是 down/move/up，收到: {phase}")
        width, height = self.video_size
        x = round(min(max(x_norm, 0.0), 1.0) * (width - 1))
        y = round(min(max(y_norm, 0.0), 1.0) * (height - 1))
        self._send_touch(action, x, y)

    def click(
        self,
        x_norm: float,
        y_norm: float,
        duration: float = 0.05,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        """归一化坐标点击：HID 式 down / 微移 / up，不是 adb tap。"""
        play_tap(self.touch, (x_norm, y_norm), duration, path)

    def key(self, keycode: int) -> None:
        """注入一个按键（返回 / Home / 任务 / 电源 …）。"""
        if self._control is None:
            raise RuntimeError("控制通道未就绪")
        for action in (ACTION_DOWN, ACTION_UP):
            payload = struct.pack(">BBIII", MSG_INJECT_KEYCODE, action, keycode, 0, 0)
            assert len(payload) == 14, len(payload)
            self._send_control(payload)

    def text(self, value: str) -> None:
        """注入一段文本（INJECT_TEXT：u32 长度 + UTF-8 字节）。"""
        if self._control is None:
            raise RuntimeError("控制通道未就绪")
        raw = value.encode("utf-8")
        self._send_control(struct.pack(">BI", MSG_INJECT_TEXT, len(raw)) + raw)

    def swipe(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        duration: float = 0.3,
        steps: int = 12,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        if self._control is None:
            raise RuntimeError("控制通道未就绪")
        if path:
            play_swipe_path(self.touch, resolve_swipe_points((x1, y1), (x2, y2), duration, path), duration)
            return
        width, height = self.video_size
        start = (int(x1 * (width - 1)), int(y1 * (height - 1)))
        end = (int(x2 * (width - 1)), int(y2 * (height - 1)))
        self._send_touch(ACTION_DOWN, *start)
        for index in range(1, steps + 1):
            ratio = index / steps
            self._send_touch(
                ACTION_MOVE,
                int(start[0] + (end[0] - start[0]) * ratio),
                int(start[1] + (end[1] - start[1]) * ratio),
            )
            time.sleep(max(0.0, duration / steps))
        self._send_touch(ACTION_UP, *end)

    def _send_touch(self, action: int, x: int, y: int) -> None:
        width, height = self.video_size
        # 参数对齐参考实现 panda-agent/devices/android/control/touch_controller.py：
        # pointer_id=1、pressure=1、action_button/buttons=PRIMARY。
        # 之前用"手指式"（pointer_id=-1、buttons=0）时，桌面拖动只跟手一点点然后回弹，
        # 位移过小会被系统当成无效拖动。
        payload = struct.pack(
            ">BBQIIHHHII",  # type,action,pointerId,x,y,w,h,pressure,actionButton,buttons = 32B
            MSG_INJECT_TOUCH,
            action,
            POINTER_ID_MOUSE,
            x,
            y,
            width,
            height,
            1,  # pressure
            BUTTON_PRIMARY,  # action button: AMOTION_EVENT_BUTTON_PRIMARY
            BUTTON_PRIMARY,  # buttons: 按住主键 = 拖动
        )
        assert len(payload) == 32, len(payload)
        with self._control_guard():
            if action == ACTION_DOWN and self._legacy_touch is None and len(self._active_touches) >= 10:
                raise ValueError("设备最多同时支持 10 个触点")
            self._send_control(payload)
            self._legacy_touch = None if action == ACTION_UP else (x, y)

    def _decode_loop(self) -> None:
        assert self._video is not None
        started = time.time()
        frames_window = 0
        try:
            while not self._stop.is_set():
                header = self._read_maybe(12)
                if header is None:
                    break
                pts_and_flags, size = struct.unpack(">QI", header)
                if size <= 0:
                    continue
                payload = self._read_maybe(size)
                if payload is None:
                    break
                config = bool(pts_and_flags & PACKET_FLAG_CONFIG)
                try:
                    for packet in self._codec.parse(payload):
                        for frame in self._codec.decode(packet):
                            image = frame.to_ndarray(format="bgr24")
                            # 手机旋转后画布会变成横的：触摸报文里的屏幕尺寸必须跟着变，
                            # 否则按旧的竖屏尺寸缩放 → 点击位置整体偏移（横屏点不准就是这个原因）
                            size = (int(image.shape[1]), int(image.shape[0]))
                            if size != self.video_size:
                                logger.info("视频尺寸变化（旋转）: %sx%s → %sx%s", *self.video_size, *size)
                                self.video_size = size
                            with self._frame_lock:
                                self._frame = image
                                self._frame_id += 1
                            self._frame_event.set()
                            self.frames_decoded += 1
                            frames_window += 1
                except Exception as exc:  # 单包解不出来不该中断整条流（PyAV 18 起没有 av.AVError）
                    logger.debug("解码失败（config=%s, %sB）: %s", config, size, exc)
                elapsed = time.time() - started
                if elapsed >= 2.0:
                    self.fps = frames_window / elapsed
                    frames_window = 0
                    started = time.time()
        except Exception as exc:  # pragma: no cover - 流断了就记录原因
            self.error = f"{type(exc).__name__}: {exc}"
            logger.warning("scrcpy 解码线程退出: %s", self.error)
        finally:
            self._stop.set()
            if self.error is None:
                self.error = f"视频流结束（已解码 {self.frames_decoded} 帧，{self.fps:.1f}fps）"
            logger.warning("scrcpy 视频流结束: %s | server: %s", self.error, self.server_log()[-300:])

    def _read_maybe(self, size: int) -> bytes | None:
        assert self._video is not None
        try:
            return _read_exactly(self._video, size)
        except (OSError, EOFError):
            return None

    def _push_server(self) -> None:
        # 每条并行服务独占 jar 路径，防止两次 adb push 同时改写同一个文件。
        remote = f"/data/local/tmp/gamepilot-scrcpy-{self.scid:08x}.jar"
        self._adb("push", self.server_jar, remote)
        self._remote_jar = remote

    def _spawn_server(self) -> None:
        args = [
            "shell",
            f"CLASSPATH={self._remote_jar}",
            "app_process",
            "/",
            "com.genymobile.scrcpy.Server",
            SCRCPY_VERSION,
            f"scid={self.scid:08x}",  # 服务端按 16 进制解析 scid（十进制会溢出报 Invalid int）
            "tunnel_forward=true",
            "audio=false",
            "control=true",
            "video=true",
            "video_codec=h264",
            # 0/负数表示不限制：直接不传，避免某些模拟器编码器不接受 0 或过高码率
            *([f"max_size={self.max_size}"] if self.max_size > 0 else []),
            *([f"max_fps={self.max_fps}"] if self.max_fps > 0 else []),
            *([f"video_bit_rate={self.bit_rate}"] if self.bit_rate > 0 else []),
            "send_device_meta=true",
            "send_frame_meta=true",
            "send_dummy_byte=true",
            "send_codec_meta=true",
            "cleanup=false",
            "log_level=info",
        ]
        if self.display_id is not None:
            # 服务端选项名就是 display_id（scrcpy 3.x），客户端 --display-id 映射到它
            args.append(f"display_id={self.display_id}")
        logger.debug("启动 scrcpy server: %s", " ".join(args))
        self._server = subprocess.Popen(
            [self.adb_path, "-s", str(self.serial), *args],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        # 必须持续读走 stderr：管道写满会让 server 阻塞，表现就是"投屏莫名其妙卡死"
        if self._server.stderr is not None:
            threading.Thread(target=self._drain_server_log, args=(self._server.stderr,), daemon=True).start()

    def _adb(self, *args: str) -> subprocess.CompletedProcess[str]:
        command = [self.adb_path]
        if self.serial:
            command += ["-s", str(self.serial)]
        command += list(args)
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"adb {' '.join(args[:2])} 失败：{result.stderr.strip()[:250] or result.stdout.strip()[:250]}"
            )
        return result

    def _drain_server_log(self, stream: Any) -> None:
        try:
            for line in stream:
                self._server_log_lines.append(line.rstrip())
                del self._server_log_lines[:-200]  # 只留最后 200 行
        except Exception:
            pass

    def server_log(self) -> str:
        """服务端 stderr（排查启动失败用）。"""
        return "\n".join(self._server_log_lines[-40:])


ACTION_MOVE = 2


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _connect(port: int) -> socket.socket:
    sock = socket.create_connection(("127.0.0.1", port), timeout=5)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    return sock


def _read_exactly(sock: socket.socket, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = sock.recv(size - len(chunks))
        if not chunk:
            raise EOFError("scrcpy 流已关闭")
        chunks.extend(chunk)
    return bytes(chunks)
