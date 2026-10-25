"""构建 YOLO 组件包（onedir worker + 模型 → zip）。

**给发布机用，不是运行时依赖**。引擎主程序不 import 本文件。

前置条件：
- 一个装了 torch / ultralytics 的构建环境（CPU 或 CUDA 版都行，决定组件能力）：
    uv pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
    uv pip install -e ..  # 让 PyInstaller 能 import gamepilot
- 模型目录：`--model-dir`（含 yolov8s-worldv2.pt 与 clip/）或 `GAMEPILOT_YOLO_MODEL_DIR`

产物：
    dist/gamepilot-yolo/<exe> + _internal/ + models/ + manifest.json
    dist/gamepilot-yolo-<version>-<platform>.zip

用法：
    python packaging/build_yolo_component.py --model-dir S:\\models\\yolo --version 0.1.0
    python packaging/build_yolo_component.py --model-dir ... --variant cuda

说明：
- 用 onedir 而不是 onefile：torch 解包一次要几秒，onefile 每次启动都解压。
- 组件 zip 由应用内 `yolo.install` 下载安装；本脚本只负责产出。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ENGINE_ROOT / "src"
BUILD_ROOT = ENGINE_ROOT / "packaging" / ".build" / "yolo-component"
COMPONENT_NAME = "gamepilot-yolo"

ENTRY_TEMPLATE = '''"""YOLO 组件入口（构建时生成，勿手改）。"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _bootstrap() -> None:
    # 模型放在 exe 同级的 models/（onedir），把路径告诉推理层
    base = Path(sys.executable).resolve().parent
    for candidate in (base / "models", Path(getattr(sys, "_MEIPASS", base)) / "models"):
        if candidate.is_dir():
            os.environ.setdefault("GAMEPILOT_YOLO_MODEL_DIR", str(candidate))
            break
    # 组件里可以放多个权重：manifest 的 defaultModel 决定默认用哪个
    manifest = base / "manifest.json"
    if manifest.is_file():
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
            model = str(data.get("defaultModel") or "").strip()
            if model:
                os.environ.setdefault("GAMEPILOT_YOLO_MODEL", model)
        except Exception:
            pass
    # 组件进程独占推理，但别把机器所有核吃满
    os.environ.setdefault("OMP_NUM_THREADS", "1")


_bootstrap()

