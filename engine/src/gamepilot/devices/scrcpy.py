"""scrcpy 投屏通道（客户端实现，协议对齐 scrcpy 3.3.4 的 server）。

为什么要自己实现协议：adb `screencap` 每帧要 PNG 编解码 + USB 传输，实测 550ms/帧（1.8fps），
而 scrcpy 走 H.264 视频流 + 控制 socket，同样一台 OPPO A57 上能到 30fps 量级，
点击也从 `adb shell input tap`（~1s，每次 fork 一个进程）降到毫秒级。

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
import socket
import struct
import subprocess
import threading
import time
from typing import Any

import numpy as np

logger = logging.getLogger("gamepilot.devices.scrcpy")

# 与 vendor/scrcpy-server 的版本严格对应（协议随版本变化）
SCRCPY_VERSION = "3.3.4"
SOCKET_NAME = "scrcpy"

# 控制报文
MSG_INJECT_KEYCODE = 0
MSG_INJECT_TOUCH = 2
ACTION_DOWN = 0
ACTION_UP = 1
POINTER_ID_FINGER = 0xFFFFFFFFFFFFFFFF  # scrcpy 的 GENERIC_FINGER

PACKET_FLAG_CONFIG = 1 << 63
PACKET_FLAG_KEY_FRAME = 1 << 62


def find_server_jar() -> str | None:
    """按优先级找 scrcpy-server：环境变量 → 仓库 vendor → 系统安装的 scrcpy。"""
    candidates = [os.environ.get("GAMEPILOT_SCRCPY_SERVER")]
    here = os.path.dirname(os.path.abspath(__file__))
    repo_engine = os.path.abspath(os.path.join(here, "..", "..", ".."))
    candidates.append(os.path.join(repo_engine, "vendor", "scrcpy-server"))
    for share in ("/opt/homebrew/share/scrcpy", "/usr/local/share/scrcpy", "/usr/share/scrcpy"):
        candidates.append(os.path.join(share, "scrcpy-server"))
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


class ScrcpyChannel:
    """一个设备的 scrcpy 视频 + 控制通道。"""

    def __init__(
        self,
        serial: str,
        adb_path: str,
        server_jar: str,
        *,
        max_size: int = 1280,
        max_fps: int = 30,
        bit_rate: int = 8_000_000,
        connect_timeout: float = 8.0,
    ) -> None:
        self.serial = serial
        self.adb_path = adb_path
        self.server_jar = server_jar
        self.max_size = max_size
        self.max_fps = max_fps
        self.bit_rate = bit_rate
        self.connect_timeout = connect_timeout

        self.video_size: tuple[int, int] = (0, 0)
        self.fps = 0.0
        self.frames_decoded = 0
        self._frame: np.ndarray | None = None
        self._frame_id = 0
        self._frame_lock = threading.Lock()
        self._frame_event = threading.Event()
        self._control: socket.socket | None = None
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

    # ------------------------------------------------------------------ #
    # 生命周期
    # ------------------------------------------------------------------ #

    def start(self) -> None:
        import av  # 延迟导入：没有 PyAV 时由调用方回退到 adb 截图

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
        self._stop.set()
        for sock in (self._video, self._control):
            if sock is not None:
                with contextlib.suppress(OSError):
                    sock.close()
        if self._decoder_thread is not None:
            self._decoder_thread.join(timeout=2)
        if self._server is not None and self._server.poll() is None:
            self._server.kill()
        try:
            self._adb("forward", "--remove", f"tcp:{self._port}")
        except Exception:  # 清理失败不影响退出
            logger.debug("清理 adb forward 失败", exc_info=True)

    # ------------------------------------------------------------------ #
    # 帧
    # ------------------------------------------------------------------ #

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

    # ------------------------------------------------------------------ #
    # 控制
    # ------------------------------------------------------------------ #

    def click(self, x_norm: float, y_norm: float) -> None:
        """归一化坐标点击（相对视频画布）。"""
        if self._control is None:
            raise RuntimeError("控制通道未就绪")
        width, height = self.video_size
        x = round(min(max(x_norm, 0.0), 1.0) * (width - 1))
        y = round(min(max(y_norm, 0.0), 1.0) * (height - 1))
        self._send_touch(ACTION_DOWN, x, y)
        self._send_touch(ACTION_UP, x, y)

    def key(self, keycode: int) -> None:
        """注入一个按键（返回 / Home / 任务 / 电源 …）。"""
        if self._control is None:
            raise RuntimeError("控制通道未就绪")
        for action in (ACTION_DOWN, ACTION_UP):
            payload = struct.pack(">BBIII", MSG_INJECT_KEYCODE, action, keycode, 0, 0)
            assert len(payload) == 14, len(payload)
            self._control.sendall(payload)

    def swipe(self, x1: float, y1: float, x2: float, y2: float, duration: float = 0.3, steps: int = 12) -> None:
        if self._control is None:
            raise RuntimeError("控制通道未就绪")
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
        payload = struct.pack(
            ">BBQIIHHHII",  # type,action,pointerId,x,y,w,h,pressure,actionButton,buttons = 32B
            MSG_INJECT_TOUCH,
            action,
            POINTER_ID_FINGER,
            x,
            y,
            width,
            height,
            0xFFFF,  # pressure: u16 fixed-point 1.0
            0,  # action button
            0,  # buttons
        )
        assert len(payload) == 32, len(payload)
        assert self._control is not None
        self._control.sendall(payload)

    # ------------------------------------------------------------------ #
    # 内部
    # ------------------------------------------------------------------ #

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
        remote = "/data/local/tmp/scrcpy-server.jar"
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
            f"max_size={self.max_size}",
            f"max_fps={self.max_fps}",
            f"video_bit_rate={self.bit_rate}",
            "send_device_meta=true",
            "send_frame_meta=true",
            "send_dummy_byte=true",
            "send_codec_meta=true",
            "cleanup=false",
            "log_level=info",
        ]
        logger.debug("启动 scrcpy server: %s", " ".join(args))
        self._server = subprocess.Popen(
            [self.adb_path, "-s", str(self.serial), *args],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            text=True,
        )
        # 必须持续读走 stderr：管道写满会让 server 阻塞，表现就是"投屏莫名其妙卡死"
        if self._server.stderr is not None:
            threading.Thread(target=self._drain_server_log, args=(self._server.stderr,), daemon=True).start()

    def _adb(self, *args: str) -> subprocess.CompletedProcess[str]:
        command = [self.adb_path]
        if self.serial:
            command += ["-s", str(self.serial)]
        command += list(args)
        return subprocess.run(
            command, capture_output=True, text=True, timeout=30, check=False, stdin=subprocess.DEVNULL
        )

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
