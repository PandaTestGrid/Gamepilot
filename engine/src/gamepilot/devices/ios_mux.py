"""QuickTime 配置下的 USBMux 通道（0xFF/0xFE）。

切到隐藏 QT 配置后，Apple 的 Mobile Device Service 就不再管理这台设备（usbmux
里看不到它），因此 RSD 隧道 / HID 触摸会一起断掉。参考项目的做法是：**自己在
host 侧起一个 usbmuxd 兼容服务**，把 USB 上的 0xFE 接口包装成 ``127.0.0.1:<port>``，
再让 pymobiledevice3 通过 ``USBMUXD_SOCKET_ADDRESS`` 连过来。

线上格式（mux，全部大端）：

    proto u32 | length u32                     # v1 头
    proto u32 | length u32 | magic u32 | tx_seq u16 | rx_seq u16   # v2 头

``proto``：0=VERSION，1=CONTROL，2=SETUP，6=TCP。设备版本 ≥2 时每个包都带
``0xfeedface`` 和序号。TCP 负载是标准 20 字节 TCP 头 + 数据，窗口字段右移 8 位。

协商顺序：主机发 VERSION(2,0) → 设备回 VERSION → 主机发 SETUP(b"\x07") → 之后
每条连接 SYN → SYN|ACK → ACK，数据包带 ACK 标志，关闭用 RST。
"""

from __future__ import annotations

import contextlib
import logging
import os
import plistlib
import socket
import socketserver
import struct
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger("gamepilot.devices.ios_mux")

# ---- mux 协议常量
PROTO_VERSION = 0
PROTO_CONTROL = 1
PROTO_SETUP = 2
PROTO_TCP = 6
MUX_MAGIC = 0xFEEDFACE

TH_FIN = 0x01
TH_SYN = 0x02
TH_RST = 0x04
TH_PUSH = 0x08
TH_ACK = 0x10

USB_MTU = 3 * 16384
DEV_MRU = 65536
TCP_HDR_LEN = 20
TX_WINDOW = 131072

_TCPHDR = struct.Struct("!HHIIBBHHH")

# ---- usbmuxd 服务端（主机侧 plist 协议）
_UMX_HDR = struct.Struct("<IIII")
UMX_VERSION_PLIST = 1
UMX_MSG_RESULT = 1
UMX_MSG_PLIST = 8
UMX_RESULT_OK = 0
UMX_RESULT_BADCOMMAND = 1
UMX_RESULT_BADDEV = 2
UMX_RESULT_CONNREFUSED = 3

LOCKDOWN_PORT = 62078


class MuxError(RuntimeError):
    pass


class MuxConnectionRefusedError(MuxError):
    pass


def build_mux_packet(version: int, proto: int, payload: bytes, tx_seq: int = 0, rx_seq: int = 0) -> bytes:
    if version >= 2:
        total = 16 + len(payload)
        return struct.pack("!IIIHH", proto, total, MUX_MAGIC, tx_seq & 0xFFFF, rx_seq & 0xFFFF) + payload
    return struct.pack("!II", proto, 8 + len(payload)) + payload


def build_version_payload(major: int = 2, minor: int = 0) -> bytes:
    return struct.pack("!III", major, minor, 0)


