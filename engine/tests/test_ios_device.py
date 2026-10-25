"""iOS 设备（QuickTime 采集 + pymobiledevice3 HID）。

没有 iPhone 也能验的部分都在这里：
- 版本门控（≥17.4）与设备列表解析（假的 pymobiledevice3）
- avfoundation 设备名解析（假的 ffmpeg 输出）
- **采集管线**：真的起 ffmpeg（用 lavfi 合成源代替 QuickTime）→ MJPEG → PyAV → ndarray
- 触摸坐标换算（归一化 → HID digitizer 0..65535）与相位映射
"""

from __future__ import annotations

import os
import stat
import time
import types
from pathlib import Path

import pytest

from gamepilot.devices import ios, ios_usb, macos


def _echo_binary(directory: Path, name: str, text: str) -> str:
    """造一个"只会把 text 打到 stdout"的假命令，用来替代 pymobiledevice3。

    Windows 跑不了 `#!/bin/sh` 脚本（CreateProcess 报"不是有效的 Win32 程序"），
    那边写 `.cmd` —— 两边做的还是同一件事，所以子进程那一圈是真的在跑。
    `text` 必须是 ASCII（JSON 用 `ensure_ascii=True` 生成即可）。
    """
    if os.name == "nt":
        path = directory / f"{name}.cmd"
        path.write_text(f"@echo off\necho {text}\n", encoding="utf-8")
        return str(path)
    path = directory / name
    path.write_text(f"#!/bin/sh\necho '{text}'\n", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


# ---------------------------------------------------------------- 版本门控


@pytest.mark.parametrize(
    ("version", "expected"),
    [("17.3", False), ("17.4", True), ("17.4.1", True), ("18.1", True), ("16.7", False), ("26.6", True)],
)
def test_version_gate(version: str, expected: bool) -> None:
    assert ios.version_supported(version) is expected


def test_unknown_version_is_not_treated_as_old() -> None:
    """读不到版本 ≠ 版本太低。

    以前空版本会被判成"只支持 17.4+"，把真正的连接失败（隧道残留）盖掉；
    现在未知版本放行，交给建隧道那一步给出准确原因。
    """
    assert ios.version_known("") is False
    assert ios.version_supported("") is True
    assert ios.version_supported("  ") is True


# ---------------------------------------------------------------- 设备列表


def test_list_devices_uses_in_process_usbmux(monkeypatch: pytest.MonkeyPatch) -> None:
    """冻结包里不能再起 `python -m pymobiledevice3`：直接走库的 usbmux 客户端。"""

    class Lockdown:
        def __init__(self) -> None:
            self.short_info = {"DeviceName": "iPhone 15", "ProductVersion": "18.1"}

        async def close(self) -> None:
            return None

    async def devices() -> list[object]:
        return [types.SimpleNamespace(serial="00008110-001A2B3C4D5E", connection_type="USB")]

    async def lockdown(*_args: object, **_kwargs: object) -> Lockdown:
        return Lockdown()

    import pymobiledevice3
    import pymobiledevice3.lockdown

    monkeypatch.setattr(pymobiledevice3.usbmux, "list_devices", devices)
    monkeypatch.setattr(pymobiledevice3.lockdown, "create_using_usbmux", lockdown)

    found = ios.list_devices()
    assert [item.udid for item in found] == ["00008110-001A2B3C4D5E"]
    assert found[0].name == "iPhone 15"
    assert found[0].version == "18.1"


def test_discover_marks_unsupported_devices(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ios, "list_devices", lambda: [ios.IosDevice(udid="A", name="iPhone 15", version="18.1")])

    monkeypatch.setattr(ios, "screen_size", lambda udid: (1170, 2532))

    found = ios.discover()
    assert len(found) == 1
    assert found[0].id == "ios:A"
    assert found[0].status == "discovered"
    # 发现在线设备时就带上分辨率（用户反馈："iOS 设备没有看到设备分辨率"）
    assert found[0].resolution == (1170, 2532)


def test_discover_skips_resolution_probe_for_unsupported_versions(monkeypatch: pytest.MonkeyPatch) -> None:
    """不达标的系统（<17.4）连不上，没必要为它去开 lockdown 会话。"""
    monkeypatch.setattr(ios, "list_devices", lambda: [ios.IosDevice(udid="OLD", name="老 iPhone", version="16.7")])
    probed: list[str] = []

    def fake_screen_size(udid: str) -> tuple[int, int] | None:
        probed.append(udid)
        return None

    monkeypatch.setattr(ios, "screen_size", fake_screen_size)

    found = ios.discover()

    assert found[0].status == "failed"
    assert found[0].resolution is None
    assert probed == []


# ---------------------------------------------------------------- 屏幕尺寸


def test_screen_size_reads_pixels_from_itunes_domain(monkeypatch: pytest.MonkeyPatch) -> None:
    """`com.apple.mobile.iTunes` 的 ScreenWidth/ScreenHeight 是**像素**（1170×2532 = iPhone 13 Pro）。"""
    monkeypatch.setattr(ios, "_SCREEN_SIZE_CACHE", {})
    calls: list[str] = []

    async def fake(udid: str) -> tuple[int, int] | None:
        calls.append(udid)
        return (1170, 2532)

    monkeypatch.setattr(ios, "_read_screen_size", fake)

    assert ios.screen_size("UDID-1") == (1170, 2532)
    assert ios.screen_size("UDID-1") == (1170, 2532)  # 第二次走缓存
    assert calls == ["UDID-1"], "一次扫描只该开一条 lockdown 会话"


def test_screen_size_failure_is_none_not_an_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    """没配对 / 隧道被占：返回 None（列表照常出现、那一格显示 —），不能让扫描挂掉。"""
    monkeypatch.setattr(ios, "_SCREEN_SIZE_CACHE", {})

    async def boom(udid: str) -> tuple[int, int] | None:
        raise RuntimeError("设备没配对")

    monkeypatch.setattr(ios, "_read_screen_size", boom)

    assert ios.screen_size("UDID-2") is None


def test_screen_size_without_the_keys_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ios, "_SCREEN_SIZE_CACHE", {})

    async def empty(udid: str) -> tuple[int, int] | None:
        return None

    monkeypatch.setattr(ios, "_read_screen_size", empty)

    assert ios.screen_size("UDID-3") is None


