"""设备发现：纯函数单测 + 一次真实的 stdio 往返。

设计原则（CONVENTIONS §6）：**CI 不依赖真机**。
所以这里只对纯函数与 Mock 来源做硬断言；真机扫描只在有设备时做宽松断言。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from typing import Any

import pytest

from gamepilot.devices import android, scan
from gamepilot.devices.base import KIND_ANDROID, KIND_EMULATOR, STATUS_FAILED, DeviceInfo

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
# 多屏（模拟器把每个标签页放到一块独立虚拟屏上；MuMu 就是这么做的）
# --------------------------------------------------------------------------- #

# 真实抓来的三份 dumps 的缩略版（字段顺序照抄，正则才对得上）
SF_MULTI = """Display 4619827820427265280 (HWC display 0): port=0 pnpId=GGL displayName="mumuscreen000"
Display 4619827203584079877 (HWC display 5): port=5 pnpId=GGL displayName="mumuscreen005"
Display 4619827144452474627 (HWC display 3): port=3 pnpId=GGL displayName="mumuscreen003"
"""

DISPLAY_MULTI = """  mBaseDisplayInfo=DisplayInfo{"内置屏幕", displayId 0, displayGroupId 0, FLAG_SECURE, real 900 x 1600, largest app 900 x 1600, uniqueId "local:4619827820427265280", app 900 x 1600, density 240}
  mOverrideDisplayInfo=DisplayInfo{"内置屏幕", displayId 0, displayGroupId 0, FLAG_SECURE, FLAG_SCALING_DISABLED, real 1600 x 900, largest app 1600 x 1600, uniqueId "local:4619827820427265280", app 1600 x 900, rotation 1}
  mBaseDisplayInfo=DisplayInfo{"mumuscreen003", displayId 4, displayGroupId 0, FLAG_SECURE, real 900 x 1600, largest app 900 x 1600, uniqueId "local:4619827144452474627", app 900 x 1600}
  mBaseDisplayInfo=DisplayInfo{"mumuscreen005", displayId 7, displayGroupId 0, FLAG_SECURE, real 900 x 1600, largest app 900 x 1600, uniqueId "local:4619827203584079877", app 900 x 1600}
  mBaseDisplayInfo=DisplayInfo{"scrcpy", displayId 8, displayGroupId 0, FLAG_PRIVATE, real 1280 x 720, largest app 1280 x 720, uniqueId "virtual:0", app 1280 x 720}
"""

ACTIVITY_MULTI = """Display #0 (activities from top to bottom):
    topResumedActivity=ActivityRecord{248538820 u12 com.netease.onmyoji.wyzymnqsd_cps/com.netease.onmyoji.Client t18}
Display #4 (activities from top to bottom):
    topResumedActivity=ActivityRecord{175652421 u10 com.netease.onmyoji.wyzymnqsd_cps/com.netease.onmyoji.Client t16}
