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

from gamepilot.devices import ios


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


def test_no_pymobiledevice3_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shutil, "which", lambda name: None)
    assert ios.list_devices() == []
    assert ios.discover() == []


# ---------------------------------------------------------------- 采集设备名


def test_find_capture_device_picks_iphone(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    listing = """
[AVFoundation indev @ 0x7f] AVFoundation video devices:
[AVFoundation indev @ 0x7f] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f] [3] iPhone 屏幕
[AVFoundation indev @ 0x7f] AVFoundation audio devices:
[AVFoundation indev @ 0x7f] [0] MacBook Pro Microphone
"""
    binary = _fake_binary(tmp_path, "ffmpeg", f"cat <<'EOF' 1>&2\n{listing}\nEOF\n")
    monkeypatch.setattr(shutil, "which", lambda name: binary if name == "ffmpeg" else None)

    assert ios.find_capture_device(binary) == (3, "iPhone 屏幕")
    assert ios.find_capture_device(binary, name_hint="FaceTime") == (0, "FaceTime HD Camera")


def test_find_capture_device_returns_none_when_absent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    listing = "AVFoundation video devices:\n[0] FaceTime HD Camera\nAVFoundation audio devices:\n"
    binary = _fake_binary(tmp_path, "ffmpeg", f"cat <<'EOF' 1>&2\n{listing}\nEOF\n")
    assert ios.find_capture_device(binary) is None


# ---------------------------------------------------------------- 采集管线


def test_quicktime_capture_pipeline_decodes_frames() -> None:
    """真的跑一遍 ffmpeg → MJPEG → PyAV：用 lavfi 合成源代替 QuickTime 采集设备。"""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        pytest.skip("本机没有 ffmpeg")

    capture = ios.QuickTimeCapture(
        ffmpeg,
        0,
        fps=15,
        input_args=[
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=15",
            "-t",
            "5",
        ],
    )
    try:
        capture.start(timeout=15)
        assert capture.size == (320, 240), f"应该拿到合成源的分辨率，实际 {capture.size}"
        first = capture.latest_frame(timeout=2)
        assert first is not None and first.shape == (240, 320, 3)
        assert int(first.max()) > 0, "画面不该是全黑"
    finally:
        capture.close()


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
