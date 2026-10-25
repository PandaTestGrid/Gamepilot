"""iOS QuickTime USB 视频采集（Apple Screen Capture 私有协议）。

这条链路和 DVT `takeScreenshot` 的本质区别：设备主动把 H.264 码流推给主机，
主机只做解包 + 解码，不再每帧让手机合成一张 PNG。qvh / iPhoneMirror 都是这个路子。

协议要点（逆向自 Apple QuickTime Screen Capture，参考 quicktime_video_hack）：

1. 向设备发 vendor 控制请求 ``0x40/0x52 wValue=0 wIndex=2`` 解锁隐藏 USB 配置；
   设备会断开重连一次，多出 class ``0xFF`` / subclass ``0x2A`` 的接口
   （IN ``0x86`` / OUT ``0x05``）。收尾时用 ``wIndex=0`` 关回去。
2. claim 后等设备发 ``PING``，回一个同样的 PING。
3. ``SYNC/CWPA`` -> 回 RPLY（本地音频 clock）+ 发 ``ASYN/HPD1``、``ASYN/HPA1``。
4. ``SYNC/CVRP`` -> 回 RPLY（本地视频 clock），之后每收一个 ``ASYN/FEED`` 就补一个
   ``ASYN/NEED`` 维持背压。
5. ``FEED`` 里是 CoreMedia ``sbuf``，`sdat` 字段是 AVCC 长度的 H.264 NALU。

限制（真实存在，不美化）：

- 依赖 libusb0 内核过滤驱动（Windows 上是 Apple ``usbccgp`` 的 UpperFilter）；
- 私有协议，iOS 升级可能失效；
- 某些设备/iOS 组合会出现「端点打开但设备不发 PING」，只能回落到 DVT 截图。
"""

from __future__ import annotations

import contextlib
import logging
import struct
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np

logger = logging.getLogger("gamepilot.devices.ios_qt")

APPLE_VID = 0x05AC
QT_INTERFACE_CLASS = 0xFF
QT_INTERFACE_SUBCLASS = 0x2A
QT_ENDPOINT_IN = 0x86
QT_ENDPOINT_OUT = 0x05
QT_CONFIGURATION = 5

#: 厂商控制请求的参数（wValue=0 固定，wIndex=2 开 / 0 关）
QT_REQUEST_TYPE_OUT = 0x40
QT_REQUEST = 0x52

PING_MAGIC = 0x70696E67
SYNC_MAGIC = 0x73796E63
RPLY_MAGIC = 0x72706C79
ASYN_MAGIC = 0x6173796E

CWPA = 0x63777061
AFMT = 0x61666D74
CVRP = 0x63767270
CLOK = 0x636C6F6B
TIME = 0x74696D65
OG = 0x676F2120
SKEW = 0x736B6577
STOP = 0x73746F70

FEED = 0x66656564
EAT = 0x65617421
NEED = 0x6E656564
HPD1 = 0x68706431
HPA1 = 0x68706131
HPD0 = 0x68706430
HPA0 = 0x68706130
SPRP = 0x73707270
TBAS = 0x74626173
SRAT = 0x73726174
RELS = 0x72656C73
TJMP = 0x746A6D70

EMPTY_CFTYPE = 1

#: CoreMedia 字典/样本缓冲的 magic（线上是小端整数，注释里是显示顺序）
KEY_VALUE_PAIR = 0x6B657976
STRING_KEY = 0x7374726B
BOOLEAN_VALUE = 0x62756C76
DICT_MAGIC = 0x64696374
DATA_VALUE = 0x64617476
STRING_VALUE = 0x73747276
NUMBER_VALUE = 0x6E6D6276
SAMPLE_BUFFER = 0x73627566
SBUF_SDAT = 0x73646174

#: 单次 USB 读的上限；Apple 的包不会超过它
READ_SIZE = 1 << 20

#: 连续多久没有 FEED 就认为会话死了
STALL_SECONDS = 3.0


def _le32(value: int) -> bytes:
    return struct.pack("<I", value)


