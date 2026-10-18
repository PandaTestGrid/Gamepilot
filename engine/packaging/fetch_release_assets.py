"""发布构建前补齐 vendor / OCR 模型（本地生成，不入库）。"""

from __future__ import annotations

import io
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parent.parent
VENDOR_SERVER = ENGINE_ROOT / "vendor" / "scrcpy-server"
OCR_DIR = ENGINE_ROOT / "src" / "gamepilot" / "assets" / "ppocr_v4"
SCRCPY_VERSION = "3.3.4"
SCRCPY_WIN_ZIP = (
    f"https://github.com/Genymobile/scrcpy/releases/download/v{SCRCPY_VERSION}/scrcpy-win64-v{SCRCPY_VERSION}.zip"
)
OCR_FILES = (
    "ch_PP-OCRv4_det_infer.onnx",
    "ch_ppocr_mobile_v2.0_cls_infer.onnx",
    "ch_PP-OCRv4_rec_infer.onnx",
)


def _venv_site_packages() -> Path | None:
    for base in (ENGINE_ROOT / ".venv" / "Lib" / "site-packages",):
        if base.is_dir():
            return base
    return None


def ensure_ocr_models() -> None:
    OCR_DIR.mkdir(parents=True, exist_ok=True)
    if all((OCR_DIR / name).is_file() for name in OCR_FILES):
        print(f"OCR 模型已就绪: {OCR_DIR}")
        return
    site = _venv_site_packages()
    if site is None:
        raise SystemExit("缺少 OCR 模型：请先 `cd engine && uv sync --extra ocr`")
    wheel_models = site / "rapidocr_onnxruntime" / "models"
    if not wheel_models.is_dir():
        raise SystemExit("rapidocr_onnxruntime 未安装，请 `uv sync --extra ocr`")
    for name in OCR_FILES:
        src = wheel_models / name
        dst = OCR_DIR / name
        if not src.is_file():
            raise SystemExit(f"wheel 内缺少 {name}")
        if not dst.is_file():
            shutil.copy2(src, dst)
            print(f"已复制 OCR 模型 → {dst}")
    print(f"OCR 模型已就绪: {OCR_DIR}")


def ensure_scrcpy_server() -> None:
    if VENDOR_SERVER.is_file() and VENDOR_SERVER.stat().st_size > 10_000:
        print(f"scrcpy-server 已就绪: {VENDOR_SERVER}")
        return
    VENDOR_SERVER.parent.mkdir(parents=True, exist_ok=True)
    print(f"下载 scrcpy {SCRCPY_VERSION} …")
    with urllib.request.urlopen(SCRCPY_WIN_ZIP, timeout=120) as response:
        payload = response.read()
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        member = next((n for n in archive.namelist() if n.endswith("scrcpy-server")), None)
        if member is None:
            raise SystemExit("scrcpy 压缩包内找不到 scrcpy-server")
        VENDOR_SERVER.write_bytes(archive.read(member))
    print(f"已写入 scrcpy-server → {VENDOR_SERVER}")


def ensure_adb_from_venv() -> Path:
    site = _venv_site_packages()
    if site is None:
        raise SystemExit("请先 `cd engine && uv sync --extra ocr`")
    adb_dir = site / "adbutils" / "binaries"
    adb_exe = adb_dir / ("adb.exe" if sys.platform == "win32" else "adb")
    if not adb_exe.is_file():
        raise SystemExit(f"adbutils 内置 adb 缺失: {adb_exe}")
    return adb_dir


def main() -> None:
    ensure_ocr_models()
    ensure_scrcpy_server()
    ensure_adb_from_venv()
    print("发布资源检查完成。")


if __name__ == "__main__":
    main()
