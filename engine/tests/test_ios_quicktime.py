"""QuickTime 协议层的纯逻辑测试（不需要真机）。"""
from __future__ import annotations

import struct

from gamepilot.devices import ios_qt


def test_ping_matches_protocol_sample() -> None:
    # 文档里的抓包样例：10 00 00 00 | 67 6e 69 70 | 00 00 00 00 | 01 00 00 00
    assert ios_qt.make_ping().hex() == "10000000676e69700000000001000000"


def test_reply_has_correlation_and_clock() -> None:
    packet = ios_qt.make_reply(0xABCD, 0x1234)
    total, magic, corr, zero, clock = struct.unpack("<IIQI Q".replace(" ", ""), packet)
    assert total == 28
    assert magic == ios_qt.RPLY_MAGIC
    assert corr == 0x1234
    assert zero == 0
    assert clock == 0xABCD


def test_need_packet_layout() -> None:
    packet = ios_qt.make_need(0x99)
    total, magic, clock, subtype = struct.unpack("<IIQI", packet)
    assert total == 20
    assert magic == ios_qt.ASYN_MAGIC
    assert clock == 0x99
    assert subtype == ios_qt.NEED


def test_hpd1_is_well_formed_dict() -> None:
    packet = ios_qt.make_hpd1(1206.0, 2622.0)
    total = struct.unpack_from("<I", packet, 0)[0]
    assert total == len(packet)
    assert struct.unpack_from("<I", packet, 4)[0] == ios_qt.ASYN_MAGIC
    assert struct.unpack_from("<I", packet, 16)[0] == ios_qt.HPD1


def test_avcc_to_annexb_roundtrip() -> None:
    nalu1 = b"\x65" + b"\x11" * 9
    nalu2 = b"\x41" + b"\x22" * 5
    avcc = struct.pack(">I", len(nalu1)) + nalu1 + struct.pack(">I", len(nalu2)) + nalu2
    annexb = ios_qt.avcc_to_annexb(avcc)
    assert annexb == b"\x00\x00\x00\x01" + nalu1 + b"\x00\x00\x00\x01" + nalu2
    assert ios_qt._nal_types(annexb) == [5, 1]


def test_extract_sample_data_walks_entries() -> None:
    sdat = b"\xAA\xBB\xCC"
    entry = struct.pack("<I", len(sdat) + 8) + struct.pack("<I", ios_qt.SBUF_SDAT) + sdat
    body = entry
    sbuf = struct.pack("<I", len(body) + 8) + struct.pack("<I", ios_qt.SAMPLE_BUFFER) + body
    assert ios_qt.extract_sample_data(sbuf) == sdat


def test_extract_sample_data_rejects_garbage() -> None:
    assert ios_qt.extract_sample_data(b"") is None
    assert ios_qt.extract_sample_data(b"\x00\x00\x00\x00xxxx") is None
    assert ios_qt.extract_sample_data(b"\xff\xff\xff\xff" + b"sbuf") is None


def test_stop_packets_order() -> None:
    packets = ios_qt.make_stop_packets(0x1234)
    assert struct.unpack_from("<I", packets[0], 16)[0] == ios_qt.HPA0   # 先停音频
    assert struct.unpack_from("<I", packets[1], 16)[0] == ios_qt.HPD0   # 再停视频
