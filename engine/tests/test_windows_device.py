"""Windows 窗口设备层的纯逻辑单测（不需要真实桌面，跨平台可跑）。

抓图/输入的真实链路依赖真实窗口与我们的桌面会话，放在手工 smoke
（`scripts/smoke-windows-window.py`）里验证；这里守住最容易静默出错的四件事：
窗口过滤、句柄解析、归一化→客户区像素、全黑帧判定。
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from gamepilot.devices import windows
from gamepilot.devices.windows import WinWindow


def make_window(**patch: Any) -> WinWindow:
    base: dict[str, Any] = {
        "hwnd": 6698742,
        "pid": 12345,
        "process": "Game.exe",
        "title": "某游戏",
        "class_name": "UnityWndClass",
        "left": 100,
        "top": 80,
        "width": 1280,
        "height": 720,
        "client_left": 108,
        "client_top": 104,
        "client_width": 1280,
        "client_height": 700,
    }
    base.update(patch)
    return WinWindow(**base)


# ---------- 句柄 ----------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (6698742, 6698742),
        ("6698742", 6698742),
        ("0x1A2B", 6699),
        ("0X1A2B", 6699),
        ("  0x0042  ", 66),
        ("", 0),
        (None, 0),
        (-5, 0),
    ],
)
def test_parse_handle_accepts_decimal_and_hex(raw: Any, expected: int) -> None:
    assert windows.parse_handle(raw) == expected


def test_parse_handle_rejects_garbage_with_chinese_hint() -> None:
    with pytest.raises(ValueError, match="窗口句柄不合法"):
        windows.parse_handle("GamePilot")


# ---------- 坐标 ----------


def test_client_point_maps_normalized_to_client_pixels() -> None:
    window = make_window(client_width=1000, client_height=500)
    assert windows.client_point(window, 0.0, 0.0) == (0, 0)
    assert windows.client_point(window, 0.5, 0.5) == (500, 250)
    assert windows.client_point(window, 1.0, 1.0) == (999, 499)


def test_client_point_clamps_out_of_range() -> None:
    window = make_window(client_width=800, client_height=600)
    assert windows.client_point(window, -1.0, 2.0) == (0, 599)


def test_client_point_never_returns_out_of_bounds_pixel() -> None:
    window = make_window(client_width=1, client_height=1)
    assert windows.client_point(window, 0.7, 0.7) == (0, 0)


# ---------- 全黑帧 ----------


def test_black_frame_detects_all_black_and_keeps_dark_frames() -> None:
    assert windows.black_frame(np.zeros((48, 64, 3), dtype=np.uint8)) is True
    # 深色游戏画面（平均亮度 6）不是"抓图失败"
    assert windows.black_frame(np.full((48, 64, 3), 6, dtype=np.uint8)) is False
    assert windows.black_frame(np.empty((0, 0, 3), dtype=np.uint8)) is True


# ---------- 窗口过滤 ----------


def raw_window(**patch: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "hwnd": 100,
        "pid": 42,
        "process": "Game.exe",
        "title": "某游戏",
        "class_name": "UnityWndClass",
        "left": 10,
        "top": 10,
        "width": 1280,
        "height": 720,
        "client_left": 18,
        "client_top": 34,
        "client_width": 1272,
        "client_height": 690,
        "minimized": False,
        "protected": False,
        "visible": True,
        "tool_window": False,
        "cloaked": False,
    }
    base.update(patch)
    return base


def test_filter_windows_keeps_normal_game_window() -> None:
    [window] = windows.filter_windows([raw_window()])
    assert window.hwnd == 100
    assert window.title == "某游戏"
    assert window.process == "Game.exe"
    assert window.client_size == (1272, 690)


@pytest.mark.parametrize(
    "patch",
    [
        {"visible": False},
        {"tool_window": True},
        {"cloaked": True},
        {"title": "   "},
        {"width": 100},
        {"height": 100},
        {"class_name": "Progman"},
        {"class_name": "Shell_TrayWnd"},
        {"hwnd": 0},
    ],
)
def test_filter_windows_drops_unusable_windows(patch: dict[str, Any]) -> None:
    assert windows.filter_windows([raw_window(**patch)]) == []


def test_filter_windows_dedupes_same_handle_and_keeps_order() -> None:
    first = raw_window(hwnd=1, title="第一个")
    second = raw_window(hwnd=2, title="第二个")
    rows = windows.filter_windows([first, second, first])
    assert [row.hwnd for row in rows] == [1, 2]


def test_filter_windows_keeps_minimized_but_marks_it() -> None:
    [window] = windows.filter_windows([raw_window(minimized=True, protected=True)])
    assert window.minimized is True
    assert window.protected is True


def test_win_window_dict_matches_window_list_contract() -> None:
    data = make_window().to_dict()
    for key in (
        "handle",
        "hwnd",
        "pid",
        "process",
        "app",
        "title",
        "class",
        "className",
        "label",
        "x",
        "y",
        "width",
        "height",
        "clientWidth",
        "clientHeight",
        "minimized",
        "protected",
        "uri",
        "deviceId",
    ):
        assert key in data, key
    assert data["uri"] == "Windows:///?hwnd=6698742"
    assert data["deviceId"] == "windows:6698742"
    assert data["label"] == "Game.exe — 某游戏"


# ---------- 设备发现 / window.list 的 payload ----------


def test_window_list_payload_uses_enumeration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(windows, "available", lambda: True)
    monkeypatch.setattr(windows, "list_windows", lambda include_own=False: [make_window()])

    payload = windows.window_list_payload()

    assert payload["platform"] == "win32"
    assert payload["allowed"] is True
    assert payload["note"] == "1 个可选窗口"
    assert payload["windows"][0]["deviceId"] == "windows:6698742"


def test_window_list_payload_is_empty_when_unsupported(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(windows, "available", lambda: False)
    payload = windows.window_list_payload()
    assert payload["allowed"] is False
    assert payload["windows"] == []


def test_discover_is_empty_when_unsupported(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(windows, "available", lambda: False)
    assert windows.discover() == []


def test_discover_returns_picker_device(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(windows, "available", lambda: True)
    monkeypatch.setattr(windows, "list_windows", lambda include_own=False: [make_window()])

    [device] = windows.discover()

    assert device.id == "windows:picker"
    assert device.kind == "windows"
    assert "1 个可选窗口" in device.name


# ---------- 按键 / 文本 ----------


@pytest.mark.parametrize(
    "name",
    ["enter", "space", "escape", "w", "a", "s", "d", "1", "f1", "f12", "up", "down", "left", "right", "ctrl", "shift"],
)
def test_window_keys_cover_common_game_keys(name: str) -> None:
    assert name in windows.WINDOW_KEYS


def test_window_keys_map_letters_to_virtual_codes() -> None:
    assert windows.WINDOW_KEYS["w"] == 0x57
    assert windows.WINDOW_KEYS["a"] == 0x41
    assert windows.WINDOW_KEYS["0"] == 0x30
    assert windows.WINDOW_KEYS["f1"] == 0x70
    assert windows.WINDOW_KEYS["f12"] == 0x7B


def test_game_keys_are_all_mapped_by_windows_controller() -> None:
    """动作层允许保存的游戏键，Windows 控制器必须都能映射到虚拟键码。"""
    from gamepilot.devices.base import ACTION_KEYS, GAME_KEYS

    mapped = set(windows.WINDOW_KEYS)
    assert mapped >= GAME_KEYS
    nav_only = {"back", "home", "recents", "power", "volume_up", "volume_down"}
    assert mapped | nav_only >= ACTION_KEYS


def test_utf16_units_split_surrogate_pairs() -> None:
    assert windows._utf16_units("A中") == [0x41, 0x4E2D]
    assert windows._utf16_units("😀") == [0xD83D, 0xDE00]


# ---------- 控制器参数（不连真实窗口） ----------


def test_controller_parses_uri_options_without_connecting() -> None:
    controller = windows.WindowsWindowController(
        hwnd="0x1A2B",
        post="message",
        capture="screen",
        **{"class": "UnityWndClass"},  # type: ignore[arg-type]  # URI 里的 ?class= 就是这个形状
    )
    assert controller.hwnd_ref == 6699
    assert controller.post == "message"
    assert controller.capture == "screen"
    assert controller.class_ref == "UnityWndClass"
    assert controller.scheme == "Windows"
    assert controller.kind == "windows"


def test_controller_defaults_to_global_input() -> None:
    controller = windows.WindowsWindowController()
    assert controller.post == "global"
    assert controller.capture == "auto"
    assert controller.activate is True
    assert controller.restore_cursor is True
    assert controller.cursor_follow is False


def test_controller_accepts_sync_channel_and_cursor_follow() -> None:
    """`?post=sync&cursor=1`：后台同步 SendMessage + 光标跟随（UE/Unity 游戏的后台通道）。"""
    controller = windows.WindowsWindowController(hwnd=1, post="sync", cursor=True)
    assert controller.post == "sync"
    assert controller.cursor_follow is True
    assert controller.to_dict()["post"] == "sync"
    assert controller.to_dict()["cursorFollow"] is True


def test_controller_accepts_hybrid_compat_mode() -> None:
    """`?post=hybrid`：兼容模式（动作时临时激活目标窗口、动作后还原焦点）。"""
    controller = windows.WindowsWindowController(hwnd=1, post="hybrid")
    assert controller.post == "hybrid"
    assert controller.to_dict()["post"] == "hybrid"


def test_controller_unknown_post_falls_back_to_global() -> None:
    controller = windows.WindowsWindowController(hwnd=1, post="telepathy")
    assert controller.post == "global"


def test_controller_unknown_capture_falls_back_to_auto() -> None:
    controller = windows.WindowsWindowController(hwnd=1, capture="impossible")
    assert controller.capture == "auto"


def test_controller_prefers_higher_capture_fps_than_default() -> None:
    """窗口设备抓图快（WGC 3ms），循环上限应高于会话默认 8fps。"""
    controller = windows.WindowsWindowController(hwnd=1)
    assert controller.preferred_fps == 20.0


def test_controller_resolve_error_mentions_handle() -> None:
    controller = windows.WindowsWindowController(hwnd=42)
    message = controller._resolve_error()
    assert "句柄 42" in message
    assert "本机窗口" in message


def test_controller_accepts_wgc_capture_mode() -> None:
    controller = windows.WindowsWindowController(hwnd=1, capture="wgc")
    assert controller.capture == "wgc"


def test_wgc_available_is_false_off_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(windows.sys, "platform", "linux")
    assert windows.wgc_available() is False


def test_wgc_available_checks_optional_package(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(windows.sys, "platform", "win32")
    monkeypatch.setattr(windows.importlib.util, "find_spec", lambda name: object())
    assert windows.wgc_available() is True
    monkeypatch.setattr(windows.importlib.util, "find_spec", lambda name: None)
    assert windows.wgc_available() is False


def test_wgc_crop_takes_client_area_and_strips_alpha() -> None:
    """WGC 抓的是整窗 BGRA；要按客户区偏移裁掉标题栏/边框并转成 BGR。"""
    window = make_window(
        left=100,
        top=80,
        width=1282,
        height=752,
        client_left=101,
        client_top=111,
        client_width=1280,
        client_height=720,
    )
    grabber = windows._WgcGrabber(window)
    # 整窗 BGRA：左上角标记 (1,31) 之后才是客户区
    buffer = np.zeros((752, 1282, 4), dtype=np.uint8)
    buffer[31, 1] = [10, 20, 30, 255]
    cropped = grabber._crop(type("Frame", (), {"frame_buffer": buffer})())
    assert cropped is not None
    assert cropped.shape == (720, 1280, 3)
    assert cropped.dtype == np.uint8
    assert list(cropped[0, 0]) == [10, 20, 30]  # BGRA → BGR