from gamepilot.core.yolo_worker import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
'''


def _platform_tag() -> str:
    if os.name == "nt":
        return "win-x64"
    if sys.platform == "darwin":
        return "macos-arm64" if os.uname().machine == "arm64" else "macos-x64"
    return "linux-x64"


def _torch_version() -> str:
    try:
        import torch

        return str(torch.__version__)
    except Exception:
        return "unknown"


def _copy_models(model_dir: Path, target: Path) -> None:
    if not model_dir.is_dir():
        raise SystemExit(f"模型目录不存在: {model_dir}")
    if not any(model_dir.glob("*.pt")):
        raise SystemExit(f"模型目录里没有 .pt 权重: {model_dir}")
    shutil.copytree(model_dir, target / "models", dirs_exist_ok=True)


def _build_pyinstaller(work: Path, entry: Path) -> Path:
    dist = work / "dist"
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name",
        COMPONENT_NAME,
        "--distpath",
        str(dist),
        "--workpath",
        str(work / "build"),
        "--specpath",
        str(work),
        "--paths",
        str(SRC_DIR),
        # ultralytics 的数据文件 / 动态导入比较多，按包收集比逐个 hidden-import 稳
        "--collect-all",
        "ultralytics",
        # 运行时会有 importlib.metadata 查版本（ultralytics / torch），metadata 不收集会崩
        "--copy-metadata",
        "ultralytics",
        "--copy-metadata",
        "torch",
        "--copy-metadata",
        "torchvision",
        "--copy-metadata",
        "numpy",
        "--collect-submodules",
        "torch",
        # torchvision 的 NMS 等算子在原生 .pyd/.dll 里：只 hidden-import 会报
        # "operator torchvision::nms does not exist"（打包组件踩过）
        "--collect-all",
        "torchvision",
        "--collect-data",
        "torch",
        "--hidden-import",
        "torchvision",
        "--hidden-import",
        "cv2",
        "--exclude-module",
        "tkinter",
        "--exclude-module",
        "matplotlib.backends._backend_tk",
        str(entry),
    ]
    print("[build] " + " ".join(cmd))
    subprocess.run(cmd, check=True, cwd=work)
    return dist / COMPONENT_NAME


def _default_model_name(model_dir: Path) -> str:
    """组件默认用哪个权重：环境变量指定且存在 > yoloe-11s-seg.pt > 第一个 .pt。"""
    env = os.environ.get("GAMEPILOT_YOLO_MODEL", "").strip()
    if env and (model_dir / env).is_file():
        return env
    preferred = "yoloe-11s-seg.pt"
    if (model_dir / preferred).is_file():
        return preferred
    weights = sorted(item.name for item in model_dir.glob("*.pt"))
    return weights[0] if weights else ""


def _write_manifest(app_dir: Path, version: str, variant: str, model_dir: Path) -> dict[str, object]:
    manifest: dict[str, object] = {
        "name": COMPONENT_NAME,
        "version": version,
        "worker": f"{COMPONENT_NAME}.exe" if os.name == "nt" else COMPONENT_NAME,
        "variant": variant,
        "platform": _platform_tag(),
        "torch": _torch_version(),
        "python": sys.version.split()[0],
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "models": sorted(item.name for item in model_dir.glob("*")),
        "defaultModel": _default_model_name(model_dir),
    }
    (app_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def _zip_dir(source: Path, archive: Path) -> None:
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for item in sorted(source.rglob("*")):
            if item.is_file():
                bundle.write(item, item.relative_to(source).as_posix())


def main() -> int:
    parser = argparse.ArgumentParser(description="构建 YOLO 组件包")
    parser.add_argument("--model-dir", type=Path, default=Path(os.environ.get("GAMEPILOT_YOLO_MODEL_DIR", "")))
    parser.add_argument("--version", default=time.strftime("%Y.%m.%d"))
    parser.add_argument("--variant", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--out", type=Path, default=ENGINE_ROOT / "packaging" / "dist")
    parser.add_argument("--skip-pyinstaller", action="store_true", help="只打包已有产物（调试用）")
    args = parser.parse_args()

    if not args.model_dir or not Path(args.model_dir).is_dir():
        raise SystemExit("必须用 --model-dir 指定模型目录（含 yoloe-11s-seg.pt 或其它 YOLOE 权重）")
    model_dir = Path(args.model_dir).resolve()
    work = BUILD_ROOT / args.version / args.variant
    entry = work / "component_entry.py"
    existing = work / "dist" / COMPONENT_NAME
    if args.skip_pyinstaller and existing.is_dir():
        # 复用已有产物：**不能先 rmtree**（原来先删 work 再判断，--skip-pyinstaller 实际
        # 永远不生效，还会把已经打好的几 GB 产物删掉）
        app_dir = existing
    else:
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        entry.write_text(ENTRY_TEMPLATE, encoding="utf-8")
        app_dir = _build_pyinstaller(work, entry)

    _copy_models(model_dir, app_dir)
    manifest = _write_manifest(app_dir, args.version, args.variant, model_dir)

    args.out.mkdir(parents=True, exist_ok=True)
    archive = args.out / f"{COMPONENT_NAME}-{args.version}-{manifest['platform']}-{args.variant}.zip"
    _zip_dir(app_dir, archive)
    size_mb = archive.stat().st_size / (1024 * 1024)
    print(f"[build] 组件目录: {app_dir}")
    print(f"[build] 组件包: {archive} ({size_mb:.0f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