def _le64(value: int) -> bytes:
    return struct.pack("<Q", value)


def _header(length: int, magic: int, clock: int = 0, subtype: int | None = None) -> bytes:
    out = _le32(length) + _le32(magic) + _le64(clock)
    if subtype is not None:
        out += _le32(subtype)
    return out


def make_ping() -> bytes:
    """PING：16 字节，头部是 0x0000000100000000。"""
    return struct.pack("<IIQ", 16, PING_MAGIC, 0x0000000100000000)


def make_reply(clock: int, correlation_id: int) -> bytes:
    return _le32(28) + _le32(RPLY_MAGIC) + _le64(correlation_id) + _le32(0) + _le64(clock)


def make_need(clock: int) -> bytes:
    return _header(20, ASYN_MAGIC, clock, NEED)


def _number_f64(value: float) -> bytes:
    payload = b"\x06" + struct.pack("<d", value)
    return _le32(len(payload) + 8) + _le32(NUMBER_VALUE) + payload


def _number_u32(value: int) -> bytes:
    payload = b"\x03" + struct.pack("<I", value)
    return _le32(len(payload) + 8) + _le32(NUMBER_VALUE) + payload


def _value_bool(value: bool) -> bytes:
    return _le32(9) + _le32(BOOLEAN_VALUE) + _le32(1 if value else 0)


def _value_str(value: str) -> bytes:
    raw = value.encode("utf-8")
    return _le32(len(raw) + 8) + _le32(STRING_VALUE) + raw


def _value_bytes(raw: bytes) -> bytes:
    return _le32(len(raw) + 8) + _le32(DATA_VALUE) + raw


def _key(name: str) -> bytes:
    raw = name.encode("utf-8")
    return _le32(len(raw) + 8) + _le32(STRING_KEY) + raw


def _dict(pairs: list[tuple[str, bytes]]) -> bytes:
    body = b"".join(_le32(len(_key(k) + v) + 8) + _le32(KEY_VALUE_PAIR) + _key(k) + v for k, v in pairs)
    return _le32(len(body) + 8) + _le32(DICT_MAGIC) + body


def _asyn_dict(subtype: int, clock: int, pairs: list[tuple[str, bytes]]) -> bytes:
    body = _dict(pairs)
    return _le32(len(body) + 20) + _le32(ASYN_MAGIC) + _le64(clock) + _le32(subtype) + body


def make_hpd1(width: float, height: float, *, demo: bool = True) -> bytes:
    """HPD1：告诉设备显示尺寸 + Valeria 能力。

    ``demo=True`` 是 Apple 的演示模式：完整镜像画面，但状态栏时间/电量显示
    Apple 的固定值。``demo=False`` 保留真实状态栏，但部分机型会裁切。
    """
    display = _dict([("Width", _number_f64(width)), ("Height", _number_f64(height))])
    return _asyn_dict(
        HPD1,
        EMPTY_CFTYPE,
        [
            ("Valeria", _value_bool(demo)),
            ("HEVCDecoderSupports444", _value_bool(True)),
            ("DisplaySize", display),
        ],
    )


def make_hpa1(audio_clock: int) -> bytes:
    # 48 kHz / lpcm / 2ch / 16bit
    asbd = struct.pack("<8I4I", 48000, 0x6C70636D, 0, 1, 4, 2, 2, 8, 0, 0, 0, 0)
    return _asyn_dict(
        HPA1,
        audio_clock,
        [
            ("BufferAheadInterval", _number_f64(0.073)),
            ("deviceUID", _value_str("Valeria")),
            ("ScreenLatency", _number_f64(0.04)),
            ("formats", _value_bytes(asbd)),
            ("EDIDAC3Support", _number_u32(0)),
            ("deviceName", _value_str("Valeria")),
        ],
    )


def make_stop_packets(audio_clock: int) -> list[bytes]:
    """优雅收尾：先停音频再停视频，否则设备侧会话会残留。"""
    packets = []
    if audio_clock:
        packets.append(_header(20, ASYN_MAGIC, audio_clock, HPA0))
    packets.append(_header(20, ASYN_MAGIC, EMPTY_CFTYPE, HPD0))
    return packets


