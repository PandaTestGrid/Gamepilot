"""PyInstaller 冻结态下的资源路径（adb / scrcpy-server / OCR 模型）。"""

from __future__ import annotations

import os
import sys
from pathlib import Path


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


def configure_frozen_environment() -> None:
    """sidecar 启动最早调用：让 adbutils / scrcpy / OCR 走内置资源。"""
    root = frozen_bundle_root()
    if root is None:
        return

    adb_exe = bundled_adb_dir() / ("adb.exe" if os.name == "nt" else "adb")
    if adb_exe.is_file():
        os.environ.setdefault("ADBUTILS_ADB_PATH", str(adb_exe))

    scrcpy = vendor_scrcpy_server()
    if scrcpy.is_file():
        os.environ.setdefault("GAMEPILOT_SCRCPY_SERVER", str(scrcpy))

    ocr_dir = root / "gamepilot" / "assets" / "ppocr_v4"
    if ocr_dir.is_dir():
        os.environ.setdefault("GAMEPILOT_OCR_MODEL_DIR", str(ocr_dir))
