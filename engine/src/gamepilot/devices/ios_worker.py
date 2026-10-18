"""带一台 iPhone 的**子进程**：引擎进程只能有一条用户态隧道，第二台起换进程来带。

这个文件有两个面孔，放一起是为了不拆散协议（两侧共用下面的常量）：

- **子进程**：`python -m gamepilot.devices.ios_worker --udid X --fps 8 --frame-port 51234`
  （引擎按需拉起，不给人手敲）—— 真正持有隧道的那个进程，复用 `ios.py` 的
  `TunnelSession` + `HidBridge`，一行设备逻辑都不重写。
- **父进程侧**：`IosWorkerController`（实现 `Controller` 接口的代理）。引擎的状态机、
  录制、图编辑全都留在父进程，对上层来说"换了个实现"而已。

三条通道（都是本机回环）：

| 方向 | 通道 | 格式 |
|---|---|---|
| 子 → 父 | `127.0.0.1:<frame-port>` | `[len u32 BE][截图原始字节]` 循环（父进程负责解码） |
| 父 → 子 | 子进程 stdin | NDJSON：`{"id":1,"method":"hid.touch","params":{"phase":"down","x":0.5,"y":0.5}}` |
| 子 → 父 | 子进程 stdout | NDJSON：`{"id":1,"result":{…}}` / `{"id":1,"error":{"message":…}}`，外加通知 `worker.ready` / `orientation` / `worker.fatal` |

触摸坐标是**归一化**的：界面方向变换（横屏要旋转）在子进程里做 —— 它同时看着画面比例和
方向，比让父进程来回问更省一次往返（规则见 `ios.py::IosController._refresh_orientation`）。
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import os
import socket
import struct
import subprocess
import sys
import threading
import time
from typing import Any

import numpy as np

from ..core.bezier_trajectory import play_swipe_path, play_tap, resolve_swipe_points
from .base import SUPPORTED_KEYS, Controller, Size
from .ios import (
    DIGITIZER_MAX,
    IOS_MIN_VERSION,
    KIND_IOS,
    NAMED_BUTTONS,
    ORIENT_PORTRAIT,
    ORIENTATION_NAMES,
    HidBridge,
    TunnelSession,
    effective_orientation,
    list_devices,
    orient_screenshot,
    to_digitizer,
)

logger = logging.getLogger("gamepilot.devices.ios_worker")

#: 帧格式：4 字节大端长度 + 截图原始字节（不带设备 id：一个子进程一台设备）
FRAME_HEADER = ">I"

#: 方向查询节流：每秒最多一次；画面比例一变立刻查（和进程内那条路同一套规则）
ORIENTATION_MIN_INTERVAL = 1.0

#: 父进程等子进程握手（拉起隧道 + HID + 首帧）的上限
READY_TIMEOUT = 60.0

#: 单条控制命令的等待上限：触摸是交互路径，宁可快速失败也不能挂着让界面等
COMMAND_TIMEOUT = 3.0


class FrameSender:
    """把截图字节写到父进程监听的端口。

    连不上就重试（父进程可能还在准备），写不动就丢掉这一帧 —— 丢帧比卡住采集划算。
    """

    def __init__(self, port: int, *, timeout: float = 15.0) -> None:
        self.port = port
        self._timeout = timeout
        self._socket: socket.socket | None = None
        self._lock = threading.Lock()

    def connect(self) -> bool:
        deadline = time.time() + self._timeout
        while time.time() < deadline:
            try:
                sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
            except OSError:
                time.sleep(0.1)
                continue
            with self._lock:
                self._socket = sock
            return True
        return False

    def send(self, payload: bytes) -> bool:
        with self._lock:
            sock = self._socket
        if sock is None:
            return False
        try:
            sock.sendall(struct.pack(FRAME_HEADER, len(payload)) + payload)
            return True
        except OSError as exc:
            logger.warning("帧通道写入失败，停止推帧: %s", exc)
            with self._lock:
                self._socket = None
            return False

    def close(self) -> None:
        with self._lock:
            sock, self._socket = self._socket, None
        if sock is not None:
            with contextlib.suppress(OSError):
                sock.close()


async def _aquery_orientation(udid: str) -> int:
    """问 SpringBoard 当前界面方向（走 usbmux 的 lockdown，跟隧道没关系）。"""
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.springboard import SpringBoardServicesService

    lockdown = await create_using_usbmux(serial=udid)
    try:
        service = SpringBoardServicesService(lockdown=lockdown)
        await service.connect()
        return int(await service.get_interface_orientation())
    finally:
        with contextlib.suppress(Exception):
            await lockdown.close()


class IosWorker:
    """子进程主体：隧道 + DVT 采集 + HID + 方向，对父进程只暴露三条通道。"""

    def __init__(self, udid: str, *, fps: float, frame_port: int) -> None:
        self.udid = udid
        self.fps = fps
        self.frames = FrameSender(frame_port)
        self.session: TunnelSession | None = None
        self.hid: HidBridge | None = None
        self._orientation = ORIENT_PORTRAIT
        self._orientation_at = 0.0
        self._aspect = ""
        self._querying = False
        self._stop = threading.Event()
        self._write_lock = threading.Lock()

    # ---------- 与父进程说话 ----------

    def write(self, message: dict[str, Any]) -> None:
        """stdout 是控制通道：**只允许**协议帧（日志一律走 stderr）。"""
        with self._write_lock:
            sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self.write({"method": method, "params": params or {}})

    # ---------- 生命周期 ----------

    def start(self) -> bool:
        session = TunnelSession(self.udid, fps=self.fps)
        try:
            session.start()
            hid = HidBridge(self.udid)
            hid.attach(session)
            hid.connect()
        except Exception as exc:
            with contextlib.suppress(Exception):
                session.close()
            self.notify("worker.fatal", {"message": f"{type(exc).__name__}: {exc}"})
            return False
        self.session = session
        self.hid = hid
        if not self.frames.connect():
            self.notify("worker.fatal", {"message": "父进程没有接受帧通道连接"})
            return False
        # 方向在握手时就问一次（此时还没有命令要处理，阻塞没关系）
        value = self._query_orientation(session)
        if value is not None:
            self._orientation = value
        self._aspect = "landscape" if session.size[0] > session.size[1] else "portrait"
        self._orientation_at = time.time()
        self.notify(
            "worker.ready",
            {
                "resolution": list(session.size),
                "orientation": self._orientation,
                "fps": round(float(session.fps_actual), 1),
            },
        )
        threading.Thread(target=self._pump_frames, name="ios-worker-frames", daemon=True).start()
        return True

    def _pump_frames(self) -> None:
        """有新帧才转发（帧号没变说明还是上一张，别重复发）。"""
        session = self.session
        assert session is not None
        last_id = 0
        while not self._stop.is_set():
            encoded = session.latest_encoded(timeout=0.5)
            if encoded is None:
                continue
            frame_id = session.frame_id
            if frame_id == last_id:
                continue
            last_id = frame_id
            self.frames.send(encoded)

    def orientation(self) -> int:
        """返回**缓存**的方向；该刷新时就地在后台刷。

        查询走 usbmux，在后台刷新缓存，避免阻塞 HID 命令循环。
        """
        session = self.session
        if session is None:
            return self._orientation
        now = time.time()
        size = session.size
        aspect = "landscape" if size[0] > size[1] else "portrait"
        due = aspect != self._aspect or now - self._orientation_at >= ORIENTATION_MIN_INTERVAL
        if due and not self._querying:
            self._aspect = aspect
            self._orientation_at = now
            self._querying = True
            threading.Thread(target=self._refresh_orientation, daemon=True).start()
        return self._orientation

    def _refresh_orientation(self) -> None:
        session = self.session
        try:
            if session is None:
                return
            value = self._query_orientation(session)
            if value is None:
                return
            previous = self._orientation
            self._orientation = value
            if value != previous:
                logger.info("iOS 界面方向: %s", ORIENTATION_NAMES.get(value, value))
                self.notify("orientation", {"value": value})
        finally:
            self._querying = False

    def _query_orientation(self, session: TunnelSession) -> int | None:
        try:
            return int(session.run(_aquery_orientation(self.udid), timeout=8))
        except Exception as exc:
            logger.debug("查界面方向失败（沿用上次）: %s", exc)
            return None

    def close(self) -> None:
        self._stop.set()
        if self.hid is not None:
            with contextlib.suppress(Exception):
                self.hid.close()
        if self.session is not None:
            with contextlib.suppress(Exception):
                self.session.close()
        self.frames.close()

    # ---------- 命令 ----------

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        method = request.get("method")
        params = request.get("params") or {}
        if method == "hid.touch":
            return self._touch(params)
        if method == "hid.press":
            return self._press(params)
        if method == "hid.text":
            return self._text(params)
        if method == "worker.status":
            return {"orientation": self._orientation, "frames": self.session.frames if self.session else 0}
        raise ValueError(f"未知命令: {method}")

    def _hid(self) -> HidBridge:
        if self.hid is None or not self.hid.connected:
            raise RuntimeError("iOS 控制通道未就绪")
        return self.hid

    def _touch(self, params: dict[str, Any]) -> dict[str, Any]:
        phase = str(params.get("phase", ""))
        if phase not in ("down", "move", "up"):
            raise ValueError(f"phase 必须是 down/move/up，收到: {phase}")
        session = self.session
        raw = None if session is None or session.size == (0, 0) else session.size
        dx, dy = to_digitizer(
            float(params.get("x", 0.0)),
            float(params.get("y", 0.0)),
            self.orientation(),
            raw,
        )
        self._hid().touch(phase, round(dx * DIGITIZER_MAX), round(dy * DIGITIZER_MAX))
        return {"ok": True}

    def _press(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", ""))
        if name not in SUPPORTED_KEYS and name not in NAMED_BUTTONS:
            raise ValueError(f"不支持的按键: {name}")
        self._hid().press(name)
        return {"ok": True}

    def _text(self, params: dict[str, Any]) -> dict[str, Any]:
        self._hid().text(str(params.get("value", "")))
        return {"ok": True}


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="gamepilot-ios-worker", description="带一台 iPhone 的采集/控制子进程")
    parser.add_argument("--udid", required=True, help="设备 UDID")
    parser.add_argument("--fps", type=float, default=8.0, help="DVT 截图循环的目标帧率")
    parser.add_argument("--frame-port", type=int, required=True, help="父进程监听帧通道的端口")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=os.environ.get("GAMEPILOT_LOG_LEVEL", "WARNING"),
        format="%(message)s",
        stream=sys.stderr,
    )
    worker = IosWorker(args.udid, fps=args.fps, frame_port=args.frame_port)
    if not worker.start():
        return 1
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                continue
            if request.get("method") == "worker.stop":
                break
            request_id = request.get("id")
            try:
                result = worker.handle(request)
            except Exception as exc:
                worker.write({"jsonrpc": "2.0", "id": request_id, "error": {"message": f"{type(exc).__name__}: {exc}"}})
                continue
            worker.write({"jsonrpc": "2.0", "id": request_id, "result": result})
    finally:
        worker.close()
    return 0


def _recv_exact(connection: socket.socket, size: int) -> bytes | None:
    """读满 size 字节；连接断了返回 None（帧通道没有分帧器，只能自己凑）。"""
    chunks: list[bytes] = []
    remaining = size
    while remaining > 0:
        try:
            chunk = connection.recv(remaining)
        except OSError:
            return None
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class IosWorkerController(Controller):
    """iOS：隧道跑在**子进程**里（引擎进程只能带一条用户态隧道，见 `ios.py` 的说明）。

    第一台 iPhone 走进程内的 `IosController`（一条隧道够用）；第二台起换成这里，
    引擎只做代理：画面从子进程的帧通道拿，触摸/按键/文本转成命令发过去。
    """

    scheme = "iOS"
    kind = KIND_IOS
    description = "iPhone / iPad（隧道在子进程里：引擎同时可以带多台）"

    def __init__(
        self,
        device_id: str = "",
        udid: str = "",
        fps: float = 8.0,
        worker_command: list[str] | None = None,
        **options: Any,
    ) -> None:
        super().__init__(device_id or f"{KIND_IOS}:{udid}", **options)
        self.udid = udid
        self.channel = "dvt"
        self.link_note = ""
        self.usb_report = ""
        self._display_name = ""
        self._fps = fps
        #: 测试用的逃生口：换掉"怎么拉起子进程"（默认就是本仓库这个模块）
        self._worker_command = (
            list(worker_command) if worker_command else [sys.executable, "-m", "gamepilot.devices.ios_worker"]
        )
        self._orientation = ORIENT_PORTRAIT
        self._worker: subprocess.Popen[str] | None = None
        self._listener: socket.socket | None = None
        self._size: Size = (0, 0)
        self._error: str | None = None
        self._frame: np.ndarray | None = None
        self._frame_id = 0
        self._frame_seq = 0
        self._last_frame_at = 0.0
        self._fps_actual = 0.0
        self._lock = threading.Lock()
        self._frame_event = threading.Event()
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._next_id = 1
        self._pending: dict[int, tuple[threading.Event, list[dict[str, Any]]]] = {}
        self._pending_lock = threading.Lock()
        self._write_lock = threading.Lock()

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
        self._report_usb_config()

        listener = socket.socket()
        try:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            listener.settimeout(READY_TIMEOUT)
            port = int(listener.getsockname()[1])
            self._listener = listener
            self._worker = subprocess.Popen(
                [*self._worker_command, "--udid", self.udid, "--fps", str(self._fps), "--frame-port", str(port)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
            threading.Thread(target=self._read_worker, name=f"ios-worker-{self.udid}", daemon=True).start()
            self._await_ready()
            connection, _ = listener.accept()
            threading.Thread(target=self._read_frames, args=(connection,), daemon=True).start()
        except BaseException:
            self.close()
            raise
        self.channel = "dvt"
        self.link_note = f"DVT 采集（{self._size[0]}x{self._size[1]}，子进程）"
        if self.usb_report:
            self.link_note += f" · {self.usb_report}"
        self._connected = True

    def _await_ready(self) -> None:
        if not self._ready.wait(READY_TIMEOUT):
            raise RuntimeError(f"iOS 子进程 {READY_TIMEOUT:g}s 没就绪（隧道建不起来？）")
        if self._error is not None:
            raise RuntimeError(self._error)

    def _report_usb_config(self) -> None:
        """只测绘、不擅自切换：切错配置会让设备从 usbmux 上消失。"""
        from . import ios_usb

        try:
            devices = ios_usb.survey()
        except Exception as exc:  # 测绘失败不影响连接
            logger.debug("USB 配置测绘失败: %s", exc)
            return
        if not devices:
            self.usb_report = "USB 层没看到 Apple 设备"
            return
        if len(devices) > 1:
            self.usb_report = f"USB 层有 {len(devices)} 台 Apple 设备（未逐台核对配置）"
            return
        device = devices[0]
        current = next((item for item in device.configurations if item.value == device.current), None)
        self.usb_report = f"USB 配置 {device.current}（{current.paths if current else '?'} 条通路）"

    # ---------- 子进程那两条通道 ----------

    def _read_worker(self) -> None:
        worker = self._worker
        assert worker is not None and worker.stdout is not None
        for line in worker.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                logger.debug("子进程 stdout 不是 JSON: %s", line[:200])
                continue
            self._handle_message(message)
        self._error = self._error or "iOS 子进程已退出"
        self._ready.set()
        self._stop.set()

    def _handle_message(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        if isinstance(request_id, int):
            with self._pending_lock:
                waiter = self._pending.pop(request_id, None)
            if waiter is not None:
                waiter[1].append(message)
                waiter[0].set()
            return
        method = message.get("method")
        params = message.get("params") or {}
        if method == "worker.ready":
            resolution = params.get("resolution") or [0, 0]
            self._size = (int(resolution[0]), int(resolution[1]))
            self._orientation = int(params.get("orientation", ORIENT_PORTRAIT))
            self._ready.set()
        elif method == "orientation":
            self._orientation = int(params.get("value", self._orientation))
        elif method == "worker.fatal":
            self._error = str(params.get("message") or "iOS 子进程启动失败")
            self._ready.set()
        elif method == "worker.log":
            logger.info("iOS 子进程: %s", params.get("message", ""))

    def _read_frames(self, connection: socket.socket) -> None:
        """帧通道：在这里就解码好，`screenshot()` 只做一次拷贝。"""
        import cv2

        window_start = time.time()
        window_count = 0
        with connection:
            while not self._stop.is_set():
                header = _recv_exact(connection, 4)
                if header is None:
                    break
                (length,) = struct.unpack(FRAME_HEADER, header)
                payload = _recv_exact(connection, length)
                if payload is None:
                    break
                image = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
                if image is None:
                    continue
                # 和触摸用同一套方向判断：方向码还停在竖屏、画面已经横过来时，
                # 按 Home 在右兜底 —— 画面和点击必须来自同一个方向码
                orientation = effective_orientation(self._orientation, image.shape[1], image.shape[0])
                presented = orient_screenshot(image, orientation)
                now = time.time()
                height, width = presented.shape[:2]
                with self._lock:
                    self._frame = presented
                    self._size = (int(width), int(height))
                    self._frame_id += 1
                    self._frame_seq = self._frame_id
                    self._last_frame_at = now
                self._frame_event.set()
                window_count += 1
                elapsed = now - window_start
                if elapsed >= 2.0:
                    self._fps_actual = window_count / elapsed
                    window_count = 0
                    window_start = now

    def _command(self, method: str, params: dict[str, Any], *, timeout: float = COMMAND_TIMEOUT) -> dict[str, Any]:
        worker = self._worker
        if worker is None or worker.stdin is None or self._stop.is_set():
            raise RuntimeError(self._error or "iOS 子进程已退出：断开后重连这台设备")
        with self._pending_lock:
            request_id = self._next_id
            self._next_id += 1
            waiter: tuple[threading.Event, list[dict[str, Any]]] = (threading.Event(), [])
            self._pending[request_id] = waiter
        message = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        try:
            # 拖动时 move 是高频并发的：多个线程同时写 stdin 会把 NDJSON 行插花，
            # 子进程解析不了就直接丢 —— 表现就是"命令石沉大海、3 秒后超时"
            with self._write_lock:
                worker.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
                worker.stdin.flush()
        except OSError as exc:
            with self._pending_lock:
                self._pending.pop(request_id, None)
            raise RuntimeError(f"iOS 子进程写不进去（{exc}）：断开后重连这台设备") from exc
        if not waiter[0].wait(timeout):
            with self._pending_lock:
                self._pending.pop(request_id, None)
            raise RuntimeError(f"iOS 子进程 {timeout:g}s 没回话：断开后重连这台设备")
        answer = waiter[1][0] if waiter[1] else {}
        error = answer.get("error")
        if error:
            raise RuntimeError(str(error.get("message") or error))
        result = answer.get("result")
        return dict(result) if isinstance(result, dict) else {}

    # ---------- Controller 接口 ----------

    @property
    def resolution(self) -> Size:
        return self._size

    @property
    def orientation(self) -> int:
        return self._orientation

    @property
    def link_fps(self) -> float:
        return float(self._fps_actual)

    def is_alive(self) -> bool:
        return self._connected and not self._stop.is_set()

    def screenshot(self) -> np.ndarray:
        with self._lock:
            frame = self._frame
        if frame is None and self._frame_event.wait(2.0):
            with self._lock:
                frame = self._frame
        if frame is None:
            raise RuntimeError(f"iOS 采集没有画面: {self._error or '子进程还没出帧'}")
        # 帧通道里已经按界面方向转正。这里再转一次会把倒置画面转回去，点击也对不上。
        self._size = (int(frame.shape[1]), int(frame.shape[0]))
        return frame.copy()

    def touch(self, phase: str, x: float, y: float) -> None:
        if phase not in ("down", "move", "up"):
            raise ValueError(f"phase 必须是 down/move/up，收到: {phase}")
        self._command("hid.touch", {"phase": phase, "x": float(x), "y": float(y)})

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
        self._command("hid.press", {"name": name})

    def text(self, value: str) -> None:
        self._command("hid.text", {"value": value})

    def close(self) -> None:
        self._stop.set()
        worker = self._worker
        if worker is not None:
            with contextlib.suppress(Exception):
                if worker.stdin is not None:
                    with self._write_lock:
                        worker.stdin.write(json.dumps({"method": "worker.stop"}) + "\n")
                        worker.stdin.flush()
            with contextlib.suppress(Exception):
                worker.wait(timeout=5)
            if worker.poll() is None:
                with contextlib.suppress(Exception):
                    worker.kill()
            for stream in (worker.stdin, worker.stdout):
                with contextlib.suppress(Exception):
                    if stream is not None:
                        stream.close()
            self._worker = None
        if self._listener is not None:
            with contextlib.suppress(OSError):
                self._listener.close()
            self._listener = None
        with self._lock:
            self._frame = None
        super().close()


if __name__ == "__main__":
    raise SystemExit(main())