@dataclass
class _Stats:
    packets: int = 0
    frames: int = 0
    keyframes: int = 0
    bytes: int = 0
    fps: float = 0.0
    last_frame_at: float = 0.0
    window_start: float = field(default_factory=time.monotonic)
    window_count: int = 0


def extract_sample_data(payload: bytes) -> bytes | None:
    """从 ``ASYN/FEED`` 的内层 sbuf 里取出 ``sdat``（AVCC NALU）。"""
    if len(payload) < 8:
        return None
    total = struct.unpack_from("<I", payload, 0)[0]
    if total < 8 or total > len(payload):
        return None
    if struct.unpack_from("<I", payload, 4)[0] != SAMPLE_BUFFER:
        return None
    offset = 8
    while offset + 8 <= total:
        entry_len = struct.unpack_from("<I", payload, offset)[0]
        magic = struct.unpack_from("<I", payload, offset + 4)[0]
        if entry_len < 8 or offset + entry_len > total:
            return None
        if magic == SBUF_SDAT:
            return payload[offset + 8 : offset + entry_len]
        offset += entry_len
    return None


def avcc_to_annexb(data: bytes) -> bytes:
    """AVCC（4 字节大端长度前缀）转 Annex-B，给 libav 用。"""
    out = bytearray()
    offset = 0
    while offset + 4 <= len(data):
        size = int.from_bytes(data[offset : offset + 4], "big")
        offset += 4
        if size <= 0 or offset + size > len(data):
            break
        out += b"\x00\x00\x00\x01"
        out += data[offset : offset + size]
        offset += size
    return bytes(out)


def _nal_types(annexb: bytes) -> list[int]:
    """粗扫 Annex-B 里的 NALU 类型（只用于判断关键帧）。"""
    types = []
    index = annexb.find(b"\x00\x00\x00\x01")
    while index >= 0:
        start = index + 4
        if start < len(annexb):
            types.append(annexb[start] & 0x1F)
        index = annexb.find(b"\x00\x00\x00\x01", start)
    return types


def find_quicktime_interface(device: Any) -> tuple[int, int] | None:
    """返回 (配置号, 接口号)。没有 QT 接口就返回 None。"""
    for config in device:
        for interface in config:
            if (
                int(interface.bInterfaceClass) == QT_INTERFACE_CLASS
                and int(interface.bInterfaceSubClass) == QT_INTERFACE_SUBCLASS
            ):
                return int(config.bConfigurationValue), int(interface.bInterfaceNumber)
    return None


def _usb() -> tuple[Any, Any]:
    """返回 (usb.core, backend)。优先 libusb0：Windows 上 QT 走的就是它。"""
    import usb.backend.libusb0 as libusb0
    import usb.core

    return usb.core, libusb0.get_backend()


def open_apple_device(serial: str = "") -> Any:
    """按序列号找 Apple USB 设备（找不到序列号就取第一个）。"""
    core, backend = _usb()
    try:
        devices = list(core.find(find_all=True, idVendor=APPLE_VID, backend=backend) or [])
    except Exception as exc:
        logger.debug("枚举 Apple USB 设备失败: %s", exc)
        return None
    if not devices:
        return None
    if not serial:
        return devices[0]
    wanted = serial.replace("-", "").lower()
    for device in devices:
        try:
            current = (device.serial_number or "").replace("-", "").lower()
        except Exception:
            continue
        if current == wanted:
            return device
    return devices[0]


def request_quicktime_config(enable: bool = True) -> bool:
    """发 vendor 请求解锁/关闭隐藏的 QT 配置。成功会触发一次重新枚举。"""
    device = open_apple_device()
    if device is None:
        return False
    try:
        device.ctrl_transfer(
            QT_REQUEST_TYPE_OUT,
            QT_REQUEST,
            0,
            2 if enable else 0,
            None,
            timeout=3000,
        )
        return True
    except Exception as exc:
        # 解锁成功时设备会掉线，控制传输经常以超时/ENODEV 结束——这是正常的
        logger.debug("QT 配置请求（%s）返回异常（通常无害）: %s", "开" if enable else "关", exc)
        return enable


