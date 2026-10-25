"""这台机器的 adb 环境快照：adb 路径 / 版本 / 5037 端口占用 / 设备列表。

为什么单独一份：「在我电脑上好好的，别人电脑上引擎 timeout 而且日志里什么都没有」，
九成出在 adb 这一层 —— 自带 adb.exe 被杀软拦、5037 上蹲着模拟器或 Android Studio 的另一个
adb（版本冲突）、手机没点「允许 USB 调试」、机器没有 USB 驱动。这四件事一次问全，
写一条日志（首次扫描时自动写），再挂一个 `engine.diagnostics` 给人手动查。
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger("gamepilot.devices.env")

#: 每条命令的超时（秒）：这里只做诊断，绝不为了它把引擎拖住
VERSION_TIMEOUT = 5.0
DEVICES_TIMEOUT = 8.0
NETSTAT_TIMEOUT = 5.0

_logged = False
_cached_report: dict[str, Any] | None = None
_report_lock = threading.Lock()


def _run(command: list[str], timeout: float) -> tuple[int | None, str, str]:
    """跑一条命令，**永远不抛**：返回 (退出码 | None, stdout, stderr)。"""
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        return None, "", f"超时（>{timeout:.0f}s）"
    except Exception as exc:  # 找不到可执行文件 / 被杀软拦住
        return None, "", str(exc)
    return result.returncode, result.stdout or "", result.stderr or ""


def adb_binary() -> str:
    """和真正干活的那条路用**同一个** adb（android._adb_binary）。"""
    try:
        from .android import _adb_binary

        return _adb_binary()
    except Exception:
        return "adb"


def _port_5037_owner() -> str | None:
    """谁在听 5037：adb server 之外还蹲着别人（MuMu / 夜神 / Android Studio）就会打架。"""
    if os.name != "nt":
        return None
    code, out, _ = _run(["netstat", "-ano", "-p", "tcp"], NETSTAT_TIMEOUT)
    if code is None:
        return None
    for line in out.splitlines():
        parts = line.split()
        # TCP    127.0.0.1:5037    0.0.0.0:0    LISTENING    1234
        if (
            len(parts) >= 5
            and parts[0].upper() == "TCP"
            and parts[1].endswith(":5037")
            and "LISTENING" in parts[3].upper()
        ):
            pid = parts[4]
            name = _process_name(pid)
            return f"{name} (PID {pid})" if name else f"PID {pid}"
    return None


def _process_name(pid: str) -> str | None:
    code, out, _ = _run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], NETSTAT_TIMEOUT)
    if code != 0 or not out.strip():
        return None
    first = out.strip().splitlines()[0]
    cells = first.split(",")
    return cells[0].strip('"') if cells else None


def adb_source(binary: str) -> str:
    """这份 adb 是哪来的：环境变量 / 系统 PATH / 自带（解压目录）/ 找不到。

    为什么要单独标出来：adbutils 的查找顺序是 **环境变量 → 系统 PATH → 自带的**（`_utils.py: adb_path`），
    所以"自带的那份被杀软隔离了"时会**静默退回系统 adb** —— 同事机器上没装 platform-tools，
    结果就是设备列表空、只有一条 warning。标出来一眼就能分辨。
    """
    if not binary or not os.path.isfile(binary):
        return "missing"
    # 冻结态下"自带的"是被我们自己用 ADBUTILS_ADB_PATH 钉上去的，光看环境变量分不出
    # "我们自带的"和"别人设的"，所以先按**路径**认：在解压目录的 adb\ 下面就是自带的。
    try:
        from gamepilot.runtime_paths import frozen_bundle_root

        root = frozen_bundle_root()
        if root is not None:
            Path(binary).resolve().relative_to((root / "adb").resolve())
            return "bundled"
    except Exception:
        # 注意：这里**只该吞 OSError**（路径不存在/没权限）。以前是 Exception 全吞，
        # 结果 `Path` 没导入的 NameError 被一起吞掉 → adb 来源永远报 "env"（查了半天）。
        pass
    env_path = os.environ.get("ADBUTILS_ADB_PATH") or ""
    if env_path and os.path.normcase(env_path) == os.path.normcase(binary):
        return "env"
    import shutil

    found = shutil.which("adb")
    if found and os.path.normcase(found) == os.path.normcase(binary):
        return "system-path"
    return "bundled"


def adb_report() -> dict[str, Any]:
    """adb 环境的全量快照（给日志和 engine.diagnostics 用）。"""
    binary = adb_binary()
    version_code, version_out, version_err = _run([binary, "version"], VERSION_TIMEOUT)
    devices_code, devices_out, devices_err = _run([binary, "devices", "-l"], DEVICES_TIMEOUT)
    return {
        "adbPath": binary,
        "adbSource": adb_source(binary),
        "adbExists": os.path.isfile(binary),
        "adbVersion": (version_out.strip().splitlines() or [""])[0] if version_code == 0 else None,
        "adbVersionError": None if version_code == 0 else (version_err.strip() or f"exit {version_code}"),
        "devices": [line for line in devices_out.splitlines() if line.strip()][:40],
        "devicesError": devices_err.strip() or None,
        "devicesExit": devices_code,
        "port5037Owner": _port_5037_owner(),
        "adbFromEnv": os.environ.get("ADBUTILS_ADB_PATH") or None,
        "frozen": bool(getattr(__import__("sys"), "frozen", False)),
    }


def _device_lines(devices: list[str]) -> int:
    """`adb devices` 输出里真正是设备的行数（去掉表头与空行）。"""
    return sum(1 for line in devices if line.strip() and not line.startswith("List of devices"))


def describe(report: dict[str, Any]) -> str:
    """一行摘要：日志里扫一眼就知道这台机器的 adb 是什么状况。"""
    parts = [
        f"adb={report['adbPath']}（{report.get('adbSource', '?')}）",
        f"version={report['adbVersion'] or report['adbVersionError'] or '拿不到'}",
        f"5037={report['port5037Owner'] or '没人在听'}",
        f"设备={_device_lines(report['devices'])} 台",
    ]
    if report["devicesError"]:
        parts.append(f"stderr={report['devicesError'][:120]}")
    return " · ".join(parts)


def log_once() -> dict[str, Any]:
    """首次扫描时把环境快照写进日志（只写一次）。返回快照，方便 RPC 复用同一份语义。"""
    global _logged, _cached_report
    with _report_lock:
        if _cached_report is None:
            _cached_report = adb_report()
        report = _cached_report
        should_log = not _logged
        _logged = True
    if should_log:
        logger.info("adb 环境: %s", describe(report))
        if report.get("adbSource") == "missing":
            logger.warning(
                "找不到任何 adb（自带的那份可能被杀软删了/隔离了，系统里也没装 platform-tools）："
                "设备会一个都扫不到 —— 把安装目录与 %%TEMP%% 加进杀软白名单，或单独装 platform-tools"
            )
        if report["adbVersionError"]:
            logger.warning("adb version 跑不起来（杀软拦 / 路径不对 / adb 被删）: %s", report["adbVersionError"])
        # 5037 被 adb 自己听着是**正常**的（adb server 就在那儿），别当异常喊；
        # 只有"监听者不是 adb"才说明端口被别人抢了 —— adb 起不了自己的 server，命令会没反应
        owner = report["port5037Owner"] or ""
        if owner and "adb" not in owner.lower():
            logger.warning(
                "5037 端口被非 adb 的进程占着：%s —— adb 起不了自己的 server，命令会没反应/超时",
                owner,
            )
        if report["devicesError"]:
            logger.warning("adb devices 有 stderr（版本冲突/授权问题通常写在这里）: %s", report["devicesError"][:300])
    return report
