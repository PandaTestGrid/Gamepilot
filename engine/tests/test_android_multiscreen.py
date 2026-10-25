"""MuMu 多屏：逻辑屏号会重排、空标签页不发视频帧，不能误抓或误点主屏。"""

from __future__ import annotations

import random
import subprocess
from typing import Any
from unittest.mock import Mock

import numpy as np
import pytest

from gamepilot.devices import android, scrcpy


def _screen(logical: int = 2, physical: int = 42) -> android.DisplayInfo:
    return android.DisplayInfo(
        id=logical, name="mumuscreen010", physical_id=physical, size=(100, 200), top_app="com.example.game"
    )


def _frame(value: int = 255) -> np.ndarray:
    return np.full((200, 100, 3), value, dtype=np.uint8)


class FakeChannel:
    """替身 scrcpy 通道：记录被调用的输入，可按需让控制通道报错。"""

    instance: FakeChannel | None = None
    broken: bool = False

    def __init__(self, **_kwargs: Any) -> None:
        FakeChannel.instance = self
        self.closed = False
        self.alive = True
        self.frame_id = 7
        self.canvas_size = (100, 200)
        self.video_size = (100, 200)
        self.calls: list[tuple[str, Any]] = []

    def start(self) -> None:
        pass

    def latest_frame(self, timeout: float = 0.0) -> np.ndarray:
        return _frame()

    def touch(self, phase: str, x: float, y: float) -> None:
        if FakeChannel.broken:
            raise BrokenPipeError("注入失败")
        self.calls.append(("touch", phase, x, y))

    def click(self, x: float, y: float, duration: float = 0.05, path: Any = None) -> None:
        if FakeChannel.broken:
            raise BrokenPipeError("注入失败")
        self.calls.append(("click", x, y))

    def swipe(self, x1: float, y1: float, x2: float, y2: float, duration: float = 0.3, path: Any = None) -> None:
        if FakeChannel.broken:
            raise ConnectionError("控制 socket 断了")
        self.calls.append(("swipe", x1, y1, x2, y2))

    def key(self, keycode: int) -> None:
        if FakeChannel.broken:
            raise OSError("控制 socket 断了")
        self.calls.append(("key", keycode))

    def text(self, value: str) -> None:
        if FakeChannel.broken:
            raise BrokenPipeError("注入失败")
        self.calls.append(("text", value))

    def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def _reset_channel() -> None:
    FakeChannel.broken = False
    FakeChannel.instance = None


def _controller(
    monkeypatch: pytest.MonkeyPatch, display: int = 0, physical: int | None = None
) -> android.AndroidController:
    controller = android.AndroidController(serial="emulator-5554", display=display, physical=physical)
    controller._client_device = Mock()
    controller._connected = True
    monkeypatch.setattr(controller, "_adb_binary", lambda: "adb")
    return controller


def test_physical_screen_survives_logical_renumbering(monkeypatch: pytest.MonkeyPatch) -> None:
    controller = android.AndroidController(serial="emulator-5554", display=23, physical=42)
    monkeypatch.setattr(android, "list_displays", lambda _serial: [_screen(2)])

    controller._resolve_display()

    assert controller.display == 2
    assert controller._display_info == _screen(2)


def test_cannot_connect_to_mumu_reserved_empty_slot(monkeypatch: pytest.MonkeyPatch) -> None:
    controller = android.AndroidController(serial="emulator-5554", display=2, physical=42)
    empty = android.DisplayInfo(id=2, name="mumuscreen010", physical_id=42, top_app=None)
    monkeypatch.setattr(android, "list_displays", lambda _serial: [empty])

    with pytest.raises(RuntimeError, match="没有已打开的应用窗口"):
        controller._resolve_display()


def test_main_screen_starts_scrcpy_on_display_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    created: list[dict[str, Any]] = []

    class RecordingChannel(FakeChannel):
        def __init__(self, **kwargs: Any) -> None:
            created.append(kwargs)
            super().__init__(**kwargs)

    monkeypatch.setattr(scrcpy, "find_server_jar", lambda: "server.jar")
    monkeypatch.setattr(scrcpy, "ScrcpyChannel", RecordingChannel)
    controller = _controller(monkeypatch)
    controller._display_info = android.DisplayInfo(id=0, name="Built-in", physical_id=0, primary=True, size=(100, 200))
    controller._resolve_display = lambda: None  # type: ignore[method-assign]

    controller._start_scrcpy()

    assert created[0]["display_id"] == 0  # 主屏也显式选屏，不能错投别的窗口
    assert controller.channel == "scrcpy"
    assert controller.link_note == "scrcpy 100×200（主屏）"


def test_start_scrcpy_without_first_frame_raises_and_closes(monkeypatch: pytest.MonkeyPatch) -> None:
    class EmptyVideo(FakeChannel):
        def latest_frame(self, timeout: float = 0.0) -> None:
            # 首帧等待上限来自通道（默认 5s），不能退回原来的 2s：MuMu 慢时会被误判失败
            assert timeout == 5.0
            return None

    monkeypatch.setattr(scrcpy, "find_server_jar", lambda: "server.jar")
    monkeypatch.setattr(scrcpy, "ScrcpyChannel", EmptyVideo)
    controller = _controller(monkeypatch)
    controller._display_info = android.DisplayInfo(id=0, name="Built-in", physical_id=0, primary=True, size=(100, 200))
    controller._resolve_display = lambda: None  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="投屏启动失败"):
        controller._start_scrcpy()

    assert FakeChannel.instance is not None and FakeChannel.instance.closed
    assert controller._scrcpy is None
    assert "首帧" in controller.link_note
    with pytest.raises(RuntimeError, match="启动失败"):
        controller.screenshot()
    controller._client_device.screenshot.assert_not_called()