def test_ios_defaults_to_tunnel_capture() -> None:
    """默认采集走 DVT 截图；QuickTime 码流是显式开启的可选通道。

    QuickTime 要切私有的 USB 配置，失败时会把设备从 usbmux 拉下线，
    所以默认必须是能用、能降级的那条路。
    """
    assert not hasattr(ios, "find_capture_device"), "不再走 macOS ffmpeg/avfoundation"
    assert hasattr(ios, "TunnelSession"), "采集走隧道 + DVT 截图"
    assert hasattr(ios, "QuickTimeCapture"), "码流通道已实现，但需显式开启"

    ctrl = ios.IosController(udid="UDID-X")
    assert ctrl._qt_enabled is False


# ---------------------------------------------------------------- 进程级隧道额度


def test_second_ios_device_is_refused_with_the_owner_named(monkeypatch: pytest.MonkeyPatch) -> None:
    """用户态隧道是进程级单例：第二台 iPhone 要在碰隧道**之前**给出人话原因，
    而不是把 pymobiledevice3 的英文异常糊到界面上。"""
    previous = ios._TUNNEL_SLOT
    ios._TUNNEL_SLOT = ("UDID-A", "iPhone A (iOS 26.6)")
    monkeypatch.setattr(ios, "list_devices", lambda: [ios.IosDevice(udid="UDID-B", name="iPhone B", version="26.6")])
    try:
        with pytest.raises(RuntimeError, match="先断开「iPhone A"):
            ios.IosController(udid="UDID-B").connect()
        assert ios._TUNNEL_SLOT == ("UDID-A", "iPhone A (iOS 26.6)"), "额度不该被抢走"
    finally:
        ios._TUNNEL_SLOT = previous


