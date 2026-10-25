"""PyInstaller 冻结态下的资源路径（adb / scrcpy-server / OCR 模型）。"""

from __future__ import annotations

import io
import logging
import os
import sys
from pathlib import Path


def configure_stdio_encoding() -> None:
    """stdio 协议固定 UTF-8，冻结态也不能依赖 Windows 系统代码页或 Python 环境变量。"""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace" if stream is sys.stderr else "strict")


def frozen_bundle_root() -> Path | None:
    """onefile 解压目录；非冻结态返回 None。"""
    if not getattr(sys, "frozen", False):
        return None
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass)
    return Path(sys.executable).resolve().parent


def engine_source_root() -> Path:
    """开发态：仓库 engine/ 目录。"""
    return Path(__file__).resolve().parent.parent.parent


def vendor_scrcpy_server() -> Path:
    root = frozen_bundle_root()
    if root is not None:
        return root / "vendor" / "scrcpy-server"
    return engine_source_root() / "vendor" / "scrcpy-server"


def bundled_adb_dir() -> Path:
    root = frozen_bundle_root()
    if root is not None:
        return root / "adb"
    try:
        import adbutils

        return Path(adbutils.adb_path()).resolve().parent
    except Exception:
        return engine_source_root() / ".venv" / "Scripts"


def build_identity() -> dict[str, object]:
    """这一份引擎的"身份"：可执行文件路径 + 大小 + 修改时间。

    为什么要有它：**装了新版却还跑着旧引擎**是真实发生过的事 —— 安装时旧引擎进程还占着
    gamepilot-engine.exe，静默安装会跳过它（"重装了还是老毛病"）。日志里打印一次身份，
    就能一眼对照"现在跑的到底是不是刚装的那份"。
    """
    import sys
    from datetime import datetime

    exe = Path(sys.executable)
    try:
        stat = exe.stat()
    except OSError:
        return {"exePath": str(exe), "exeSize": None, "exeMtime": None}
    return {
        "exePath": str(exe),
        "exeSize": stat.st_size,
        "exeMtime": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
    }


def configure_frozen_environment() -> None:
    """sidecar 启动最早调用：让 adbutils / scrcpy / OCR 走内置资源。"""
    root = frozen_bundle_root()
    if root is None:
        return

    adb_exe = bundled_adb_dir() / ("adb.exe" if os.name == "nt" else "adb")
    if adb_exe.is_file():
        os.environ.setdefault("ADBUTILS_ADB_PATH", str(adb_exe))
    else:
        # 这一步不设环境变量的话，adbutils 会退回"系统 PATH 上的 adb" —— 同事机器上通常没有，
        # 表现就是设备列表永远空的（而且只有一条不起眼的 warning）。这里必须说清楚。
        logging.getLogger("gamepilot.runtime").warning(
            "自带的 adb 不在（%s）：多半被杀软删掉/隔离了。设备会扫不到 —— 把安装目录与 %%TEMP%% 加白，"
            "或单独装 platform-tools 并把 adb 放进 PATH",
            adb_exe,
        )

    scrcpy = vendor_scrcpy_server()
    if scrcpy.is_file():
        os.environ.setdefault("GAMEPILOT_SCRCPY_SERVER", str(scrcpy))

    ocr_dir = root / "gamepilot" / "assets" / "ppocr_v4"
    if ocr_dir.is_dir():
        os.environ.setdefault("GAMEPILOT_OCR_MODEL_DIR", str(ocr_dir))