def wait_for_quicktime(serial: str = "", timeout: float = 20.0) -> tuple[Any, int, int] | None:
    """等设备以 QT 配置重新出现，返回 (设备, 配置号, 接口号)。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            device = open_apple_device(serial)
            if device is not None:
                found = find_quicktime_interface(device)
                if found is not None:
                    return device, found[0], found[1]
        except Exception:
            pass
        time.sleep(0.4)
    return None


class QuickTimeCapture:
    """一条 QuickTime 采集会话：USB 读线程 + H.264 解码线程。"""

    def __init__(self, udid: str = "", *, display_size: tuple[float, float] | None = None) -> None:
        self.udid = udid
        self.display_size = display_size or (1206.0, 2622.0)
        self.stats = _Stats()
        self.error: str | None = None
        self.width = 0
        self.height = 0
        self._device: Any = None
        self._iface = -1
        self._audio_clock = 0
        self._video_clock = 0
        self._frame: np.ndarray | None = None
        self._frame_id = 0
        self._lock = threading.Lock()
        self._frame_event = threading.Event()
        self._stop = threading.Event()
        self._reader: threading.Thread | None = None
        self._decoder: threading.Thread | None = None
        self._decode_queue: list[bytes] = []
        self._decode_lock = threading.Lock()
        self._first_frame = threading.Event()
        self._session_ready = threading.Event()

    # ---------- 生命周期 ----------

    def start(self, timeout: float = 15.0) -> None:
        """激活配置、claim、握手、等第一帧；失败抛 RuntimeError。"""
        device = open_apple_device(self.udid)
        found = find_quicktime_interface(device) if device is not None else None
        if found is None:
            request_quicktime_config(True)
            waited = wait_for_quicktime(self.udid, timeout=20.0)
            if waited is None:
                raise RuntimeError("设备没有暴露出 QuickTime USB 配置")
            device, config_value, iface_number = waited
        else:
            config_value, iface_number = found

        self._device = device
        self._iface = iface_number
        try:
            if int(device.get_active_configuration().bConfigurationValue) != config_value:
                device.set_configuration(config_value)
                time.sleep(0.4)
                device = open_apple_device(self.udid)
                self._device = device
        except Exception as exc:
            logger.debug("设置 QT 配置失败（稍后 claim 会再试一次）: %s", exc)

        import usb.util

        try:
            usb.util.claim_interface(device, iface_number)
        except Exception:
            # libusb0 新句柄的 pipe table 可能还没初始化，按官方流程重设一次配置再 claim
            with contextlib.suppress(Exception):
                device.set_configuration(config_value)
            time.sleep(0.3)
            device = open_apple_device(self.udid)
            self._device = device
            usb.util.claim_interface(device, iface_number)

        self._decoder = threading.Thread(target=self._decode_loop, name="ios-qt-decode", daemon=True)
        self._decoder.start()
        self._reader = threading.Thread(target=self._read_loop, name="ios-qt-usb", daemon=True)
        self._reader.start()

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._first_frame.wait(0.2):
                logger.info("QuickTime 采集就绪: %sx%s", self.width, self.height)
                return
            if self.error:
                break
        self.close()
        raise RuntimeError(self.error or f"QuickTime 会话 {timeout:g}s 内没有画面")

    @property
    def alive(self) -> bool:
        return not self._stop.is_set() and self.error is None

    def close(self) -> None:
        was_active = self._device is not None
        self._stop.set()
        with self._decode_lock:
            self._decode_queue.clear()
            self._decode_queue.append(b"")
        device = self._device
        if device is not None:
            with contextlib.suppress(Exception):
                self._send(make_stop_packets(self._audio_clock))
            with contextlib.suppress(Exception):
                import usb.util

                usb.util.release_interface(device, self._iface)
        for thread in (self._reader, self._decoder):
            if thread is not None:
                thread.join(timeout=2.0)
        self._reader = None
        self._decoder = None
        # 关掉隐藏配置，把设备还给 usbmux（不然触摸/截图都会断）
        with contextlib.suppress(Exception):
            request_quicktime_config(False)
        self._device = None
        if was_active:
            self._wait_for_usbmux_return()

    @staticmethod
    def _wait_for_usbmux_return(timeout: float = 10.0) -> bool:
        """等设备重新挂回 usbmux，确保调用方的截图/触控链路能继续用。

        用同步 socket 直接问 Apple 的 usbmux（27015），不依赖 asyncio：
        这条路径在隧道线程之外被调用，``asyncio.run`` 会和已有循环打架。
        """
        import plistlib
        import socket

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", 27015), timeout=2.0) as sock:
                    request = plistlib.dumps(
                        {
                            "MessageType": "ListDevices",
                            "ClientVersionString": "gamepilot",
                            "ProgName": "gamepilot",
                            "kLibUSBMuxVersion": 3,
                        }
                    )
                    sock.sendall(struct.pack("<IIII", len(request) + 16, 1, 8, 1) + request)
                    header = sock.recv(16)
                    if len(header) == 16:
                        total = struct.unpack_from("<I", header, 0)[0]
                        body = b""
                        while len(body) < total - 16:
                            chunk = sock.recv(total - 16 - len(body))
                            if not chunk:
                                break
                            body += chunk
                        devices = plistlib.loads(body).get("DeviceList") or []
                        if devices:
                            return True
            except Exception:
                pass
            time.sleep(0.5)
        logger.warning("关闭 QuickTime 后设备没有回到 usbmux（可能需重新插拔）")
        return False

    # ---------- 帧 ----------

    def latest_frame(self, timeout: float = 1.0) -> np.ndarray | None:
        if timeout > 0:
            self._frame_event.wait(timeout)
            self._frame_event.clear()
        with self._lock:
            return None if self._frame is None else self._frame.copy()

    @property
    def frame_id(self) -> int:
        return self._frame_id

    @property
    def fps(self) -> float:
        return self.stats.fps

    # ---------- USB 写 ----------

    def _send(self, packets: list[bytes]) -> None:
        device = self._device
        if device is None:
            return
        for packet in packets:
            device.write(QT_ENDPOINT_OUT, packet, timeout=1000)

    # ---------- 读线程 ----------

    def _read_loop(self) -> None:
        device = self._device
        if device is None:
            self.error = "USB 设备句柄丢失"
            return
        buffer = bytearray()
        while not self._stop.is_set():
            try:
                chunk = device.read(QT_ENDPOINT_IN, READ_SIZE, timeout=1500)
            except Exception as exc:
                message = str(exc)
                if "timeout" in message.lower() or "-116" in message:
                    stalled = (
                        self._session_ready.is_set()
                        and self.stats.last_frame_at
                        and time.monotonic() - self.stats.last_frame_at > STALL_SECONDS
                    )
                    if stalled:
                        self.error = "QuickTime 画面停滞（设备停止推流）"
                        return
                    continue
                self.error = f"QuickTime USB 读失败: {exc}"
                return
            if not chunk:
                continue
            buffer.extend(bytes(chunk))
            self._drain(buffer)

    def _drain(self, buffer: bytearray) -> None:
        """按 ``u32 长度`` 切包；USB 读边界和包边界无关，必须自己组包。"""
        while len(buffer) >= 8:
            total = struct.unpack_from("<I", buffer, 0)[0]
            if total < 8 or total > READ_SIZE:
                # 流错位了，丢掉一个字节能重新对齐
                del buffer[0]
                continue
            if len(buffer) < total:
                return
            packet = bytes(buffer[4:total])
            del buffer[:total]
            try:
                self._handle_packet(packet)
            except Exception as exc:
                logger.debug("处理 QT 包失败（忽略）: %s", exc)

    def _handle_packet(self, packet: bytes) -> None:
        self.stats.packets += 1
        if len(packet) < 8:
            return
        magic = struct.unpack_from("<I", packet, 0)[0]
        if magic == PING_MAGIC:
            self._send([make_ping()])
            return
        if magic == SYNC_MAGIC:
            self._handle_sync(packet)
            return
        if magic == ASYN_MAGIC:
            self._handle_async(packet)

    def _handle_sync(self, packet: bytes) -> None:
        if len(packet) < 24:
            return
        clock = struct.unpack_from("<Q", packet, 4)[0]
        subtype = struct.unpack_from("<I", packet, 12)[0]
        correlation = struct.unpack_from("<Q", packet, 16)[0]
        del clock
        if subtype == CWPA:
            device_clock = struct.unpack_from("<Q", packet, 24)[0] if len(packet) >= 32 else EMPTY_CFTYPE
            self._audio_clock = device_clock
            self._send(
                [
                    make_hpd1(self.display_size[0], self.display_size[1]),
                    make_reply(device_clock + 1000, correlation),
                    make_hpa1(device_clock),
                ]
            )
            return
        if subtype == CVRP:
            device_clock = struct.unpack_from("<Q", packet, 24)[0] if len(packet) >= 32 else EMPTY_CFTYPE
            self._video_clock = device_clock
            self._send([make_reply(device_clock + 2000, correlation), make_need(device_clock)])
            self._session_ready.set()
            return
        if subtype == STOP:
            self._send([make_reply(0, correlation)])
            return
        self._send([make_reply(EMPTY_CFTYPE, correlation)])

    def _handle_async(self, packet: bytes) -> None:
        if len(packet) < 20:
            return
        clock = struct.unpack_from("<Q", packet, 4)[0]
        subtype = struct.unpack_from("<I", packet, 16)[0]
        if subtype == FEED:
            # packet 已去掉 4 字节长度前缀：[0:4] magic, [4:12] clock, [12:16] 子类型
            sample = extract_sample_data(packet[16:])
            if sample:
                self.stats.bytes += len(sample)
                annexb = avcc_to_annexb(sample)
                if annexb:
                    with self._decode_lock:
                        # 解码跟不上就丢最旧的完整帧：宁可跳帧，也别越积越旧
                        if len(self._decode_queue) > 3:
                            self._decode_queue.pop(0)
                        self._decode_queue.append(annexb)
            self._send([make_need(self._video_clock or clock)])
            return
        if subtype == RELS:
            self._session_ready.clear()

    # ---------- 解码线程 ----------

    def _decode_loop(self) -> None:
        try:
            import av
        except Exception as exc:  # pragma: no cover - PyAV 是硬依赖
            self.error = f"缺少 PyAV（av）无法解码 H.264: {exc}"
            return
        try:
            context = av.codec.CodecContext.create("h264", "r")
        except Exception as exc:
            self.error = f"创建 H.264 解码器失败: {exc}"
            return
        pending_key = True
        while not self._stop.is_set():
            with self._decode_lock:
                item = self._decode_queue.pop(0) if self._decode_queue else None
            if item is None:
                if self._stop.wait(0.004):
                    break
                continue
            if not item:
                break
            types = _nal_types(item)
            is_key = 5 in types
            if pending_key and not is_key:
                continue  # 没有 IDR 之前解的帧都是花的
            try:
                frames = list(context.decode(av.Packet(item)))
            except Exception:
                pending_key = True
                continue
            if is_key:
                pending_key = False
                self.stats.keyframes += 1
            for frame in frames:
                try:
                    image = frame.to_ndarray(format="bgr24")
                except Exception:
                    continue
                self._publish(image)

    def _publish(self, image: np.ndarray) -> None:
        now = time.monotonic()
        with self._lock:
            self._frame = image
            self._frame_id += 1
            self.height, self.width = int(image.shape[0]), int(image.shape[1])
        self.stats.frames += 1
        self.stats.window_count += 1
        self.stats.last_frame_at = now
        elapsed = now - self.stats.window_start
        if elapsed >= 2.0:
            self.stats.fps = self.stats.window_count / elapsed
            self.stats.window_count = 0
            self.stats.window_start = now
        self._frame_event.set()
        self._first_frame.set()

