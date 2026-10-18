"""构建 Tauri externalBin 用的 Python 引擎 sidecar（Windows x64）。"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

from fetch_release_assets import ensure_adb_from_venv, ensure_ocr_models, ensure_scrcpy_server

ENGINE_ROOT = Path(__file__).resolve().parent.parent
DESKTOP_ROOT = ENGINE_ROOT.parent / "apps" / "desktop"
TAURI_BIN_DIR = DESKTOP_ROOT / "src-tauri" / "binaries"
ENTRY = Path(__file__).resolve().parent / "engine_sidecar_entry.py"
BUILD_DIR = ENGINE_ROOT / "build" / "sidecar-pyinstaller"
DIST_DIR = BUILD_DIR / "dist"


def target_triple() -> str:
    env = os.environ.get("TAURI_ENV_TARGET_TRIPLE", "").strip()
    if env:
        return env
    machine = platform.machine().lower()
    if sys.platform == "win32" and machine in ("amd64", "x86_64"):
        return "x86_64-pc-windows-msvc"
    if sys.platform == "darwin" and machine == "arm64":
        return "aarch64-apple-darwin"
    if sys.platform == "darwin":
        return "x86_64-apple-darwin"
    raise SystemExit(f"未支持的构建平台: {sys.platform} {machine}")


def sidecar_filename(triple: str) -> str:
    ext = ".exe" if triple.endswith("windows-msvc") else ""
    return f"gamepilot-engine-{triple}{ext}"


def run_pyinstaller(adb_dir: Path, scrcpy_server: Path, ocr_dir: Path) -> Path:
    sep = ";" if sys.platform == "win32" else ":"
    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    def add_data(src: Path, dest: str) -> list[str]:
        return ["--add-data", f"{src}{sep}{dest}"]

    cmd: list[str] = [
        sys.executable,
        "-m",
        "PyInstaller",
        str(ENTRY),
        "--name",
        "gamepilot-engine",
        "--onefile",
        "--console",
        "--noconfirm",
        "--clean",
        f"--distpath={DIST_DIR}",
        f"--workpath={BUILD_DIR / 'work'}",
        f"--specpath={BUILD_DIR}",
        "--collect-submodules",
        "gamepilot",
        "--collect-all",
        "adbutils",
        "--collect-all",
        "rapidocr_onnxruntime",
        "--collect-all",
        "onnxruntime",
        "--collect-all",
        "cv2",
        "--collect-all",
        "av",
        "--collect-all",
        "pymobiledevice3",
        "--hidden-import",
        "gamepilot.rpc.stdio",
        *add_data(scrcpy_server, "vendor"),
        *add_data(ocr_dir, "gamepilot/assets/ppocr_v4"),
    ]
    for name in ("adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll"):
        src = adb_dir / name
        if src.is_file():
            cmd.extend(add_data(src, "adb"))
    print("PyInstaller:", " ".join(cmd))
    subprocess.run(cmd, cwd=ENGINE_ROOT, check=True)
    built = DIST_DIR / ("gamepilot-engine.exe" if sys.platform == "win32" else "gamepilot-engine")
    if not built.is_file():
        raise SystemExit(f"PyInstaller 未产出 {built}")
    return built


def main() -> None:
    ensure_ocr_models()
    ensure_scrcpy_server()
    adb_dir = ensure_adb_from_venv()
    ocr_dir = ENGINE_ROOT / "src" / "gamepilot" / "assets" / "ppocr_v4"
    scrcpy_server = ENGINE_ROOT / "vendor" / "scrcpy-server"

    try:
        import PyInstaller  # noqa: F401
    except ImportError as exc:
        raise SystemExit("请安装打包依赖: cd engine && uv sync --group packaging") from exc

    built = run_pyinstaller(adb_dir, scrcpy_server, ocr_dir)
    triple = target_triple()
    TAURI_BIN_DIR.mkdir(parents=True, exist_ok=True)
    dest = TAURI_BIN_DIR / sidecar_filename(triple)
    shutil.copy2(built, dest)
    print(f"sidecar 已写入 → {dest} ({dest.stat().st_size // (1024 * 1024)} MiB)")


if __name__ == "__main__":
    main()
