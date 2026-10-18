"""帧通道：把 JPEG 以**原始字节**发给宿主（Rust），不占用 JSON-RPC stdout。

为什么不走 stdout：引擎的 stdout 是 JSON-RPC 控制通道。两台设备按 15fps 推
60~143KB 的 JPEG，base64 后是 **2.4MB/s** 的 JSON 行挤在这根管道上，
RPC 响应会排在几万行帧后面 —— 表现出来就是界面"卡在 connecting、点一下也卡死"。

通道地址由宿主写入 ``GAMEPILOT_FRAME_SOCKET``：

- unix：文件系统路径，走 AF_UNIX
- Windows：``tcp:127.0.0.1:<port>``，走本机 TCP（标准库没有 AF_UNIX）

协议：

    [idLen u8][deviceId][jpegLen u32 BE][jpeg bytes] ...

宿主侧（Rust）只做一次 read，不做 base64、不解析 JSON。没有这条通道，
或通道还没连上时，自动退回"base64 塞在通知里"的老路。
"""

from __future__ import annotations

import contextlib
import logging
import os
import queue
import socket
import struct
import threading

logger = logging.getLogger("gamepilot.frames")

ENV_FRAME_SOCKET = "GAMEPILOT_FRAME_SOCKET"


class FrameSink:
    """帧的独立发送通道。

    带一个**小队列 + 丢帧**策略：宿主读得慢时宁可丢帧，也不让截图/识别循环被阻塞
    （状态机跑不动的代价比丢几帧画面大得多）。
    """

    def __init__(self, path: str, queue_size: int = 2) -> None:
        self.path = path
        self._queue: queue.Queue[bytes] = queue.Queue(maxsize=queue_size)
        self._socket: socket.socket | None = None
        self._thread = threading.Thread(target=self._run, name="frame-sink", daemon=True)
        self._stop = threading.Event()
        self._ready = threading.Event()
        self.sent = 0
        self.dropped = 0

    @staticmethod
    def from_env() -> FrameSink | None:
        path = os.environ.get(ENV_FRAME_SOCKET)
        if not path:
            return None
        return FrameSink(path)

    @property
    def connected(self) -> bool:
        """宿主已经握手成功，JPEG 可以走原始字节而不是 stdout。"""
        return self._ready.is_set()

    def start(self) -> None:
        self._thread.start()

    def submit(self, device_id: str, jpeg: bytes) -> None:
        """投递一帧（非阻塞；宿主跟不上就丢，并计数）。

        队列满时丢**最旧**的那帧而不是新的：画面宁可跳一下，也不能越压越旧
        （30fps 下积压两三帧就是几十毫秒的固定延迟）。
        """
        encoded_id = device_id.encode("utf-8")[:255]
        payload = struct.pack(">B", len(encoded_id)) + encoded_id + struct.pack(">I", len(jpeg)) + jpeg
        try:
            self._queue.put_nowait(payload)
            return
        except queue.Full:
            pass
        self.dropped += 1
        with contextlib.suppress(queue.Empty):
            self._queue.get_nowait()  # 丢掉最旧的一帧，给最新这帧让位
        with contextlib.suppress(queue.Full):
            self._queue.put_nowait(payload)
        if self.dropped % 100 == 1:
            logger.warning("帧通道拥塞，已丢弃 %d 帧（画面会跳，但不拖慢识别）", self.dropped)

    def close(self) -> None:
        self._stop.set()
        if self._socket is not None:
            with contextlib.suppress(OSError):
                self._socket.close()

    def _run(self) -> None:
        if not self._connect():
            return
        logger.info("帧通道已连接: %s", self.path)
        assert self._socket is not None
        while not self._stop.is_set():
            try:
                payload = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self._socket.sendall(payload)
                self.sent += 1
            except OSError as error:
                logger.warning("帧通道写入失败，停止推帧: %s", error)
                return

    def _connect(self, timeout: float = 5.0) -> bool:
        import time

        deadline = time.time() + timeout
        ok = self._connect_tcp(deadline) if self.path.startswith("tcp:") else self._connect_unix(deadline)
        if ok:
            self._ready.set()
        return ok

    def _connect_tcp(self, deadline: float) -> bool:
        import time

        rest = self.path[4:]
        host, sep, port_text = rest.rpartition(":")
        if not sep or not host or not port_text.isdigit():
            logger.warning("帧通道地址无效 %s，回退 base64 通道", self.path)
            return False
        port = int(port_text)
        while time.time() < deadline:
            try:
                sock = socket.create_connection((host, port), timeout=0.5)
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                self._socket = sock
                return True
            except OSError:
                time.sleep(0.1)
        logger.warning("连不上帧通道 %s，回退 base64 通道", self.path)
        return False

    def _connect_unix(self, deadline: float) -> bool:
        import time

        # Windows 的 CPython 没有 AF_UNIX；别让缺这个常量变成 AttributeError。
        af_unix = getattr(socket, "AF_UNIX", None)
        if af_unix is None:
            logger.warning("这个平台没有 AF_UNIX，帧通道不可用（回退 base64 通道）")
            return False
        while time.time() < deadline:
            try:
                sock = socket.socket(af_unix, socket.SOCK_STREAM)
                sock.connect(self.path)
                self._socket = sock
                return True
            except OSError:
                time.sleep(0.1)
        logger.warning("连不上帧通道 %s，回退 base64 通道", self.path)
        return False