def test_dead_video_raises_instead_of_showing_stale_frame(monkeypatch: pytest.MonkeyPatch) -> None:
    controller = _controller(monkeypatch, display=23, physical=42)
    controller._display_info = _screen(23)
    channel = FakeChannel()
    channel.alive = False
    controller._scrcpy = channel
    monkeypatch.setattr(android, "list_displays", lambda _serial: [_screen(2)])

    with pytest.raises(RuntimeError, match="流中断"):
        controller.screenshot()

    assert controller._scrcpy is None
    assert controller._last_frame is None  # 不能把上一帧当新画面继续推
    assert channel.closed


def test_reused_logical_id_raises_instead_of_showing_another_screen(monkeypatch: pytest.MonkeyPatch) -> None:
    controller = _controller(monkeypatch, display=23, physical=42)
    controller._display_info = _screen(23)
    channel = FakeChannel()
    controller._scrcpy = channel
    dump = (
        'mBaseDisplayInfo=DisplayInfo{"mumuscreen010", displayId 2, real 100 x 200, uniqueId "local:42", app 100 x 200}'
    )
    monkeypatch.setattr(android, "_adb_shell", lambda *_args: dump)
    monkeypatch.setattr(android, "list_displays", lambda _serial: [_screen(2)])

    with pytest.raises(RuntimeError, match="屏号已变化"):
        controller.screenshot()

    assert controller.display == 2
    assert controller._scrcpy is None
    assert channel.closed


def test_input_only_goes_through_scrcpy(monkeypatch: pytest.MonkeyPatch) -> None:
    controller = _controller(monkeypatch, display=23, physical=42)
    controller._display_info = _screen(23)
    channel = FakeChannel()
    controller._scrcpy = channel

    controller.touch("down", 0.5, 0.25)
    controller.click(0.5, 0.25)
    controller.swipe(0.1, 0.2, 0.4, 0.6, duration=0.3)
    controller.press("back")
    controller.text("hello")
    controller.key("home")

    assert channel.calls == [
        ("touch", "down", 0.5, 0.25),
        ("click", 0.5, 0.25),
        ("swipe", 0.1, 0.2, 0.4, 0.6),
        ("key", 4),
        ("text", "hello"),
        ("key", 3),
    ]
    # 没有任何 adb 输入兜底：不 fork adb、不调 adbutils
    controller._client_device.click.assert_not_called()
    controller._client_device.swipe.assert_not_called()
    controller._client_device.keyevent.assert_not_called()
    controller._client_device.send_keys.assert_not_called()


def test_broken_control_channel_raises_and_closes(monkeypatch: pytest.MonkeyPatch) -> None:
    controller = _controller(monkeypatch, display=23, physical=42)
    controller._display_info = _screen(23)
    channel = FakeChannel()
    controller._scrcpy = channel
    FakeChannel.broken = True

    with pytest.raises(RuntimeError, match="控制通道断开"):
        controller.click(0.5, 0.5)

    assert controller._scrcpy is None
    assert "重连设备" in controller.link_note
    controller._client_device.click.assert_not_called()


def test_closed_screen_never_redirects_input_to_main(monkeypatch: pytest.MonkeyPatch) -> None:
    controller = _controller(monkeypatch, display=23, physical=42)
    controller._display_info = _screen(23)
    controller._scrcpy = FakeChannel()
    monkeypatch.setattr(android, "list_displays", lambda _serial: [])
    monkeypatch.setattr(
        android,
        "_adb_shell",
        lambda *_args: (
            'mBaseDisplayInfo=DisplayInfo{"mumuscreen010", displayId 5, real 100 x 200, '
            'uniqueId "local:43", app 100 x 200}'
        ),
    )

    with pytest.raises(RuntimeError, match="已关闭"):
        controller.click(0.5, 0.5)

    controller._client_device.click.assert_not_called()


def test_scrcpy_uses_separate_scid_socket_and_jar_for_parallel_displays(monkeypatch: pytest.MonkeyPatch) -> None:
    ids = iter((1, 2, 3))
    monkeypatch.setattr(random, "randint", lambda _a, _b: next(ids))
    channels = [
        scrcpy.ScrcpyChannel("emulator-5554", "adb", "scrcpy-server.jar", display_id=screen) for screen in (0, 2, 3)
    ]
    pushes: list[tuple[str, ...]] = []
    launches: list[list[str]] = []

    def fake_popen(command: list[str], **_kwargs: Any) -> Mock:
        launches.append(command)
        return Mock(stderr=None)

    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    for channel in channels:
        monkeypatch.setattr(channel, "_adb", lambda *args: pushes.append(args))
        channel._push_server()
        channel._spawn_server()

    assert [channel.socket_name for channel in channels] == ["scrcpy_00000001", "scrcpy_00000002", "scrcpy_00000003"]
    assert len({push[-1] for push in pushes}) == 3
    for channel, command, display_id in zip(channels, launches, (0, 2, 3), strict=True):
        assert channel._remote_jar.endswith(f"{channel.scid:08x}.jar")
        assert f"scid={channel.scid:08x}" in command  # server 解析十六进制，socket 用同一 ID
        assert f"display_id={display_id}" in command  # 主屏也显式选择，不能错投别的窗口
        assert "tunnel_forward=true" in command


def test_find_server_jar_sees_vendor_copy() -> None:
    path = scrcpy.find_server_jar()
    assert path is not None
    assert path.endswith("scrcpy-server")