def build_tcp(sport: int, dport: int, seq: int, ack: int, flags: int, win: int, data: bytes = b"") -> bytes:
    return _TCPHDR.pack(
        sport,
        dport,
        seq & 0xFFFFFFFF,
        ack & 0xFFFFFFFF,
        (TCP_HDR_LEN // 4) << 4,
        flags,
        (win >> 8) & 0xFFFF,
        0,
        0,
    ) + data


@dataclass
class TcpSegment:
    sport: int
    dport: int
    seq: int
    ack: int
    flags: int
    win: int
    payload: bytes


def parse_tcp(data: bytes) -> TcpSegment:
    if len(data) < TCP_HDR_LEN:
        raise MuxError("short tcp header")
    sport, dport, seq, ack, off, flags, win, _csum, _urp = _TCPHDR.unpack_from(data, 0)
    header_len = (off >> 4) * 4
    return TcpSegment(sport, dport, seq, ack, flags, win << 8, data[header_len:])


class PacketAssembler:
    """USB 读边界和包边界无关，必须自己按长度前缀组包。"""

    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, chunk: bytes) -> list[bytes]:
        self._buf.extend(chunk)
        out: list[bytes] = []
        while len(self._buf) >= 8:
            # v1 头：proto u32 | length u32
            length = struct.unpack_from("!I", self._buf, 4)[0]
            if length < 8 or length > DEV_MRU:
                del self._buf[0]
                continue
            if len(self._buf) < length:
                break
            out.append(bytes(self._buf[:length]))
            del self._buf[:length]
        return out


class MuxConnection:
    """一条 TCP-over-USB 连接。"""

    def __init__(self, mux: MuxDevice, sport: int, dport: int) -> None:
        self.mux = mux
        self.sport = sport
        self.dport = dport
        self.state = "connecting"
        self.tx_seq = 0
        self.tx_ack = 0
        self.rx_ack = 0
        self.rx_win = 0
        self.tx_win = TX_WINDOW
        self.max_payload = USB_MTU - 16 - TCP_HDR_LEN
        self._inbox = bytearray()
        self._cv = threading.Condition()
        self.closed = False
        self.refused = False
        self.close_reason = ""

    def _on_segment(self, seg: TcpSegment) -> None:
        forget = False
        with self._cv:
            self.rx_ack = seg.ack
            self.rx_win = seg.win
            if self.state == "connecting":
                if seg.flags == (TH_SYN | TH_ACK):
                    self.tx_seq += 1
                    self.tx_ack = seg.seq + 1
                    self.state = "connected"
                    self.mux._send_tcp(self, TH_ACK)
                else:
                    self.refused = bool(seg.flags & TH_RST)
                    self.state = "dead"
                    self.closed = True
                self._cv.notify_all()
                return
            if self.state == "connected":
                if seg.payload and not seg.flags & TH_RST:
                    self._inbox += seg.payload
                    self.tx_ack = seg.seq + len(seg.payload)
                    if not seg.flags & TH_FIN:
                        self.mux._send_tcp(self, TH_ACK)
                if seg.flags & (TH_RST | TH_FIN):
                    if seg.flags & TH_FIN:
                        self.tx_ack = seg.seq + len(seg.payload) + 1
                        with contextlib.suppress(Exception):
                            self.mux._send_tcp(self, TH_ACK)
                    self.close_reason = "device sent " + ("RST" if seg.flags & TH_RST else "FIN")
                    self.state = "dead"
                    self.closed = True
                    forget = True
                    self._cv.notify_all()
                else:
                    self._cv.notify_all()
        if forget:
            self.mux._forget(self)

    def wait_connected(self, timeout: float = 10.0) -> None:
        with self._cv:
            self._cv.wait_for(lambda: self.state != "connecting", timeout)
            if self.state != "connected":
                if self.close_reason:
                    raise MuxError(self.close_reason)
                raise MuxConnectionRefusedError(f"connect to device port {self.dport} failed")

    def _sendable(self) -> int:
        if self.closed:
            return -1
        inflight = (self.tx_seq - self.rx_ack) & 0xFFFFFFFF
        return max(0, min(self.rx_win - inflight, self.max_payload))

    def send(self, data: bytes, timeout: float = 30.0) -> None:
        view = memoryview(data)
        off = 0
        while off < len(view):
            with self._cv:
                if not self._cv.wait_for(lambda: self._sendable() != 0, timeout):
                    raise MuxError("send window stalled")
                n = self._sendable()
                if n < 0:
                    raise MuxError(f"connection closed ({self.close_reason or 'by host'})")
                chunk = bytes(view[off : off + n])
                self.mux._send_tcp(self, TH_ACK, chunk)
                self.tx_seq += len(chunk)
            off += len(chunk)

    def recv(self, max_bytes: int = 65536, timeout: float | None = None) -> bytes:
        with self._cv:
            self._cv.wait_for(lambda: self._inbox or self.closed, timeout)
            if not self._inbox:
                return b""
            out = bytes(self._inbox[:max_bytes])
            del self._inbox[:max_bytes]
            return out

    def close(self) -> None:
        with self._cv:
            if not self.closed:
                self.closed = True
                if self.state == "connected":
                    with contextlib.suppress(Exception):
                        self.mux._send_tcp(self, TH_RST)
                self.state = "dead"
                self._cv.notify_all()
        self.mux._forget(self)


