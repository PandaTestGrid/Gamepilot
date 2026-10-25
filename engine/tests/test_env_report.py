"""adb 环境快照：别人电脑上"引擎跑不起来"的第一现场。

122 行那条最容易踩：adbutils 的查找顺序是 **环境变量 → 系统 PATH → 自带的**，
所以"自带的 adb 被杀软隔离"时会静默退回系统 adb；同事机器上没装 platform-tools → 设备列表空。
`adbSource` 就是用来在日志里一眼分清这件事的。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from gamepilot.devices import env_report


def test_log_once_does_not_repeat_environment_commands(monkeypatch: pytest.MonkeyPatch) -> None:
    reports: list[int] = []

    def report() -> dict[str, Any]:
        reports.append(1)
        return {"adbVersionError": None, "port5037Owner": None, "devicesError": None}

    monkeypatch.setattr(env_report, "_logged", False)
    monkeypatch.setattr(env_report, "_cached_report", None, raising=False)
    monkeypatch.setattr(env_report, "adb_report", report)
    monkeypatch.setattr(env_report, "describe", lambda _report: "test")
    env_report.log_once()
    env_report.log_once()
    assert len(reports) == 1


def test_adb_source_env_when_pinned(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fake = tmp_path / "adb.exe"
    fake.write_text("x", encoding="utf-8")
    monkeypatch.setenv("ADBUTILS_ADB_PATH", str(fake))
    assert env_report.adb_source(str(fake)) == "env"


def test_adb_source_system_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fake = tmp_path / "adb.exe"
    fake.write_text("x", encoding="utf-8")
    monkeypatch.delenv("ADBUTILS_ADB_PATH", raising=False)
    monkeypatch.setattr("shutil.which", lambda name: str(fake) if name == "adb" else None)
    assert env_report.adb_source(str(fake)) == "system-path"


def test_adb_source_bundled_and_missing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    bundled = tmp_path / "_MEI123" / "adb" / "adb.exe"
    bundled.parent.mkdir(parents=True)
    bundled.write_text("x", encoding="utf-8")
    monkeypatch.delenv("ADBUTILS_ADB_PATH", raising=False)
    monkeypatch.setattr("shutil.which", lambda name: None)
    assert env_report.adb_source(str(bundled)) == "bundled"
    assert env_report.adb_source(str(tmp_path / "nope" / "adb.exe")) == "missing"


def test_adb_source_bundled_even_when_pinned_by_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """冻结态：我们自己把自带的 adb 钉进 ADBUTILS_ADB_PATH，别把它报成"env"（分不清是谁设的）。"""
    bundle = tmp_path / "_MEI123"
    bundled = bundle / "adb" / "adb.exe"
    bundled.parent.mkdir(parents=True)
    bundled.write_text("x", encoding="utf-8")
    monkeypatch.setenv("ADBUTILS_ADB_PATH", str(bundled))
    monkeypatch.setattr(env_report, "frozen_bundle_root", lambda: bundle, raising=False)
    import gamepilot.runtime_paths as runtime_paths

    monkeypatch.setattr(runtime_paths, "frozen_bundle_root", lambda: bundle)
    assert env_report.adb_source(str(bundled)) == "bundled"


def test_device_lines_counts_real_devices() -> None:
    lines = ["List of devices attached", "", "AGY7N19408000158\tdevice product:x", "emulator-5554\tunauthorized"]
    assert env_report._device_lines(lines) == 2


def test_describe_mentions_source(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fake = tmp_path / "adb.exe"
    fake.write_text("x", encoding="utf-8")
    monkeypatch.setenv("ADBUTILS_ADB_PATH", str(fake))
    report = {
        "adbPath": str(fake),
        "adbSource": "env",
        "adbVersion": "Android Debug Bridge version 1.0.41",
        "adbVersionError": None,
        "port5037Owner": "adb.exe (PID 1)",
        "devices": ["List of devices attached", "x\tdevice"],
        "devicesError": None,
    }
    text = env_report.describe(report)
    assert "adb=" in text and "（env）" in text and "设备=1 台" in text
