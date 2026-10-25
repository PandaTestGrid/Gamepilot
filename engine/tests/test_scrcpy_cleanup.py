"""scrcpy 残留 server 清理 + 首帧等待上限。

设备端残留的 `app_process ... scrcpy.Server` 会一直占着编码器：新 server 的首帧
从 ~0.2s 退化到数秒，最终表现为「投屏启动失败：视频首帧未到」，而每次失败如果
没清干净又会再加一个。这里钉住三件事：

1. 本进程第一次连某台设备时清掉残留 server 和遗留的 adb forward；
2. 关闭通道时按 scid 精确杀掉自己的远端 server（不能只杀本地 adb 客户端）；
3. 首帧等待上限默认 5s（原来 2s 太短），且可用环境变量覆盖。
"""

from __future__ import annotations

import subprocess
from typing import Any

import pytest

from gamepilot.devices import scrcpy


def _result(stdout: str = "", returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr="")


def test_clean_stale_servers_kills_leftover_and_removes_forwards(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, ...]] = []

    def fake_adb_quiet(_adb: str, _serial: str, *args: str, timeout: float = 8.0) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        if args[:2] == ("shell", "ps"):
            return _result(
                "  PID ARGS\n"
                "  123 app_process / com.genymobile.scrcpy.Server 3.3.4 scid=0000000a display_id=0\n"
                "  124 sh -c CLASSPATH=/data/local/tmp/x.jar app_process / com.genymobile.scrcpy.Server 3.3.4 scid=0000000a\n"
                "  456 app_process / com.genymobile.scrcpy.Server 3.3.4 scid=0000000b display_id=2\n"
                "  789 com.other.app\n"
            )
        if args[:2] == ("forward", "--list"):
            return _result(
                "127.0.0.1:16384 tcp:50123 localabstract:scrcpy_0000000a\n"
                "127.0.0.1:16384 tcp:50456 localabstract:scrcpy_0000000b\n"
                "other-serial tcp:50789 localabstract:scrcpy_0000000c\n"
            )
        return _result()

    monkeypatch.setattr(scrcpy, "_adb_quiet", fake_adb_quiet)

    killed = scrcpy.clean_stale_servers("127.0.0.1:16384", "adb")

    assert killed == 2
    assert ("shell", "kill", "-9", "123") in calls
    assert ("shell", "kill", "-9", "456") in calls
    # `sh -c` 包装壳不杀掉（杀了它 app_process 会变孤儿，真正的 server 由 123 那行处理）
    assert ("shell", "kill", "-9", "124") not in calls
    # 只收本设备的 forward，别的设备不动
    assert ("forward", "--remove", "tcp:50123") in calls
    assert ("forward", "--remove", "tcp:50456") in calls
    assert ("forward", "--remove", "tcp:50789") not in calls
    # 非 scrcpy 进程不能被误杀
    assert not any(call[:3] == ("shell", "kill", "-9") and call[-1] == "789" for call in calls)


def test_ensure_device_clean_only_once_per_serial(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(scrcpy, "_CLEANED_SERIALS", set())
    cleaned: list[str] = []

    def fake_clean(serial: str, _adb: str) -> int:
        cleaned.append(serial)
        return 0

    monkeypatch.setattr(scrcpy, "clean_stale_servers", fake_clean)

    scrcpy.ensure_device_clean("emulator-5554", "adb")
    scrcpy.ensure_device_clean("emulator-5554", "adb")
    scrcpy.ensure_device_clean("emulator-5556", "adb")

    assert cleaned == ["emulator-5554", "emulator-5556"]


def test_ensure_device_clean_survives_adb_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(scrcpy, "_CLEANED_SERIALS", set())

    def boom(*_args: Any, **_kwargs: Any) -> int:
        raise RuntimeError("adb 挂了")

    monkeypatch.setattr(scrcpy, "clean_stale_servers", boom)

    scrcpy.ensure_device_clean("emulator-5554", "adb")  # 不抛

    # 失败也登记过：同一进程里不要每次连接都重试拖慢启动
    assert "emulator-5554" in scrcpy._CLEANED_SERIALS


def test_channel_close_kills_only_own_remote_server(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, ...]] = []

    def fake_adb_quiet(_adb: str, _serial: str, *args: str, timeout: float = 8.0) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        if args[:2] == ("shell", "ps"):
            return _result(
                "  PID ARGS\n"
                "  123 app_process / com.genymobile.scrcpy.Server 3.3.4 scid=0000abcd display_id=0\n"
                "  124 sh -c CLASSPATH=/data/local/tmp/x.jar app_process / com.genymobile.scrcpy.Server 3.3.4 scid=0000abcd\n"
                "  456 app_process / com.genymobile.scrcpy.Server 3.3.4 scid=0000ffff display_id=2\n"
            )
        return _result()

    monkeypatch.setattr(scrcpy, "_adb_quiet", fake_adb_quiet)

    channel = scrcpy.ScrcpyChannel.__new__(scrcpy.ScrcpyChannel)  # 不跑 __init__：没有真设备
    channel.adb_path = "adb"
    channel.serial = "emulator-5554"
    channel.scid = 0xABCD
    channel._stop = type("Stop", (), {"set": lambda self: None})()
    channel._video = None
    channel._control = None
    channel._decoder_thread = None
    channel._server = None
    channel._port = 0

    channel._kill_remote_server()

    assert ("shell", "kill", "-9", "123") in calls
    assert ("shell", "kill", "-9", "124") in calls  # 包装壳也清掉
    assert ("shell", "kill", "-9", "456") not in calls  # 别的 scid（其它屏）不能碰


def test_first_frame_timeout_default_and_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GAMEPILOT_SCRCPY_FIRST_FRAME_TIMEOUT", raising=False)
    channel = scrcpy.ScrcpyChannel("emulator-5554", "adb", "scrcpy-server.jar")
    assert channel.first_frame_timeout == 5.0

    monkeypatch.setenv("GAMEPILOT_SCRCPY_FIRST_FRAME_TIMEOUT", "8.5")
    channel = scrcpy.ScrcpyChannel("emulator-5554", "adb", "scrcpy-server.jar")
    assert channel.first_frame_timeout == 8.5


@pytest.mark.parametrize("value", ["", "abc", "0", "-1"])
def test_first_frame_timeout_bad_env_falls_back_to_default(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    if value:
        monkeypatch.setenv("GAMEPILOT_SCRCPY_FIRST_FRAME_TIMEOUT", value)
    else:
        monkeypatch.delenv("GAMEPILOT_SCRCPY_FIRST_FRAME_TIMEOUT", raising=False)
    channel = scrcpy.ScrcpyChannel("emulator-5554", "adb", "scrcpy-server.jar")
    assert channel.first_frame_timeout == 5.0