class MuxDevice:
    """一台设备的 mux 会话：写由 USB 传输注入，读线程调用 ``feed``。"""

    def __init__(self, write: Callable[[bytes], None], wmax_packet: int = 512, serial: str = "") -> None:
        self._write_raw = write
        self.wmax = wmax_packet
        self.serial = serial
        self.version = 0
        self.tx_seq = 0
        self.rx_seq = 0
        self.ready = threading.Event()
        self._lock = threading.RLock()
        self._conns: dict[int, MuxConnection] = {}
        self._next_sport = 1
        self._failure: str | None = None
        self._assembler = PacketAssembler()
        self.on_control: Callable[[bytes], None] | None = None

    # ---- 发送
    def _send_packet(self, proto: int, payload: bytes) -> None:
        with self._lock:
            if self._failure is not None:
                raise MuxError(self._failure)
            if self.version >= 2:
                if proto == PROTO_SETUP:
                    self.tx_seq, self.rx_seq = 0, 0xFFFF
                pkt = build_mux_packet(2, proto, payload, self.tx_seq, self.rx_seq)
                self.tx_seq = (self.tx_seq + 1) & 0xFFFF
            else:
                pkt = build_mux_packet(1, proto, payload)
            if len(pkt) > USB_MTU:
                raise MuxError("packet exceeds USB_MTU")
            self._write_raw(pkt)
            if len(pkt) % self.wmax == 0:
                # 长度刚好是包大小整数倍时必须补零长包
                with contextlib.suppress(Exception):
                    self._write_raw(b"")

    def _send_tcp(self, conn: MuxConnection, flags: int, data: bytes = b"") -> None:
        self._send_packet(PROTO_TCP, build_tcp(conn.sport, conn.dport, conn.tx_seq, conn.tx_ack, flags, conn.tx_win, data))

    def start(self) -> None:
        self._send_packet(PROTO_VERSION, build_version_payload(2, 0))

    # ---- 接收
    def feed(self, chunk: bytes) -> None:
        for pkt in self._assembler.feed(chunk):
            self._handle_packet(pkt)

    def _handle_packet(self, pkt: bytes) -> None:
        proto, _length = struct.unpack_from("!II", pkt, 0)
        if self.version >= 2:
            if len(pkt) < 16:
                return
            _magic, _tx, rx = struct.unpack_from("!IHH", pkt, 8)
            self.rx_seq = rx
            body = pkt[16:]
        else:
            body = pkt[8:]
        if proto == PROTO_VERSION:
            major, minor, _ = struct.unpack_from("!III", body, 0)
            if major not in (1, 2):
                raise MuxError(f"unsupported device mux version {major}")
            self.version = major
            logger.info("mux 握手完成：设备版本 %d.%d", major, minor)
            if major >= 2:
                self._send_packet(PROTO_SETUP, b"\x07")
            self.ready.set()
        elif proto == PROTO_CONTROL:
            if self.on_control:
                self.on_control(body)
        elif proto == PROTO_TCP:
            seg = parse_tcp(body)
            conn = self._conns.get(seg.dport)
            if conn is None or conn.sport != seg.dport or conn.dport != seg.sport:
                if not seg.flags & TH_RST:
                    with contextlib.suppress(Exception):
                        self._send_packet(
                            PROTO_TCP, build_tcp(seg.dport, seg.sport, 0, seg.seq, TH_RST, 0)
                        )
                return
            conn._on_segment(seg)

    # ---- 连接
    def connect(self, dport: int, timeout: float = 10.0) -> MuxConnection:
        if not self.ready.wait(timeout):
            raise MuxError("mux 版本握手未完成")
        with self._lock:
            while self._next_sport in self._conns or self._next_sport == 0:
                self._next_sport = (self._next_sport + 1) & 0xFFFF
            sport = self._next_sport
            self._next_sport = (self._next_sport + 1) & 0xFFFF
            conn = MuxConnection(self, sport, dport)
            self._conns[sport] = conn
        try:
            self._send_tcp(conn, TH_SYN)
            conn.wait_connected(timeout)
        except Exception:
            conn.close()
            raise
        return conn

    def _forget(self, conn: MuxConnection) -> None:
        with self._lock:
            if self._conns.get(conn.sport) is conn:
                del self._conns[conn.sport]