def test_ios_connect_releases_the_slot_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """连到一半失败（比如 HID 服务不可用）必须把额度还回去，否则这台设备再也连不上。"""
    previous = ios._TUNNEL_SLOT
    ios._TUNNEL_SLOT = None
    monkeypatch.setattr(ios, "list_devices", lambda: [ios.IosDevice(udid="UDID-C", name="iPhone C", version="26.6")])
    monkeypatch.setattr(ios.IosController, "_report_usb_config", lambda self: None)

    class BoomSession:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            raise RuntimeError("隧道炸了")

    monkeypatch.setattr(ios, "TunnelSession", BoomSession)
    try:
        with pytest.raises(RuntimeError, match="隧道炸了"):
            ios.IosController(udid="UDID-C").connect()
        assert ios._TUNNEL_SLOT is None, "失败后必须把额度还回去"
    finally:
        ios._TUNNEL_SLOT = previous


def test_ios_connect_closes_the_partial_tunnel_when_start_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """`start()` 半路失败（没出帧/超时）必须把半开的隧道收掉。

    以前要等 `start()` 成功才把 session 挂到 controller 上；失败时这个半开的隧道
    根本没机会 `close()`，就留在 pymobiledevice3 的进程级单例里 —— 下一次连接
    才会看到 "a userspace tunnel is already active in this process"。
    """
    previous = ios._TUNNEL_SLOT
    ios._TUNNEL_SLOT = None
    monkeypatch.setattr(ios, "list_devices", lambda: [ios.IosDevice(udid="UDID-D", name="iPhone D", version="26.6")])
    monkeypatch.setattr(ios.IosController, "_report_usb_config", lambda self: None)

    class HalfOpenSession:
        def __init__(self, *_args: object, **kwargs: object) -> None:
            self.udid = "UDID-D"
            self.name = kwargs.get("name", "")
            self.size = (0, 0)
            self.error = None
            self.closed = False
            sessions.append(self)

        def start(self, timeout: float = 25.0) -> None:
            raise RuntimeError("iOS 采集没有出帧: 测试")

        def close(self) -> None:
            self.closed = True

    sessions: list[HalfOpenSession] = []
    monkeypatch.setattr(ios, "TunnelSession", HalfOpenSession)
    try:
        with pytest.raises(RuntimeError, match="没有出帧"):
            ios.IosController(udid="UDID-D").connect()
        assert sessions, "应该建过一条会话"
        session = sessions[0]
        assert session.closed is True, "start 失败的半开隧道必须被 close"
        assert session.name == "iPhone D (iOS 26.6)", "报错信息要用人类可读的设备名"
        assert ios._TUNNEL_SLOT is None, "失败后额度也要还回去"
    finally:
        ios._TUNNEL_SLOT = previous


def test_tunnel_start_cleans_up_and_translates_the_singleton_error() -> None:
    """库里的英文单例异常宁可翻成人话，也不能糊到界面上；失败时循环/会话都要收干净。"""
    raw = (
        "a userspace tunnel is already active in this process (PyTCP's stack is a "
        "process-global singleton; only one userspace tunnel per process is supported)"
    )
    session = ios.TunnelSession("UDID-E", name="iPhone E")

    async def boom() -> None:
        raise RuntimeError(raw)

    session._astart = boom  # type: ignore[method-assign]
    try:
        with pytest.raises(RuntimeError, match="同时只能带一台 iPhone") as info:
            session.start(timeout=3)
        assert raw not in str(info.value)
    finally:
        session.close()
    assert session._loop is None, "失败后事件循环线程要停掉"
    assert ios._LIVE_SESSION is None, "失败后不能还挂着'谁握着隧道'"


def test_claim_tunnel_slot_reports_a_stale_library_tunnel(monkeypatch: pytest.MonkeyPatch) -> None:
    """额度还了、库里的隧道却还活着：给「先断开/重启」的人话，别让英文异常上去。"""
    previous = ios._TUNNEL_SLOT
    ios._TUNNEL_SLOT = None
    monkeypatch.setattr(ios, "_userspace_tunnel_active", lambda: True)
    monkeypatch.setattr(ios, "_wait_userspace_released", lambda _timeout: False)
    try:
        with pytest.raises(RuntimeError, match="还留着上一次"):
            ios._claim_tunnel_slot("UDID-F", "iPhone F")
        assert ios._TUNNEL_SLOT is None, "报错时不能占额度"
    finally:
        ios._TUNNEL_SLOT = previous


