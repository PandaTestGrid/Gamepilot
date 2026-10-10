"""设备发现：纯函数单测 + 一次真实的 stdio 往返。

设计原则（CONVENTIONS §6）：**CI 不依赖真机**。
所以这里只对纯函数与 Mock 来源做硬断言；真机扫描只在有设备时做宽松断言。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any

import pytest

from gamepilot.devices import android, mock, scan
from gamepilot.devices.base import KIND_ANDROID, KIND_EMULATOR, KIND_MOCK, STATUS_FAILED

MODULE = "gamepilot.rpc"


# --------------------------------------------------------------------------- #
# 纯函数
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("serial", "model", "expected"),
    [
        ("emulator-5554", "sdk_gphone64_arm64", KIND_EMULATOR),
        ("127.0.0.1:7555", "MuMu", KIND_EMULATOR),
        ("3387980", "OPPO_A57", KIND_ANDROID),
        ("7b69da0c", "MI_8_Lite", KIND_ANDROID),
        ("LDPlayer-1", "", KIND_EMULATOR),
    ],
)
def test_classify_kind(serial: str, model: str, expected: str) -> None:
    assert android.classify_kind(serial, model) == expected


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        ("Physical size: 1080x1920", (1080, 1920)),
        ("Physical size: 1080x1920\nOverride size: 720x1280", (720, 1280)),
        ("   Physical size: 1440x3200  ", (1440, 3200)),
        ("garbage", None),
        ("", None),
    ],
)
def test_parse_wm_size(output: str, expected: Any) -> None:
    assert android.parse_wm_size(output) == expected


def test_device_id_and_uri_are_stable() -> None:
    # UI 靠 id 做选中与记忆，必须只由 serial 决定
    assert android.make_device_id("3387980") == "android:3387980"
    assert android.make_uri("3387980") == "Android:///?serial=3387980"


def test_friendly_name_prefers_model() -> None:
    assert android.friendly_name("3387980", "OPPO_A57") == "OPPO A57"
    assert android.friendly_name("3387980") == "3387980"


def test_unauthorized_state_maps_to_actionable_error() -> None:
    """未授权设备必须给出「能照做」的修复建议，而不是只报个状态码。"""
    status, error, fix = android._STATE_MAP["unauthorized"]
    assert status == STATUS_FAILED
    assert "未授权" in error
    assert "USB 调试" in fix


# --------------------------------------------------------------------------- #
# 扫描
# --------------------------------------------------------------------------- #


def test_scan_never_raises_and_always_has_mock() -> None:
    result = scan()
    assert any(device.kind == KIND_MOCK for device in result.devices)
    assert isinstance(result.errors, list)


def test_scan_result_is_json_serializable() -> None:
    payload = scan().to_dict()
    encoded = json.dumps(payload, ensure_ascii=False)
    assert "devices" in json.loads(encoded)


def test_mock_device_shape() -> None:
    [device] = mock.discover()
    payload = device.to_dict()
    assert payload["id"] == mock.MOCK_DEVICE_ID
    assert payload["kind"] == KIND_MOCK
    assert payload["resolution"] == [1280, 720]
    assert payload["status"] == "discovered"


# --------------------------------------------------------------------------- #
# RPC 往返（真实子进程，不读真机结果）
# --------------------------------------------------------------------------- #


def _call(method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    proc = subprocess.Popen(
        [sys.executable, "-m", MODULE],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env={**os.environ, "GAMEPILOT_LOG_LEVEL": "WARNING"},
    )
    try:
        assert proc.stdout is not None
        ready = json.loads(proc.stdout.readline())
        assert ready["method"] == "engine.ready"
        assert proc.stdin is not None
        request = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
        proc.stdin.write(json.dumps(request) + "\n")
        proc.stdin.flush()
        payload = json.loads(proc.stdout.readline())
        assert isinstance(payload, dict), f"响应必须是 JSON 对象: {payload!r}"
        proc.stdin.close()
        proc.wait(timeout=5)
        return payload
    finally:
        if proc.poll() is None:
            proc.kill()
        for stream in (proc.stdout, proc.stderr):
            if stream:
                stream.close()


def test_device_list_rpc_over_stdio() -> None:
    response = _call("device.list", {"scan": False})
    assert "error" not in response, response
    result = response["result"]
    assert isinstance(result["devices"], list)
    assert result["errors"] == []
    assert result["devices"][0]["kind"] == KIND_MOCK