# --------------------------------------------------------------------------- usbmuxd 兼容服务
def _pair_record_dir() -> Path:
    """Apple 服务保存配对记录的目录（Windows）。"""
    if os.name == "nt":
        return Path(os.environ.get("ALLUSERSPROFILE", r"C:\ProgramData"), "Apple", "Lockdown")
    return Path("/var/lib/lockdown")


def _system_buid() -> str:
    path = _pair_record_dir() / "SystemConfiguration.plist"
    try:
        value = plistlib.loads(path.read_bytes()).get("SystemBUID")
        if value:
            return str(value)
    except Exception:
        pass
    return "30142955-444094379208051516"


class _UsbmuxdHandler(socketserver.BaseRequestHandler):
    """一条 host 连接：先按 plist 协议握手，Connect 成功后转成裸字节转发。"""

    server: _UsbmuxdServer

    def handle(self) -> None:
        sock: socket.socket = self.request
        try:
            while True:
                tag, message = self._read_frame(sock)
                if message is None:
                    return
                kind = message.get("MessageType")
                if kind == "ReadBUID":
                    self._send(sock, tag, {"BUID": self.server.buid})
                elif kind == "ListDevices":
                    self._send(
                        sock,
                        tag,
                        {
                            "DeviceList": [
                                {
                                    "DeviceID": self.server.device_id,
                                    "MessageType": "Attached",
                                    "Properties": {
                                        "ConnectionType": "USB",
                                        "DeviceID": self.server.device_id,
                                        "LocationID": 0,
                                        "ProductID": 0x12A8,
                                        "SerialNumber": self.server.serial,
                                    },
                                }
                            ]
                        },
                    )
                elif kind == "Listen":
                    self._send(sock, tag, {"DeviceID": self.server.device_id, "MessageType": "Attached",
                                           "Properties": {"ConnectionType": "USB", "DeviceID": self.server.device_id,
                                                          "SerialNumber": self.server.serial}})
                elif kind == "ReadPairRecord":
                    record = self.server.pair_record(message.get("PairRecordID") or self.server.serial)
                    if record is None:
                        # pymobiledevice3 只读 PairRecordData 字段，缺失就判 NotPairedError
                        self._send(sock, tag, {"MessageType": "Result", "Number": UMX_RESULT_BADDEV})
                        continue
                    self._send(sock, tag, {"PairRecordData": record})
                elif kind == "Connect":
                    # usbmuxd 的 PortNumber 是网络字节序（pymobiledevice3 发的是
                    # socket.htons(62078)），这里必须转回主机序再交给 mux。
                    raw_port = int(message.get("PortNumber") or 0)
                    port = socket.ntohs(raw_port & 0xFFFF)
                    self._send(sock, tag, {"MessageType": "Result", "Number": UMX_RESULT_OK})
                    self._bridge(sock, port)
                    return
                else:
                    self._send(sock, tag, {"MessageType": "Result", "Number": UMX_RESULT_BADCOMMAND})
        except (ConnectionError, OSError):
            return
        finally:
            with contextlib.suppress(Exception):
                sock.close()

    # ---- 帧
    def _read_frame(self, sock: socket.socket) -> tuple[int, dict[str, Any] | None]:
        header = self._recv_exact(sock, 16)
        if header is None:
            return 0, None
        length, _version, message, tag = _UMX_HDR.unpack(header)
        if length < 16 or length > (1 << 20) or message != UMX_MSG_PLIST:
            return 0, None
        body = self._recv_exact(sock, length - 16)
        if body is None:
            return 0, None
        return tag, plistlib.loads(body)

    @staticmethod
    def _recv_exact(sock: socket.socket, size: int) -> bytes | None:
        data = b""
        while len(data) < size:
            chunk = sock.recv(size - len(data))
            if not chunk:
                return None
            data += chunk
        return data

    def _send(self, sock: socket.socket, tag: int, payload: dict[str, Any]) -> None:
        body = plistlib.dumps(payload)
        sock.sendall(_UMX_HDR.pack(16 + len(body), UMX_VERSION_PLIST, UMX_MSG_PLIST, tag) + body)

    # ---- 设备端口转发
    def _bridge(self, sock: socket.socket, port: int) -> None:
        try:
            conn = self.server.mux.connect(port, timeout=15.0)
        except Exception as exc:
            logger.warning("mux 连接设备端口 %d 失败: %s", port, exc)
            return
        logger.info("mux 已连上设备端口 %d（sport=%d）", port, conn.sport)
        upstream_done = threading.Event()

        def pump_upstream() -> None:
            try:
                while True:
                    data = conn.recv(65536, timeout=30.0)
                    if not data:
                        break
                    sock.sendall(data)
            except Exception:
                pass
            finally:
                upstream_done.set()
                with contextlib.suppress(Exception):
                    sock.shutdown(socket.SHUT_RDWR)

        threading.Thread(target=pump_upstream, name="mux-upstream", daemon=True).start()
        try:
            while not upstream_done.is_set():
                chunk = sock.recv(65536)
                if not chunk:
                    break
                conn.send(chunk)
        except Exception:
            pass
        finally:
            conn.close()