def test_claim_tunnel_slot_allows_handover_for_the_same_device(monkeypatch: pytest.MonkeyPatch) -> None:
    """同一台设备的残留交给 TunnelSession.start() 接管，不能在额度这一层就被挡下。"""
    previous_slot = ios._TUNNEL_SLOT
    previous_live = ios._LIVE_SESSION
    ios._TUNNEL_SLOT = ("UDID-G", "iPhone G")
    ios._LIVE_SESSION = ios.TunnelSession("UDID-G", name="iPhone G")  # 只当"谁握着隧道"的句柄
    monkeypatch.setattr(ios, "_userspace_tunnel_active", lambda: True)
    monkeypatch.setattr(ios, "_wait_userspace_released", lambda _timeout: False)
    try:
        ios._claim_tunnel_slot("UDID-G", "iPhone G")
        assert ios._TUNNEL_SLOT == ("UDID-G", "iPhone G")
    finally:
        ios._TUNNEL_SLOT = previous_slot
        ios._LIVE_SESSION = previous_live


def test_tunnel_close_releases_the_tunnel_handle_and_its_loop() -> None:
    """close() 真的要在隧道自己的事件循环里 aclose()，不能只是把线程停掉。"""
    session = ios.TunnelSession("UDID-H", name="iPhone H")
    closed: list[str] = []

    class FakeTunnel:
        serial = "UDID-H"

        async def aclose(self) -> None:
            closed.append(self.serial)

    session._tunnel = FakeTunnel()
    ios._set_live_session(session)
    session._ensure_loop()
    session.close()

    assert closed == ["UDID-H"]
    assert session._loop is None and session._thread is None
    assert ios._LIVE_SESSION is None


# ---------------------------------------------------------------- USB 配置测绘


def test_usb_configuration_paths_counted() -> None:
    """USB 配置编号对应接口数量（如配置 2→3 条、配置 6→11 条）。"""
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
    # 不连真设备：方向缓存在测试里手动设置，_refresh_orientation 遇 None 会跳过
    controller._orientation_at = float("inf")
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


# ---------------------------------------------------------------- 断线自愈


def test_ios_session_reconnects_after_repeated_failures() -> None:
    """截图连续失败要触发 DVT 重建，别让画面永久冻结。"""
    session = ios.TunnelSession("UDID-TEST", fps=8)
    calls: list[str] = []

    class Boom:
        async def get_screenshot(self) -> bytes:
            raise RuntimeError("DVT 断了")

    async def fake_reopen() -> None:
        calls.append("reopen")

    session._shot = Boom()  # 模拟坏掉的截图服务
    session._reopen_dvt = fake_reopen  # type: ignore[method-assign]

    # 跑循环一小会儿：3 次失败后应该触发重建
    async def run() -> None:
        import asyncio

        task = asyncio.ensure_future(session._loop_shots())
        await asyncio.sleep(1.2)
        session._stop.set()
        task.cancel()

    import asyncio

    asyncio.run(run())
    assert calls, f"连续失败后应重建 DVT 会话（failures={session.failures}）"
    assert session.failures >= 3


def test_ios_controller_detects_stall() -> None:
    """画面超过 6 秒没更新 → 判定卡住（触发重连）。"""
    controller = ios.IosController(udid="UDID-TEST")
    session = ios.TunnelSession("UDID-TEST")
    controller._session = session

    session.last_frame_at = time.time()
    assert not controller._stalled()

    session.last_frame_at = time.time() - 10
    assert controller._stalled()


# ---------------------------------------------------------------- 横屏坐标变换


