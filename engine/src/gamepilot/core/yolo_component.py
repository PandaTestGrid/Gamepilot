"""YOLO 组件的安装与定位（可选组件，一次下载后长期可用）。

组件是一个 zip：onedir 打包的 worker（内含 torch/ultralytics/opencv）+ 模型。
装到用户数据目录，按版本共存，`current.json` 指向当前版本。

目录形状：

    %APPDATA%/gamepilot/components/yolo/
    ├─ current.json                  # {"version": "0.1.0", "installedAt": "..."}
    └─ 0.1.0/
       ├─ gamepilot-yolo(.exe)       # 由 packaging/build_yolo_component.py 产出
       ├─ manifest.json
       └─ models/                    # yolov8s-worldv2.pt + clip/

环境变量（开发/测试用）：
- `GAMEPILOT_YOLO_COMPONENT_DIR`：覆盖组件根目录
- `GAMEPILOT_YOLO_WORKER`：直接指定 worker 可执行文件（跳过安装）
- `GAMEPILOT_YOLO_COMPONENT_URL`：默认下载源（http(s) / file:// / 本地 zip 路径）

为什么不做成"内置进主安装包"：torch + 模型会让安装包多 1.5~3GB，且只对部分显卡有效；
组件按需下载、可单独更新/回滚，坏了删掉重装即可，主程序不受影响。
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import shutil
import tempfile
import threading
import time
import urllib.request
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..config import config_dir

logger = logging.getLogger("gamepilot.yolo.component")

COMPONENT_NAME = "gamepilot-yolo"
COMPONENT_DIR_ENV = "GAMEPILOT_YOLO_COMPONENT_DIR"
WORKER_EXE_ENV = "GAMEPILOT_YOLO_WORKER"
SOURCE_ENV = "GAMEPILOT_YOLO_COMPONENT_URL"
CURRENT_FILE = "current.json"
MANIFEST_FILE = "manifest.json"
MODEL_SELECTION_FILE = "model.json"

ProgressCallback = Callable[[dict[str, Any]], None]

# 只缓存目录大小，installed / manifest 等状态每次都重新读取，不改变公开状态契约。
# 单项缓存有界；TTL 兜底外部工具直接修改深层文件（父目录时间戳不一定变化）。
_SIZE_CACHE_TTL_S = 60.0
_size_cache_lock = threading.Lock()
_size_scan_lock = threading.Lock()
_size_cache: tuple[tuple[Any, ...], int, float] | None = None
_size_cache_generation = 0


def _invalidate_size_cache() -> None:
    global _size_cache, _size_cache_generation
    with _size_cache_lock:
        _size_cache = None
        _size_cache_generation += 1


def _file_stamp(path: Path) -> tuple[int, ...] | None:
    try:
        info = path.stat()
        return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns
    except OSError:
        return None


def _directory_size(path: Path) -> tuple[int, bool]:
    size = 0
    complete = True
    try:
        for item in path.rglob("*"):
            try:
                if item.is_file():
                    size += item.stat().st_size
            except OSError:
                complete = False
    except OSError:
        complete = False
    return size, complete


def _cached_directory_size(path: Path, key: tuple[Any, ...]) -> int:
    global _size_cache
    # 扫描独立串行化，但绝不在缓存锁内做 IO；安装/卸载失效不需要等慢扫描。
    with _size_scan_lock:
        with _size_cache_lock:
            generation = _size_cache_generation
            if _size_cache is not None and _size_cache[0] == key and time.monotonic() < _size_cache[2]:
                return _size_cache[1]
        size, complete = _directory_size(path)
        with _size_cache_lock:
            # 失败/被卸载打断的部分统计不能永久充当有效结果；旧扫描不能覆盖安装失效。
            if complete and generation == _size_cache_generation:
                _size_cache = key, size, time.monotonic() + _SIZE_CACHE_TTL_S
        return size


def root() -> Path:
    override = os.environ.get(COMPONENT_DIR_ENV, "").strip()
    if override:
        return Path(override)
    return Path(config_dir()) / "components" / "yolo"


def default_source() -> str:
    return os.environ.get(SOURCE_ENV, "").strip()


def _exe_name() -> str:
    return "gamepilot-yolo.exe" if os.name == "nt" else "gamepilot-yolo"


def _manifest_path(version: str) -> Path:
    return root() / version / MANIFEST_FILE


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _emit(callback: ProgressCallback | None, state: str, progress: float, stage: str, **extra: Any) -> None:
    if callback is None:
        return
    callback({"state": state, "progress": round(max(0.0, min(100.0, progress)), 1), "stage": stage, **extra})


# --------------------------------------------------------------------------- #
# 查询
# --------------------------------------------------------------------------- #
def current_version() -> str | None:
    data = _read_json(root() / CURRENT_FILE)
    version = str((data or {}).get("version") or "").strip()
    return version or None


def worker_exe() -> Path | None:
    """组件 worker 的绝对路径；没装/损坏返回 None。环境变量优先（开发态）。"""
    override = os.environ.get(WORKER_EXE_ENV, "").strip()
    if override:
        path = Path(override)
        return path if path.is_file() else None
    version = current_version()
    if not version:
        return None
    candidate = root() / version / _exe_name()
    return candidate if candidate.is_file() else None


def worker_variant() -> str:
    """当前实际生效 worker 的变体（cpu / cuda）。读 exe 同级 manifest，环境变量覆盖也准。"""
    exe = worker_exe()
    if exe is None:
        return ""
    manifest = _read_json(exe.parent / MANIFEST_FILE) or {}
    return str(manifest.get("variant") or "").strip()


def status() -> dict[str, Any]:
    root_path = root()
    current_path = root_path / CURRENT_FILE
    current = _read_json(current_path) or {}
    version = str(current.get("version") or "").strip() or None
    override = os.environ.get(WORKER_EXE_ENV, "").strip()
    exe = Path(override) if override else root_path / version / _exe_name() if version else None
    size_bytes = 0
    manifest: dict[str, Any] = {}
    if version:
        version_dir = root_path / version
        manifest_path = version_dir / MANIFEST_FILE
        manifest = _read_json(manifest_path) or {}
        key = (
            os.path.abspath(root_path),
            version,
            override,
            json.dumps(current, sort_keys=True),
            json.dumps(manifest, sort_keys=True),
            _file_stamp(current_path),
            _file_stamp(manifest_path),
            _file_stamp(version_dir),
        )
        size_bytes = _cached_directory_size(version_dir, key)
    return {
        "installed": exe is not None and exe.is_file(),
        "version": version,
        "path": str(root_path / version) if version else str(root_path),
        "sizeMb": round(size_bytes / 1024 / 1024, 1),
        "manifest": manifest,
    }


# --------------------------------------------------------------------------- #
# 安装 / 卸载
# --------------------------------------------------------------------------- #
def install(source: str, on_progress: ProgressCallback | None = None) -> dict[str, Any]:
    """从 URL / 本地 zip / 已解开的目录安装组件，返回安装后的 status。

    失败时不改动 `current.json`，旧版本继续可用（原子替换）。
    """
    src = str(source or "").strip()
    if not src:
        raise ValueError("没有组件来源：请传入 source，或设置 GAMEPILOT_YOLO_COMPONENT_URL")

    root_path = root()
    root_path.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".install-", dir=root_path))
    try:
        content = _fetch(src, work, on_progress)
        _emit(on_progress, "verifying", 90.0, "正在校验组件清单…")
        manifest = _validated_manifest(content)
        version = str(manifest["version"])

        target = root_path / version
        _invalidate_size_cache()
        try:
            if target.exists():
                shutil.rmtree(target)
            content.rename(target)
            _write_current(version)
        finally:
            _invalidate_size_cache()
        _emit(on_progress, "done", 100.0, f"AI 组件 {version} 已就绪", version=version)
        return status()
    finally:
        shutil.rmtree(work, ignore_errors=True)


def remove() -> dict[str, Any]:
    """卸载当前组件版本（其它版本目录保留，便于回滚）。"""
    _invalidate_size_cache()
    try:
        version = current_version()
        if version:
            shutil.rmtree(root() / version, ignore_errors=True)
        with contextlib.suppress(FileNotFoundError):
            (root() / CURRENT_FILE).unlink()
    finally:
        _invalidate_size_cache()
    return status()


def _write_current(version: str) -> None:
    payload = {"version": version, "installedAt": time.strftime("%Y-%m-%dT%H:%M:%S")}
    (root() / CURRENT_FILE).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _fetch(src: str, work: Path, on_progress: ProgressCallback | None) -> Path:
    """把来源弄成"解开的目录"，返回它的内容根。"""
    path = Path(src)
    if path.is_dir():
        content = work / "content"
        shutil.copytree(path, content)
        return _content_root(content)

    if path.is_file():
        _emit(on_progress, "extracting", 80.0, "正在解压组件…")
        return _extract(path, work)

    if src.startswith(("http://", "https://", "file://")):
        archive = work / "component.zip"
        _emit(on_progress, "downloading", 0.0, "正在下载 AI 组件…")
        _download(src, archive, on_progress)
        _emit(on_progress, "extracting", 80.0, "正在解压组件…")
        return _extract(archive, work)

    raise ValueError(f"无法识别的组件来源: {src!r}（支持目录 / zip / http(s) / file://）")


def _download(url: str, dest: Path, on_progress: ProgressCallback | None) -> None:
    with urllib.request.urlopen(url) as response, dest.open("wb") as handle:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            handle.write(chunk)
            done += len(chunk)
            progress = (done / total * 78.0) if total else 0.0
            _emit(on_progress, "downloading", progress, f"正在下载组件… {done // (1024 * 1024)}MB")


def _extract(archive: Path, work: Path) -> Path:
    content = work / "content"
    with zipfile.ZipFile(archive) as bundle:
        base = content.resolve()
        for member in bundle.infolist():
            target = (content / member.filename).resolve()
            if base not in target.parents and target != base:
                raise ValueError(f"组件包里有越界路径: {member.filename!r}")
        bundle.extractall(content)
        # 少数环境（杀毒/文件占用/磁盘瞬时错误）会漏解压个别文件，
        # 这里按 zip 清单补一遍；仍然缺失就明确报错，避免装出一个"缺文件"的组件。
        missing = [
            member.filename
            for member in bundle.infolist()
            if not member.is_dir() and not (content / member.filename).exists()
        ]
        for filename in missing:
            bundle.extract(filename, content)
        still_missing = [
            member.filename
            for member in bundle.infolist()
            if not member.is_dir() and not (content / member.filename).exists()
        ]
        if still_missing:
            raise RuntimeError(f"组件包解压不完整，缺少 {len(still_missing)} 个文件（例如 {still_missing[0]}）")
    return _content_root(content)


def _content_root(content: Path) -> Path:
    """zip 里有时会多套一层同名目录：往下找到含 manifest.json 的那一层。"""
    if (content / MANIFEST_FILE).is_file():
        return content
    children = [item for item in content.iterdir() if item.is_dir()]
    if len(children) == 1 and (children[0] / MANIFEST_FILE).is_file():
        return children[0]
    raise ValueError(f"组件包里没有 {MANIFEST_FILE}")


def _validated_manifest(content: Path) -> dict[str, Any]:
    manifest = _read_json(content / MANIFEST_FILE)
    if manifest is None:
        raise ValueError("组件包 manifest.json 缺失或损坏")
    if str(manifest.get("name") or "") != COMPONENT_NAME:
        raise ValueError(f"组件名不对：期望 {COMPONENT_NAME}，实际 {manifest.get('name')!r}")
    version = str(manifest.get("version") or "").strip()
    if not version or "/" in version or "\\" in version or ".." in version:
        raise ValueError(f"组件版本号非法: {version!r}")
    worker = str(manifest.get("worker") or _exe_name())
    if not (content / worker).is_file():
        raise ValueError(f"组件包里缺少 worker 可执行文件: {worker}")
    return manifest


def _model_dir_fallback() -> Path:
    # 开发态：用引擎自己的模型目录（assets/yolo 或 GAMEPILOT_YOLO_MODEL_DIR）
    from . import yolo_infer

    return yolo_infer.model_dir()


def model_dir() -> Path:
    """当前生效的模型目录：装了组件就用组件里的 models/，否则用开发态目录。"""
    exe = worker_exe()
    if exe is not None:
        return exe.parent / "models"
    return _model_dir_fallback()


def list_models() -> list[str]:
    try:
        return sorted(path.name for path in model_dir().glob("*.pt"))
    except OSError:
        return []


def selected_model() -> str | None:
    """用户选过的权重名（持久化在组件根目录；没有就用默认）。"""
    data = _read_json(root() / MODEL_SELECTION_FILE)
    name = str((data or {}).get("model") or "").strip()
    return name or None


def save_selected_model(name: str) -> None:
    root().mkdir(parents=True, exist_ok=True)
    payload = {"model": name}
    (root() / MODEL_SELECTION_FILE).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def import_models(source: Path, target_dir: Path | None = None) -> list[str]:
    """把一个 .pt 或 .zip（内含 .pt）导入模型目录；返回导入的文件名列表。"""
    _invalidate_size_cache()
    try:
        return _import_models(source, target_dir)
    finally:
        # 即使失败也可能已经写入了部分文件。
        _invalidate_size_cache()


def _import_models(source: Path, target_dir: Path | None) -> list[str]:
    target = (target_dir or model_dir()).resolve()
    target.mkdir(parents=True, exist_ok=True)
    suffix = source.suffix.lower()

    if suffix == ".pt":
        dest = target / source.name
        if dest.resolve().parent != target:
            raise ValueError("非法的模型文件名")
        shutil.copy2(source, dest)
        return [source.name]

    if suffix == ".zip":
        added: list[str] = []
        with zipfile.ZipFile(source) as bundle:
            for member in bundle.infolist():
                if member.is_dir():
                    continue
                name = Path(member.filename.replace("\\", "/")).name
                if not name.lower().endswith(".pt"):
                    continue
                resolved = (target / name).resolve()
                if resolved.parent != target:
                    raise ValueError(f"压缩包里有越界路径: {member.filename!r}")
                with bundle.open(member) as src, resolved.open("wb") as out:
                    shutil.copyfileobj(src, out)
                added.append(name)
        if not added:
            raise ValueError("压缩包里没有 .pt 权重")
        return sorted(added)

    raise ValueError(f"只支持 .pt 或 .zip 权重：{source.name}")


def worker_log_path() -> Path:
    """worker 的 stderr 日志（排查"每次检测都很慢/worker 反复重启"用）。"""
    from ..config import config_dir

    return Path(config_dir()) / "logs" / "yolo-worker.log"