Display #7 (activities from top to bottom):
"""


def test_parse_surfaceflinger_displays() -> None:
    assert android.parse_surfaceflinger_displays(SF_MULTI) == [
        (4619827820427265280, "mumuscreen000"),
        (4619827203584079877, "mumuscreen005"),
        (4619827144452474627, "mumuscreen003"),
    ]
    assert android.parse_surfaceflinger_displays("") == []


def test_parse_display_infos_ignores_override_and_virtual() -> None:
    """尺寸取 mBaseDisplayInfo（mOverrideDisplayInfo 是旋转后的，宽高会反）。

    另外：`uniqueId "local:<物理id>"` 那一条是 SurfaceFlinger / DisplayManager 之间
    **唯一对得上的键**（一边叫 mumuscreen000、一边叫"内置屏幕"，名字对不上）。
    """
    infos = android.parse_display_infos(DISPLAY_MULTI)
    assert infos[4619827820427265280] == (0, "内置屏幕", (900, 1600))
    assert infos[4619827144452474627] == (4, "mumuscreen003", (900, 1600))
    # 虚拟屏的 uniqueId 不是 `local:<数字>` → 解析不出来（也不该被当成能抓的屏）
    assert 8 not in infos


def test_parse_top_apps() -> None:
    assert android.parse_top_apps(ACTIVITY_MULTI) == {
        0: "com.netease.onmyoji.wyzymnqsd_cps",
        4: "com.netease.onmyoji.wyzymnqsd_cps",
    }


def test_merge_displays_multi_screen() -> None:
    """MuMu 预留三块屏，但只打开一块附屏时只报主屏 + 那块应用屏。"""
    merged = android.merge_displays(SF_MULTI, DISPLAY_MULTI, ACTIVITY_MULTI)
    assert [(item.id, item.name, item.physical_id, item.size, item.primary) for item in merged] == [
        (0, "mumuscreen000", 4619827820427265280, (900, 1600), True),
        (4, "mumuscreen003", 4619827144452474627, (900, 1600), False),
    ]
    assert merged[1].top_app == "com.netease.onmyoji.wyzymnqsd_cps"
    assert merged[1].label == "屏4（mumuscreen003）"
    # scrcpy 自己建的虚拟屏不在 SurfaceFlinger 列表里 → 不该混进来
    assert all(item.name != "scrcpy" for item in merged)


def test_mumu_discovery_counts_open_apps_not_reserved_displays() -> None:
    """固定三块 SurfaceFlinger 屏：0/1/2 个附屏应用，结果必须是 1/2/3 个窗口。"""
    active_one = ACTIVITY_MULTI + (
        "    topResumedActivity=ActivityRecord{18412 u0 com.example.second/.GameActivity t20}\n"
    )
    assert [item.id for item in android.merge_displays(SF_MULTI, DISPLAY_MULTI, "")] == [0]
    assert [item.id for item in android.merge_displays(SF_MULTI, DISPLAY_MULTI, ACTIVITY_MULTI)] == [0, 4]
    assert [item.id for item in android.merge_displays(SF_MULTI, DISPLAY_MULTI, active_one)] == [0, 4, 7]


def test_non_mumu_external_display_can_be_empty() -> None:
    """外接显示器不属于 MuMu 的预留标签页，不按 Activity 过滤。"""
    sf = 'Display 1 (HWC display 0): displayName="panel"\nDisplay 2 (HWC display 1): displayName="HDMI"\n'
    dm = (
        'mBaseDisplayInfo=DisplayInfo{"panel", displayId 0, real 100 x 200, uniqueId "local:1"}\n'
        'mBaseDisplayInfo=DisplayInfo{"HDMI", displayId 5, real 300 x 400, uniqueId "local:2"}\n'
    )
    assert [item.id for item in android.merge_displays(sf, dm, "")] == [0, 5]


def test_merge_displays_single_screen_keeps_primary() -> None:
    """普通手机：只有一块屏，且必须被认成主屏（哪怕 DisplayManager 那边名字不一样）。"""
    sf = 'Display 1080000000 (HWC display 0): port=0 pnpId=QCOM displayName="qcom,mdss_dsi"\n'
    display = (
        '  mBaseDisplayInfo=DisplayInfo{"内置屏幕", displayId 0, displayGroupId 0, FLAG_SECURE, '
        'real 1080 x 1920, largest app 1080 x 1920, uniqueId "local:1080000000", app 1080 x 1920}\n'
    )
    merged = android.merge_displays(sf, display)
    assert len(merged) == 1
    assert merged[0].id == 0 and merged[0].primary is True
    assert merged[0].size == (1080, 1920)


def test_merge_displays_skips_unregistered_extra_screen() -> None:
    """SurfaceFlinger 认、DisplayManager 没登记的屏：没有屏号就没法在界面里选，跳过。"""
    sf = SF_MULTI
    merged = android.merge_displays(sf, "")  # 没给 dumpsys display
    assert [item.id for item in merged] == [0]


def test_display_devices_only_expands_extra_screens() -> None:
    base = DeviceInfo(
        id="android:emulator-5554",
        uri="Android:///?serial=emulator-5554",
        name="MuMu 12",
        kind=KIND_EMULATOR,
        serial="emulator-5554",
        model="23113RKC6C",
    )
    displays = [
        android.DisplayInfo(id=0, name="mumuscreen000", physical_id=1, primary=True),
        android.DisplayInfo(
            id=4,
            name="mumuscreen003",
            physical_id=2,
            size=(900, 1600),
            top_app="com.netease.onmyoji.wyzymnqsd_cps",
        ),
        android.DisplayInfo(id=7, name="mumuscreen005", physical_id=3, size=(900, 1600)),
    ]
    rows = android.display_devices("emulator-5554", base, displays)
    assert [row.id for row in rows] == ["android:emulator-5554:2"]
    assert rows[0].uri == "Android:///?serial=emulator-5554&display=4&physical=2"
    assert rows[0].kind == KIND_EMULATOR
    assert rows[0].resolution == (900, 1600)
    # 行名要在截断前就能看出是哪块屏 / 哪个应用（包名放屏号后面、屏名前面）
    assert rows[0].name == "MuMu 12 · 屏4 · com.netease.onmyoji.wyzymnqsd_cps"
    # 预分配的屏7没有应用，直接传入列表也不能被展开成假窗口。


def test_display_row_id_equals_session_id() -> None:
    """列表里的 id 必须和引擎建会话时算出来的 id 一字不差，否则界面会一直显示"连接中"。"""
    from gamepilot.rpc.session import device_id_for, parse_device_uri

    scheme, options = parse_device_uri(android.make_display_uri("emulator-5554", 4, 4619827144452474627))
    assert (scheme, options["serial"], options["display"], options["physical"]) == (
        "android",
        "emulator-5554",
        4,
        4619827144452474627,
    )
    assert device_id_for(scheme, options) == "android:emulator-5554:4619827144452474627"
    # 屏号 4 → 13，物理屏未变：仍是同一个会话。手输旧 URI 则保持旧兼容语义。
    renumbered = parse_device_uri(android.make_display_uri("emulator-5554", 13, 4619827144452474627))
    assert device_id_for(*renumbered) == device_id_for(scheme, options)
    assert device_id_for(*parse_device_uri(android.make_display_uri("emulator-5554", 4))) == "android:emulator-5554:4"

    # 主屏没有 display 后缀：两种写法（带 0 / 不带）必须是同一个会话
    for uri in ("Android:///?serial=emulator-5554", "Android:///?serial=emulator-5554&display=0"):
        scheme, options = parse_device_uri(uri)
        assert device_id_for(scheme, options) == "android:emulator-5554"


def test_controller_display_option_normalization() -> None:
    assert android.AndroidController(serial="x").display == 0
    assert android.AndroidController(serial="x", display="0").display == 0
    assert android.AndroidController(serial="x", display=4).display == 4
    # 物理 id 也认（很长，不是逻辑屏号）
    assert android.AndroidController(serial="x", display="4619827144452474627").display == 4619827144452474627


# --------------------------------------------------------------------------- #
# 扫描
# --------------------------------------------------------------------------- #


def test_scan_never_raises() -> None:
    result = scan()
    assert isinstance(result.errors, list)


def test_scan_result_is_json_serializable() -> None:
    payload = scan().to_dict()
    encoded = json.dumps(payload, ensure_ascii=False)
    assert "devices" in json.loads(encoded)


# --------------------------------------------------------------------------- #
# RPC 往返（真实子进程，不读真机结果）
# --------------------------------------------------------------------------- #


def _call(method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    return _call_many([{"method": method, "params": params or {}}])[0]


def _call_many(requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """起一个引擎子进程，依次发若干请求，返回各自的响应（中间的**通知**跳过）。

    "先连接、再列设备"这类要走同一个进程：一条请求一个进程做不到。
    """
    # 当前脚本与工作区都指到临时目录：子进程绝不能碰仓库里的 workspaces/
    scratch = tempfile.mkdtemp(prefix="gamepilot-discovery-")
    proc = subprocess.Popen(
        [sys.executable, "-m", MODULE],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env={
            **os.environ,
            "GAMEPILOT_LOG_LEVEL": "WARNING",
            "GAMEPILOT_PROJECT_DIR": os.path.join(scratch, "default"),
            "GAMEPILOT_WORKSPACE_DIR": os.path.join(scratch, "workspaces", "默认"),
            "GAMEPILOT_CONFIG_DIR": os.path.join(scratch, "config"),
        },
    )
    try:
        assert proc.stdout is not None and proc.stdin is not None
        ready = json.loads(proc.stdout.readline())
        assert ready["method"] == "engine.ready"
        answers: list[dict[str, Any]] = []
        for index, request in enumerate(requests, start=1):
            message = {"jsonrpc": "2.0", "id": index, **request}
            proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()
            while True:
                line = proc.stdout.readline()
                assert line, f"引擎没回话: {message['method']}"
                frame = json.loads(line)
                assert isinstance(frame, dict), f"响应必须是 JSON 对象: {frame!r}"
                if frame.get("id") == index:
                    answers.append(frame)
                    break
        proc.stdin.close()
        proc.wait(timeout=5)
        return answers
    finally:
        # 收尸：没 wait 过的子进程会在 __del__ 里抛（仓库 filterwarnings=error，会判成失败）
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=5)
        for stream in (proc.stdout, proc.stderr, proc.stdin):
            if stream:
                stream.close()


def test_device_list_rpc_over_stdio() -> None:
    response = _call("device.list", {"scan": False})
    assert "error" not in response, response
    result = response["result"]
    assert isinstance(result["devices"], list)
    assert result["errors"] == []
    assert result["devices"] == []


def test_device_list_reports_live_sessions_as_connected() -> None:
    """引擎已经带着的设备要在 device.list 里报 `connected`。

    界面重载后前端状态是空的，只靠连接那一刻的通知来认"连着"——列表里带上真实状态，
    界面才不会在画面还在推的时候显示"未连接"。
    """
    from types import SimpleNamespace

    from gamepilot.rpc.devices import _mark_connected

    server = SimpleNamespace(
        sessions=SimpleNamespace(
            sessions={
                "android:abc": SimpleNamespace(started=True),
                "android:idle": SimpleNamespace(started=False),
            }
        )
    )
    result = {
        "devices": [
            {"id": "android:abc", "status": "discovered"},
            {"id": "android:idle", "status": "discovered"},
            {"id": "android:other", "status": "discovered"},
        ],
        "errors": [],
    }
    listed = {item["id"]: item for item in _mark_connected(server, result)["devices"]}
    assert listed["android:abc"]["status"] == "connected"
    assert listed["android:idle"]["status"] == "discovered"
    assert listed["android:other"]["status"] == "discovered"


# --------------------------------------------------------------------------- #
# 本机模拟器：adb 不会自动列出 MuMu / 雷电 / 夜神，扫描时要补 adb connect
# --------------------------------------------------------------------------- #


def test_emulator_ports_only_connect_listening_unlisted_ports() -> None:
    opened = {16384, 62001}
    assert android.emulator_ports_to_connect(set(), is_open=lambda port: port in opened) == [16384, 62001]
    # 已经在 adb 列表里的不重复连
    assert android.emulator_ports_to_connect({"127.0.0.1:16384"}, is_open=lambda port: port in opened) == [62001]
    # 雷电 / AVD 自动注册成 emulator-<端口-1>
    assert android.emulator_ports_to_connect({"emulator-5554"}, is_open=lambda port: port == 5555) == []


def test_emulator_ports_skip_mumu12_alias_ports() -> None:
    """MuMu 12 同时监听 16384 / 7555 / 5555 指向同一台，只连 16384。"""
    opened = {16384, 7555, 5555}
    assert android.emulator_ports_to_connect(set(), is_open=lambda port: port in opened) == [16384]
    # 没有 16384 系时（MuMu 6 / 雷电）别名端口照常连
    assert android.emulator_ports_to_connect(set(), is_open=lambda port: port == 7555) == [7555]


def test_connect_local_emulators_reports_new_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(android, "_port_open", lambda port, *args, **kwargs: port == 16384)
    calls: list[str] = []

    class FakeClient:
        def connect(self, address: str, timeout: float | None = None) -> str:
            calls.append(address)
            return f"connected to {address}"

    assert android.connect_local_emulators(FakeClient(), set()) is True
    assert calls == ["127.0.0.1:16384"]


def test_connect_local_emulators_ignores_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(android, "_port_open", lambda port, *args, **kwargs: port == 16384)

    class BrokenClient:
        def connect(self, address: str, timeout: float | None = None) -> str:
            raise RuntimeError("adb 挂了")

    assert android.connect_local_emulators(BrokenClient(), set()) is False


# --------------------------------------------------------------------------- #
# URI 解析（回归：数字型 serial 被转成 int 会导致截图慢 3 倍）
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("uri", "scheme", "expected"),
    [
        ("Android:///?serial=3387980", "android", {"serial": "3387980"}),
        ("Android:///?serial=emulator-5554", "android", {"serial": "emulator-5554"}),
        (
            "Synthetic:///?serial=test-1&width=640&height=360",
            "synthetic",
            {"serial": "test-1", "width": 640, "height": 360},
        ),
        ("Android:///", "android", {}),
    ],
)
def test_parse_device_uri(uri: str, scheme: str, expected: dict[str, object]) -> None:
    from gamepilot.rpc.session import parse_device_uri

    parsed_scheme, options = parse_device_uri(uri)
    assert parsed_scheme == scheme
    assert options == expected


def test_parse_device_uri_keeps_serial_as_string() -> None:
    """纯数字 serial 必须保持字符串：int 进 subprocess argv 会抛 TypeError。"""
    from gamepilot.rpc.session import parse_device_uri

    _, options = parse_device_uri("Android:///?serial=3387980")
    assert isinstance(options["serial"], str)
    assert options["serial"] == "3387980"


def test_parse_device_uri_rejects_empty() -> None:
    """空 URI 必须明确报错，而不是让上层拿到一个空 scheme。"""
    from gamepilot.rpc.session import parse_device_uri

    with pytest.raises(ValueError, match="无法解析设备 URI"):
        parse_device_uri("://")


def test_parse_device_uri_bare_scheme_is_accepted() -> None:
    """裸 scheme 是允许的写法：由注册表决定是否支持。"""
    from gamepilot.rpc.session import parse_device_uri

    scheme, options = parse_device_uri("Android")
    assert scheme == "android"
    assert options == {}


def test_parse_device_uri_keeps_udid_and_leading_zeros_as_string() -> None:
    """udid / serial 是标识：不能被当成数字（`0012` → 12、`123456e789` → 浮点）。"""
    from gamepilot.rpc.session import parse_device_uri

    _, options = parse_device_uri("iOS:///?udid=123456e789")
    assert options == {"udid": "123456e789"}
    _, options = parse_device_uri("Android:///?serial=0012")
    assert options == {"serial": "0012"}
    _, options = parse_device_uri("iOS:///?udid=00008110-000665303413801E")
    assert options == {"udid": "00008110-000665303413801E"}