def test_digitizer_transform_per_orientation() -> None:
    """digitizer 固定在物理竖屏玻璃上：横屏必须按 Home 位置旋回。"""
    # 竖屏：原样
    assert ios.to_digitizer(0.25, 0.75, ios.ORIENT_PORTRAIT) == (0.25, 0.75)
    # 竖屏倒置：180°
    assert ios.to_digitizer(0.25, 0.75, ios.ORIENT_PORTRAIT_UPSIDE_DOWN) == (0.75, 0.25)
    # 方向码 3 = LandscapeRight（Home 在右，画面逆时针 90°）：(x,y) ↦ (1-y, x)
    assert ios.to_digitizer(0.25, 0.75, ios.ORIENT_LANDSCAPE_RIGHT) == (0.25, 0.25)
    assert ios.to_digitizer(0.155, 0.492, ios.ORIENT_LANDSCAPE_RIGHT) == (0.508, 0.155)
    # 方向码 4 = LandscapeLeft（Home 在左，画面顺时针 90°）：(x,y) ↦ (y, 1-x)
    assert ios.to_digitizer(0.25, 0.75, ios.ORIENT_LANDSCAPE_LEFT) == (0.75, 0.75)
    # 未知方向按竖屏处理（至少不错得离谱）
    assert ios.to_digitizer(0.3, 0.4, 99) == (0.3, 0.4)


def test_digitizer_rotates_even_when_buffer_is_landscape() -> None:
    """缓冲已经是横屏也要旋 —— 这就是"横屏点下去还是竖屏位置"的根因。

    HID 的 mainTouchscreen 用物理竖屏玻璃坐标，和 DVT 这一帧的宽高无关。
    之前按"缓冲宽>高就不旋"处理，横屏时等于把横屏画面坐标原样当竖屏送了。
    """
    # 横屏缓冲 + 横屏方向码：照旋（不是恒等）
    assert ios.to_digitizer(0.25, 0.75, ios.ORIENT_LANDSCAPE_RIGHT, (2796, 1290)) == (0.25, 0.25)
    assert ios.to_digitizer(0.25, 0.75, ios.ORIENT_LANDSCAPE_LEFT, (2796, 1290)) == (0.75, 0.75)
    # 竖屏缓冲 + 横屏方向码：投屏会转正，点击同样旋回
    assert ios.to_digitizer(0.25, 0.75, ios.ORIENT_LANDSCAPE_RIGHT, (1290, 2796)) == (0.25, 0.25)
    # 方向码还没刷新（停在竖屏 / 不认识）+ 画面已经横了：按最常见的 Home 在右兜底
    assert ios.effective_orientation(ios.ORIENT_PORTRAIT, 2796, 1290) == ios.ORIENT_LANDSCAPE_RIGHT
    assert ios.effective_orientation(ios.ORIENT_PORTRAIT_UPSIDE_DOWN, 2796, 1290) == ios.ORIENT_LANDSCAPE_RIGHT
    assert ios.effective_orientation(99, 2796, 1290) == ios.ORIENT_LANDSCAPE_RIGHT
    assert ios.to_digitizer(0.25, 0.75, ios.ORIENT_PORTRAIT, (2796, 1290)) == (0.25, 0.25)
    # 横屏方向码原样保留（不能被兜底改成 Home 在右）
    assert ios.effective_orientation(ios.ORIENT_LANDSCAPE_LEFT, 2796, 1290) == ios.ORIENT_LANDSCAPE_LEFT
    assert ios.effective_orientation(ios.ORIENT_LANDSCAPE_RIGHT, 2796, 1290) == ios.ORIENT_LANDSCAPE_RIGHT
    # 真竖屏：不旋
    assert ios.effective_orientation(ios.ORIENT_PORTRAIT, 1290, 2796) == ios.ORIENT_PORTRAIT
    assert ios.to_digitizer(0.25, 0.75, ios.ORIENT_PORTRAIT, (1290, 2796)) == (0.25, 0.75)