class _UsbmuxdServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, mux: MuxDevice, serial: str, *, pair_record: bytes | None = None) -> None:
        super().__init__(("127.0.0.1", 0), _UsbmuxdHandler)
        self.mux = mux
        self.serial = serial
        self.device_id = 1
        self.buid = _system_buid()
        self._pair_record = pair_record

    def pair_record(self, serial: str) -> bytes | None:
        """读 Apple 的配对记录；文件名可能是带横线的 UDID，也可能是纯十六进制。"""
        if self._pair_record is not None:
            return self._pair_record
        base = _pair_record_dir()
        # 00008150000E348811C0401C -> 00008150-000E348811C0401C
        hyphenated = serial
        if "-" not in serial and len(serial) >= 16:
            hyphenated = f"{serial[:8]}-{serial[8:]}"
        for name in (serial, hyphenated, serial.replace("-", "")):
            try:
                return (base / f"{name}.plist").read_bytes()
            except Exception:
                continue
        logger.warning("找不到配对记录 %s（%s）", serial, base)
        return None

    @property
    def address(self) -> str:
        host, port = self.server_address[:2]
        return f"{host!s}:{port}"


class MuxBridge:
    """把 QT 配置里的 0xFE 接口暴露成 ``127.0.0.1:<port>`` 的 usbmuxd。"""

    ENV = "USBMUXD_SOCKET_ADDRESS"

    def __init__(self, udid: str = "") -> None:
        self.udid = udid
        self.device: Any = None
        self.mux: MuxDevice | None = None
        self.server: _UsbmuxdServer | None = None
        self.address: str | None = None
        self.error: str | None = None
        self._stop = threading.Event()
        self._reader: threading.Thread | None = None
        self._prev_env: str | None = None
        self._iface = -1

    # ---- 生命周期
    def start(self, timeout: float = 15.0) -> str:
        """在已激活 QT 配置的设备上启动 mux 桥，返回 ``host:port``。"""
        import usb.backend.libusb0 as libusb0
        import usb.core
        import usb.util

        device = usb.core.find(idVendor=0x05AC, backend=libusb0.get_backend())
        if device is None:
            raise MuxError("libusb0 找不到 Apple 设备")
        try:
            config = device.get_active_configuration()
        except Exception:
            config = None
        if config is None:
            raise MuxError("设备没有激活的 USB 配置")
        # libusb0 只认自己设置过的配置；不显式 SET_CONFIGURATION 会报
        # "invalid configuration 0"（即使设备本身已在该配置上）。
        try:
            device.set_configuration(config.bConfigurationValue)
        except Exception as exc:
            logger.debug("set_configuration(%s) 失败: %s", config.bConfigurationValue, exc)
        iface = next(
            (i for i in config if i.bInterfaceClass == 0xFF and i.bInterfaceSubClass == 0xFE),
            None,
        )
        if iface is None:
            raise MuxError("当前 USB 配置里没有 USBMux 接口（0xFF/0xFE）")
        try:
            usb.util.claim_interface(device, iface.bInterfaceNumber)
        except Exception:
            device.set_configuration(config.bConfigurationValue)
            time.sleep(0.3)
            usb.util.claim_interface(device, iface.bInterfaceNumber)
        self.device = device
        self._iface = iface.bInterfaceNumber

        ep_in = usb.util.find_descriptor(
            iface, custom_match=lambda e: usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_IN
        )
        ep_out = usb.util.find_descriptor(
            iface, custom_match=lambda e: usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_OUT
        )
        if ep_in is None or ep_out is None:
            raise MuxError("USBMux 接口缺少 bulk 端点")

        def write_raw(payload: bytes) -> None:
            ep_out.write(payload, timeout=2000)

        self.mux = MuxDevice(write_raw, wmax_packet=512, serial=self.udid)
        self.mux.start()

        def reader() -> None:
            while not self._stop.is_set():
                try:
                    chunk = bytes(ep_in.read(1 << 16, timeout=800))
                except Exception as exc:
                    message = str(exc).lower()
                    if "timeout" in message:
                        continue
                    self.error = f"mux 读取失败: {exc}"
                    return
                if chunk and self.mux is not None:
                    try:
                        self.mux.feed(chunk)
                    except Exception as exc:
                        self.error = f"mux 解析失败: {exc}"
                        return

        self._reader = threading.Thread(target=reader, name="ios-mux-reader", daemon=True)
        self._reader.start()

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.mux.ready.is_set():
                break
            time.sleep(0.05)
        else:
            raise MuxError("mux 版本握手超时")

        self.server = _UsbmuxdServer(self.mux, self.udid)
        threading.Thread(target=self.server.serve_forever, name="ios-usbmuxd", daemon=True).start()
        self.address = self.server.address
        self._prev_env = os.environ.get(self.ENV)
        os.environ[self.ENV] = self.address
        logger.info("mux 桥已就绪：%s=%s", self.ENV, self.address)
        return self.address

    def stop(self) -> None:
        self._stop.set()
        if self._prev_env is None:
            os.environ.pop(self.ENV, None)
        else:
            os.environ[self.ENV] = self._prev_env
        if self.server is not None:
            with contextlib.suppress(Exception):
                self.server.shutdown()
            with contextlib.suppress(Exception):
                self.server.server_close()
            self.server = None
        if self._reader is not None:
            self._reader.join(timeout=2.0)
            self._reader = None
        if self.device is not None:
            with contextlib.suppress(Exception):
                import usb.util

                usb.util.release_interface(self.device, self._iface)
            self.device = None
        self.address = None
        logger.info("mux 桥已关闭")

    @property
    def alive(self) -> bool:
        return self._reader is not None and self._reader.is_alive() and self.error is None
