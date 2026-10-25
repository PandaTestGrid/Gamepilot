"""`window.list` 契约 + Windows 窗口 URI 归一化（不连真实桌面、跨平台可跑）。

窗口枚举本身依赖真实桌面（`EnumWindows` / `CGWindowList`），所以这里只测**平台分发与参数
转发**：把两个设备模块的 `window_list_payload` 换成假数据，确认 RPC 层没有把平台搞混。
真实窗口链路由 `tests/test_windows_device.py` 的纯函数用例 + 手工 smoke 覆盖。
"""

from __future__ import annotations

import io
import json
import sys
from typing import Any

import pytest

from gamepilot.rpc.session import device_id_for, parse_device_uri
from gamepilot.rpc.stdio import RpcServer

FAKE_WINDOW = {
    "handle": 6698742,
    "hwnd": 6698742,
    "pid": 12345,
    "process": "Game.exe",
    "app": "Game.exe",
    "title": "某游戏",
    "class": "UnityWndClass",
    "className": "UnityWndClass",
    "label": "Game.exe — 某游戏",
    "x": 100,
    "y": 80,
    "width": 1280,
    "height": 720,
    "clientWidth": 1280,
    "clientHeight": 700,
    "minimized": False,
    "uri": "Windows:///?hwnd=6698742",
    "deviceId": "windows:6698742",
}


@pytest.fixture()
def server(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> tuple[RpcServer, io.StringIO]:
    """只建控制面，不扫描设备：工作区/配置都指到临时目录，不碰用户数据。"""
    monkeypatch.setenv("GAMEPILOT_WORKSPACE_DIR", str(tmp_path / "workspace"))
    monkeypatch.setenv("GAMEPILOT_CONFIG_DIR", str(tmp_path / "config"))
    out = io.StringIO()
    return RpcServer(io.StringIO(), out), out


def _call(server: RpcServer, out: io.StringIO, params: dict[str, Any] | None = None) -> dict[str, Any]:
    out.seek(0)
    out.truncate(0)
    server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 7, "method": "window.list", "params": params or {}}))
    response = json.loads(out.getvalue().strip().splitlines()[-1])
    assert "error" not in response, response
    result = response["result"]
    assert isinstance(result, dict)
    return result


def test_window_list_routes_to_windows_module(
    server: tuple[RpcServer, io.StringIO], monkeypatch: pytest.MonkeyPatch
) -> None:
    """win32 → 调 devices.windows，并把 includeOwn 透传过去。"""
    from gamepilot.devices import windows

    calls: list[bool] = []

    def fake_payload(include_own: bool = False) -> dict[str, Any]:
        calls.append(include_own)
        return {"platform": "win32", "allowed": True, "note": "1 个可选窗口", "windows": [FAKE_WINDOW]}

    monkeypatch.setattr(windows, "window_list_payload", fake_payload)
    monkeypatch.setattr(sys, "platform", "win32")
    rpc, out = server

    result = _call(rpc, out, {"includeOwn": True})

    assert calls == [True]
    assert result["platform"] == "win32"
    assert result["allowed"] is True
    assert result["windows"][0]["uri"] == "Windows:///?hwnd=6698742"
    assert result["windows"][0]["deviceId"] == "windows:6698742"


def test_window_list_routes_to_macos_module(
    server: tuple[RpcServer, io.StringIO], monkeypatch: pytest.MonkeyPatch
) -> None:
    """darwin → 调 devices.macos（不是 Windows 分支）。"""
    from gamepilot.devices import macos

    def fake_payload(include_own: bool = False) -> dict[str, Any]:
        _ = include_own
        return {
            "platform": "darwin",
            "allowed": False,
            "note": "缺少屏幕录制权限",
            "windows": [{"handle": 89, "uri": "Mac:///?window=89", "deviceId": "macos:89"}],
        }

    monkeypatch.setattr(macos, "window_list_payload", fake_payload)
    monkeypatch.setattr(sys, "platform", "darwin")
    rpc, out = server

    result = _call(rpc, out)

    assert result["platform"] == "darwin"
    assert result["allowed"] is False
    assert result["windows"][0]["deviceId"] == "macos:89"


def test_window_list_is_empty_on_unsupported_platform(
    server: tuple[RpcServer, io.StringIO], monkeypatch: pytest.MonkeyPatch
) -> None:
    """其它平台（linux）不报错，给空列表 + 说明（界面直接显示这句）。"""
    monkeypatch.setattr(sys, "platform", "linux")
    rpc, out = server

    result = _call(rpc, out)

    assert result == {
        "platform": "linux",
        "allowed": False,
        "note": "本机窗口自动化只在 Windows / macOS 上可用",
        "windows": [],
    }


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("6700", "6700"),
        ("0x1A2B", "6699"),
        ("0X1A2B", "6699"),
        ("  42  ", "42"),
    ],
)
def test_parse_device_uri_normalizes_hwnd(raw: str, expected: str) -> None:
    """手输十六进制句柄 → 十进制，避免同一个窗口出两个会话 id。"""
    scheme, options = parse_device_uri(f"Windows:///?hwnd={raw}")
    assert scheme == "windows"
    assert options["hwnd"] == expected


def test_parse_device_uri_keeps_invalid_hwnd_for_error_message() -> None:
    scheme, options = parse_device_uri("Windows:///?hwnd=not-a-handle")
    assert scheme == "windows"
    assert options["hwnd"] == "not-a-handle"


def test_device_id_for_windows_uses_hwnd() -> None:
    """Windows 窗口的会话键是窗口句柄 —— 换一个窗口就是另一台设备，不能互相顶掉。"""
    assert device_id_for("windows", {"hwnd": "6698742"}) == "windows:6698742"
    assert device_id_for("Windows", {"hwnd": 42}) == "windows:42"