def test_orient_screenshot_rotates_portrait_capture_to_landscape() -> None:
    import numpy as np

    # 2×3 竖图，每格一个值，用来确认旋转方向
    image = np.array([[1, 2], [3, 4], [5, 6]], dtype=np.uint8)
    home_right = ios.orient_screenshot(image, ios.ORIENT_LANDSCAPE_RIGHT)
    assert home_right.shape[:2] == (2, 3)
    assert [int(item) for item in home_right.reshape(-1)] == [2, 4, 6, 1, 3, 5]
    home_left = ios.orient_screenshot(image, ios.ORIENT_LANDSCAPE_LEFT)
    assert home_left.shape[:2] == (2, 3)
    assert [int(item) for item in home_left.reshape(-1)] == [5, 3, 1, 6, 4, 2]
    # 已经是横图不再转第二次
    assert ios.orient_screenshot(home_right, ios.ORIENT_LANDSCAPE_RIGHT).shape[:2] == (2, 3)


def test_digitizer_is_inverse_of_screenshot_rotation() -> None:
    """点在转正后的画面上，必须回到原始缓冲里的同一个像素。"""
    import numpy as np

    raw = np.zeros((4, 2), np.uint8)  # 高 4、宽 2 的竖屏缓冲
    raw[1, 0] = 7  # 硬件像素 (x=0, y=1)
    raw_x, raw_y = 0.5 / 2, 1.5 / 4

    for orientation in (ios.ORIENT_LANDSCAPE_LEFT, ios.ORIENT_LANDSCAPE_RIGHT):
        shown = ios.orient_screenshot(raw, orientation)
        ys, xs = np.where(shown == 7)
        shown_x = (float(xs[0]) + 0.5) / shown.shape[1]
        shown_y = (float(ys[0]) + 0.5) / shown.shape[0]
        back_x, back_y = ios.to_digitizer(shown_x, shown_y, orientation, (raw.shape[1], raw.shape[0]))
        assert back_x == raw_x and back_y == raw_y, (orientation, back_x, back_y)


def test_digitizer_lands_on_same_glass_pixel_for_both_buffer_shapes() -> None:
    """DVT 交竖屏缓冲还是已经转好的横屏缓冲，点同一物理位置要落到同一玻璃像素。

    这就是用户报的"横屏坐标还是竖屏的"：DVT 在横屏时交的已经是横屏缓冲，
    旧逻辑看到宽>高就把旋转省了 → 点哪都偏 90°。
    """
    import numpy as np

    raw = np.zeros((4, 2), np.uint8)  # 竖屏缓冲：高 4、宽 2
    raw[1, 0] = 7
    raw_x, raw_y = 0.5 / 2, 1.5 / 4

    for orientation, turns in ((ios.ORIENT_LANDSCAPE_RIGHT, 1), (ios.ORIENT_LANDSCAPE_LEFT, 3)):
        # 横屏时 DVT 直接交出转好的横屏缓冲（np.rot90 的 1 = 逆时针、3 = 顺时针）
        shown = np.rot90(raw, turns)
        assert np.array_equal(shown, ios.orient_screenshot(raw, orientation))
        ys, xs = np.where(shown == 7)
        shown_x = (float(xs[0]) + 0.5) / shown.shape[1]
        shown_y = (float(ys[0]) + 0.5) / shown.shape[0]

        portrait_buffer = ios.to_digitizer(shown_x, shown_y, orientation, (raw.shape[1], raw.shape[0]))
        landscape_buffer = ios.to_digitizer(shown_x, shown_y, orientation, (shown.shape[1], shown.shape[0]))
        assert portrait_buffer == (raw_x, raw_y), (orientation, portrait_buffer)
        assert landscape_buffer == (raw_x, raw_y), (orientation, landscape_buffer)


def test_digitizer_transform_keeps_corners_in_range() -> None:
    for orientation in (
        ios.ORIENT_PORTRAIT,
        ios.ORIENT_PORTRAIT_UPSIDE_DOWN,
        ios.ORIENT_LANDSCAPE_LEFT,
        ios.ORIENT_LANDSCAPE_RIGHT,
    ):
        for x, y in ((0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0), (0.5, 0.5)):
            dx, dy = ios.to_digitizer(x, y, orientation)
            assert 0.0 <= dx <= 1.0 and 0.0 <= dy <= 1.0, f"{orientation} {x},{y} → {dx},{dy}"


