"""iOS 设备（QuickTime 采集 + pymobiledevice3 HID）。

没有 iPhone 也能验的部分都在这里：
- 版本门控（≥17.4）与设备列表解析（假的 pymobiledevice3）
- avfoundation 设备名解析（假的 ffmpeg 输出）
- **采集管线**：真的起 ffmpeg（用 lavfi 合成源代替 QuickTime）→ MJPEG → PyAV → ndarray
- 触摸坐标换算（归一化 → HID digitizer 0..65535）与相位映射
"""

from __future__ import annotations

import json
import shutil
import stat
from pathlib import Path

import pytest

from gamepilot.devices import ios, ios_usb, macos


def _fake_binary(directory: Path, name: str, body: str) -> str:
    """造一个可执行的假命令，用来替代 pymobiledevice3 / ffmpeg。"""
    path = directory / name
    path.write_text("#!/bin/sh\n" + body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


# ---------------------------------------------------------------- 版本门控


@pytest.mark.parametrize(
    ("version", "expected"),
    [("17.3", False), ("17.4", True), ("17.4.1", True), ("18.1", True), ("16.7", False), ("", False)],
)
def test_version_gate(version: str, expected: bool) -> None:
    assert ios.version_supported(version) is expected


# ---------------------------------------------------------------- 设备列表


def test_list_devices_parses_usbmux_json(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    payload = [
        {"Identifier": "00008110-001A2B3C4D5E", "DeviceName": "iPhone 15", "ProductVersion": "18.1"},
        {"Identifier": "00008101-00FFEEDDCCBB", "DeviceName": "老 iPhone", "ProductVersion": "16.7"},
        {"DeviceName": "坏数据，没有 udid"},
    ]
    binary = _fake_binary(tmp_path, "pymobiledevice3", f"echo '{json.dumps(payload)}'\n")
    monkeypatch.setattr(shutil, "which", lambda name: binary if name == "pymobiledevice3" else None)

    devices = ios.list_devices()
    assert [item.udid for item in devices] == ["00008110-001A2B3C4D5E", "00008101-00FFEEDDCCBB"]
    assert devices[0].supported() and not devices[1].supported()
    assert devices[0].uri == "iOS:///?udid=00008110-001A2B3C4D5E"


def test_discover_marks_unsupported_devices(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    payload = [{"Identifier": "A", "DeviceName": "iPhone 15", "ProductVersion": "18.1"}]
    binary = _fake_binary(tmp_path, "pymobiledevice3", f"echo '{json.dumps(payload)}'\n")
    monkeypatch.setattr(shutil, "which", lambda name: binary if name == "pymobiledevice3" else None)

    found = ios.discover()
    assert len(found) == 1
    assert found[0].id == "ios:A"
    assert found[0].status == "discovered"


def test_ios_uses_tunnel_capture_not_quicktime() -> None:
    """实测结论固化下来：不再有 ffmpeg/avfoundation 那条路（macOS 看不到 iPhone 采集设备）。"""
    assert not hasattr(ios, "find_capture_device")
    assert not hasattr(ios, "QuickTimeCapture")
    assert hasattr(ios, "TunnelSession"), "采集走隧道 + DVT 截图"


def test_no_pymobiledevice3_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shutil, "which", lambda name: None)
    assert ios.list_devices() == []
    assert ios.discover() == []


# ---------------------------------------------------------------- USB 配置测绘


def test_usb_configuration_paths_counted() -> None:
    """配置的"通路数"就是接口数：配置 2 只有 3 条、配置 6 有 11 条（实测机型）。"""
    config2 = ios_usb.UsbConfiguration(value=2, interfaces=[(0, 0, 0x06), (1, 0, 0x01), (1, 1, 0x01), (2, 0, 0x03)])
    # 同号接口的多个备用设置只算一条通路
    config6 = ios_usb.UsbConfiguration(
        value=6,
        interfaces=[(0, 0, 0x06), (1, 0, 0xFF), (2, 0, 0xFF), (2, 1, 0xFF), (2, 2, 0xFF), (3, 0, 0x02)],
    )
    assert config2.paths == 3
    assert config6.paths == 4, "接口号去重后 0/1/2/3 = 4 条通路"
    assert "配置 2：3 条通路" in config2.describe()


def test_usb_survey_without_device_is_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ios_usb, "_pyusb", lambda: None)
    assert ios_usb.survey() == []
    assert "没看到 Apple 设备" in ios_usb.ensure_configuration(2)


def test_usb_report_includes_current_configuration() -> None:
    device = ios_usb.AppleUsbDevice(
        bus=1,
        address=3,
        vendor=0x05AC,
        product=0x12A8,
        name="iPhone",
        current=6,
        configurations=[
            ios_usb.UsbConfiguration(value=2, interfaces=[(0, 0, 0x06)]),
            ios_usb.UsbConfiguration(value=6, interfaces=[(index, 0, 0xFF) for index in range(11)]),
        ],
    )
    text = device.describe()
    assert "当前配置：6" in text
    assert "配置 6：11 条通路" in text
    assert "← 当前" in text


# ---------------------------------------------------------------- 触摸换算


class FakeHid:
    """记录 HID 调用，不需要真机。"""

    def __init__(self) -> None:
        self.calls: list[tuple[str, int, int]] = []
        self.buttons: list[str] = []
        self.texts: list[str] = []
        self.connected = True

    def touch(self, phase: str, x: int, y: int) -> None:
        self.calls.append((phase, x, y))

    def press(self, name: str) -> None:
        self.buttons.append(name)

    def text(self, value: str) -> None:
        self.texts.append(value)

    def close(self) -> None:
        self.connected = False


def _controller_with_fake_hid() -> tuple[ios.IosController, FakeHid]:
    controller = ios.IosController(udid="UDID-TEST")
    fake = FakeHid()
    controller._hid = fake  # type: ignore[assignment]
    return controller, fake


def test_touch_maps_normalized_to_digitizer_units() -> None:
    controller, fake = _controller_with_fake_hid()

    controller.touch("down", 0.0, 1.0)
    controller.touch("move", 0.5, 0.5)
    controller.touch("up", 1.0, 0.0)

    assert fake.calls == [
        ("down", 0, 65535),
        ("move", 32768, 32768),
        ("up", 65535, 0),
    ], fake.calls


def test_touch_rejects_unknown_phase() -> None:
    controller, _ = _controller_with_fake_hid()
    with pytest.raises(ValueError, match="down/move/up"):
        controller.touch("fly", 0.5, 0.5)


def test_click_is_down_then_up() -> None:
    controller, fake = _controller_with_fake_hid()
    controller.click(0.25, 0.75)
    assert [item[0] for item in fake.calls] == ["down", "up"]
    assert fake.calls[0][1:] == (round(0.25 * 65535), round(0.75 * 65535))


def test_swipe_streams_moves() -> None:
    controller, fake = _controller_with_fake_hid()
    controller.swipe(0.1, 0.1, 0.9, 0.9, duration=0.1)

    phases = [item[0] for item in fake.calls]
    assert phases[0] == "down" and phases[-1] == "up"
    assert phases.count("move") >= 4, f"滑动要连续发 move（实时），实际 {phases}"
    assert fake.calls[-1][1:] == (round(0.9 * 65535), round(0.9 * 65535))


def test_press_and_text_go_through_hid() -> None:
    controller, fake = _controller_with_fake_hid()

    controller.press("home")
    controller.press("volume_up")
    controller.text("hello")

    assert fake.buttons == ["home", "volume_up"]
    assert fake.texts == ["hello"]

    with pytest.raises(ValueError, match="不支持"):
        controller.press("不存在")


def test_named_buttons_cover_android_keys() -> None:
    """脚本里用 back/recents 时 iOS 也要能跑（映射到 Home）。"""
    for name in ("home", "lock", "volume_up", "volume_down", "back", "recents"):
        assert name in ios.NAMED_BUTTONS


# ---------------------------------------------------------------- macOS 本机窗口


def test_macos_window_filtering_drops_chrome_and_tiny_windows() -> None:
    """窗口过滤是纯函数：菜单栏/层不为 0/太小的窗口不能当设备（依赖真实桌面没法测）。"""
    raw = [
        {
            "kCGWindowNumber": 1,
            "kCGWindowLayer": 0,
            "kCGWindowOwnerName": "访达",
            "kCGWindowName": "gamepilot",
            "kCGWindowOwnerPID": 100,
            "kCGWindowBounds": {"X": 10, "Y": 20, "Width": 800, "Height": 500},
        },
        {
            "kCGWindowNumber": 2,
            "kCGWindowLayer": 25,
            "kCGWindowOwnerName": "Window Server",
            "kCGWindowName": "菜单",
            "kCGWindowBounds": {"X": 0, "Y": 0, "Width": 2000, "Height": 40},
        },
        {
            "kCGWindowNumber": 3,
            "kCGWindowLayer": 0,
            "kCGWindowOwnerName": "提示",
            "kCGWindowName": "",
            "kCGWindowBounds": {"X": 0, "Y": 0, "Width": 80, "Height": 60},
        },
        {
            "kCGWindowNumber": 4,
            "kCGWindowLayer": 0,
            "kCGWindowOwnerName": "访达",
            "kCGWindowName": "gamepilot",
            "kCGWindowOwnerPID": 100,
            "kCGWindowBounds": {"X": 10, "Y": 20, "Width": 800, "Height": 500},
        },
    ]
    windows = macos.filter_windows(raw)
    assert [item.handle for item in windows] == [1], "只留普通层、够大、去重后的窗口"
    assert windows[0].label == "访达 — gamepilot"
    assert windows[0].to_dict()["uri"] == "Mac:///?window=1"


def test_macos_window_point_mapping() -> None:
    """归一化坐标 → 窗口内全局点坐标（CGEvent 用的就是屏幕点，Retina 不影响）。"""
    bounds = (820.0, 254.0, 920.0, 436.0)
    assert macos.window_point(bounds, 0.5, 0.5) == (1280.0, 472.0)
    assert macos.window_point(bounds, 0.0, 0.0) == (820.0, 254.0)
    assert macos.window_point(bounds, 1.0, 1.0) == (1740.0, 690.0)
    # 越界钳到边界，别点到别的窗口上去
    assert macos.window_point(bounds, -1.0, 2.0) == (820.0, 690.0)


def test_macos_controller_rejects_unknown_handle() -> None:
    """句柄不存在要明确报错，而不是随便抓一个窗口。"""
    if not macos.available():
        pytest.skip("非 macOS")
    controller = macos.MacWindowController(window="999999999")
    with pytest.raises(RuntimeError, match="没找到目标窗口"):
        controller.connect()


# ---------------------------------------------------------------- 横屏（旋转）


class _RecordingControl:
    """假的 scrcpy 控制通道：把发出去的字节记下来。"""

    def __init__(self) -> None:
        self.packets: list[bytes] = []

    def sendall(self, payload: bytes) -> None:
        self.packets.append(payload)


def _channel_with_canvas(size: tuple[int, int]) -> tuple[object, _RecordingControl]:
    from gamepilot.devices.scrcpy import ScrcpyChannel

    channel = ScrcpyChannel.__new__(ScrcpyChannel)  # 不跑 __init__：不需要真设备
    channel.video_size = size
    control = _RecordingControl()
    # 这里放的是假 socket：绕开真实类型标注
    object.__setattr__(channel, "_control", control)
    return channel, control


def test_touch_uses_current_canvas_size_after_rotation() -> None:
    """手机旋转后触摸必须按新画布换算 —— 用旧尺寸缩放就是"横屏点不准"的根因。"""
    import struct

    def decode(packet: bytes) -> tuple[int, int, int, int]:
        _, _, _, x, y, width, height, *_ = struct.unpack(">BBQIIHHHII", packet)
        return x, y, width, height

    # 竖屏 608x1280：归一化 (0.5, 0.5) → (303, 639)
    channel, control = _channel_with_canvas((608, 1280))
    channel.touch("down", 0.5, 0.5)  # type: ignore[attr-defined]
    x, y, width, height = decode(control.packets[-1])
    assert (width, height) == (608, 1280)
    assert (x, y) == (304, 640), "0.5*607=303.5、0.5*1279=639.5，Python round 取偶"

    # 旋转成横屏 1280x608 后，同样的归一化坐标要按新画布算
    channel.video_size = (1280, 608)  # type: ignore[attr-defined]
    channel.touch("down", 0.5, 0.5)  # type: ignore[attr-defined]
    x, y, width, height = decode(control.packets[-1])
    assert (width, height) == (1280, 608), "报文里的屏幕尺寸必须是当前画布"
    assert (x, y) == (640, 304), f"横屏换算错了: {(x, y)}"

    # 边界也要按当前画布钳制
    channel.touch("up", 1.0, 1.0)  # type: ignore[attr-defined]
    x, y, _, _ = decode(control.packets[-1])
    assert (x, y) == (1279, 607)