def test_controller_screenshot_follows_interface_orientation() -> None:
    """横屏时投屏必须转成宽>高，分辨率跟着变，不能继续按竖屏控。"""
    import numpy as np

    controller, _ = _controller_with_fake_hid()
    session = ios.TunnelSession("UDID-TEST")
    portrait = np.zeros((6, 4, 3), np.uint8)
    session.size = (4, 6)
    session._frame = portrait
    session.last_frame_at = time.time()
    controller._session = session
    controller._orientation = ios.ORIENT_LANDSCAPE_RIGHT
    controller._last_aspect = "portrait"
    controller._orientation_at = float("inf")

    frame = controller.screenshot()
    assert frame.shape[:2] == (4, 6)
    assert controller.resolution == (6, 4)


def test_controller_applies_orientation_to_touch() -> None:
    """控制器要按缓存的界面方向做变换后再送 HID（横屏缓冲也一样旋）。"""
    controller, fake = _controller_with_fake_hid()
    controller._orientation = ios.ORIENT_LANDSCAPE_RIGHT
    controller.touch("down", 0.25, 0.75)
    assert fake.calls == [("down", round(0.25 * 65535), round(0.25 * 65535))], fake.calls

    session = ios.TunnelSession("UDID-TEST")
    session.size = (2796, 1290)  # 缓冲已经是横屏：仍要旋回物理竖屏玻璃
    controller._session = session
    controller.touch("down", 0.2, 0.8)
    assert fake.calls[-1] == ("down", round(0.2 * 65535), round(0.2 * 65535))

    # 方向码停在竖屏但画面已经横了：兜底成 Home 在右，不能原样送
    controller._orientation = ios.ORIENT_PORTRAIT
    controller.touch("down", 0.2, 0.8)
    assert fake.calls[-1] == ("down", round(0.2 * 65535), round(0.2 * 65535))


# ---------------------------------------------------------------- 控制通道断线自愈


class FlakyHid:
    """第一次调用断线，重连后正常。"""

    def __init__(self) -> None:
        self.calls: list[tuple[str, int, int]] = []
        self.connected = True
        self.broken = True

    def touch(self, phase: str, x: int, y: int) -> None:
        if self.broken:
            raise BrokenPipeError(32, "Broken pipe")
        self.calls.append((phase, x, y))

    def press(self, name: str) -> None:
        if self.broken:
            raise BrokenPipeError(32, "Broken pipe")

    def text(self, value: str) -> None:
        if self.broken:
            raise BrokenPipeError(32, "Broken pipe")

    def reconnect(self) -> None:
        self.broken = False


def test_touch_fails_fast_and_recovers_in_background() -> None:
    """断线时触摸必须**立即**返回可读错误，并安排后台重连。

    为什么不能同步重连：重连要几秒，界面 10 秒就超时了
    （用户报过 "触控失败: 引擎响应超时（>10s）"）。
    """
    controller = ios.IosController(udid="UDID-TEST")
    flaky = FlakyHid()
    controller._hid = flaky  # type: ignore[assignment]
    controller._orientation_at = float("inf")

    recovered: list[str] = []
    controller._recover_hid = lambda: recovered.append("recover")  # type: ignore[method-assign]

    started = time.time()
    with pytest.raises(RuntimeError, match="后台自动重连"):
        controller.touch("down", 0.5, 0.5)
    elapsed = time.time() - started
    assert elapsed < 1.0, f"touch should not wait for reconnect (took {elapsed:.2f}s)"

    for _ in range(60):
        if recovered:
            break
        time.sleep(0.02)
    assert recovered == ["recover"], "should schedule exactly one background recovery"


def test_broken_pipe_error_message_is_readable() -> None:
    """界面看到的必须是能照做的提示，不是裸的 BrokenPipeError。"""
    controller = ios.IosController(udid="UDID-TEST")
    controller._hid = FlakyHid()  # type: ignore[assignment]
    controller._orientation_at = float("inf")
    controller._recover_hid = lambda: None  # type: ignore[method-assign]

    with pytest.raises(RuntimeError) as info:
        controller.touch("down", 0.5, 0.5)
    message = str(info.value)
    assert "BrokenPipeError" not in message
    assert "再点一次" in message
