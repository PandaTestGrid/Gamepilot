"""YOLO 组件的安装流程（不依赖 torch）：本地 zip / 目录安装、校验、原子替换、worker 定位。"""

from __future__ import annotations

import json
import os
import zipfile
from pathlib import Path

import pytest

from gamepilot.core import yolo_component


def _make_component(target: Path, version: str = "0.1.0", worker: str | None = None) -> Path:
    """造一个最小可用的组件目录。"""
    if worker is None:
        worker = "gamepilot-yolo.exe" if os.name == "nt" else "gamepilot-yolo"
    target.mkdir(parents=True, exist_ok=True)
    (target / "manifest.json").write_text(
        json.dumps(
            {
                "name": "gamepilot-yolo",
                "version": version,
                "worker": worker,
                "torch": "2.11.0+cpu",
            }
        ),
        encoding="utf-8",
    )
    (target / worker).write_text("binary", encoding="utf-8")
    (target / "models").mkdir(exist_ok=True)
    (target / "models" / "dummy.txt").write_text("x", encoding="utf-8")
    return target


def _zip_dir(source: Path, archive: Path, *, nested: bool = False) -> Path:
    with zipfile.ZipFile(archive, "w") as bundle:
        for item in source.rglob("*"):
            if item.is_file():
                arcname = (Path("bundle") / item.relative_to(source)) if nested else item.relative_to(source)
                bundle.write(item, arcname.as_posix())
    return archive


@pytest.fixture()
def component_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "components"
    monkeypatch.setenv("GAMEPILOT_YOLO_COMPONENT_DIR", str(root))
    monkeypatch.delenv("GAMEPILOT_YOLO_WORKER", raising=False)
    return root


def test_install_from_zip(component_root: Path, tmp_path: Path) -> None:
    source = _make_component(tmp_path / "src")
    archive = _zip_dir(source, tmp_path / "component.zip")

    events: list[dict] = []
    result = yolo_component.install(str(archive), on_progress=events.append)

    assert result["installed"] is True
    assert result["version"] == "0.1.0"
    worker = "gamepilot-yolo.exe" if os.name == "nt" else "gamepilot-yolo"
    assert yolo_component.worker_exe() == component_root / "0.1.0" / worker
    assert (component_root / "0.1.0" / "models" / "dummy.txt").is_file()
    assert any(event["state"] == "done" for event in events)


@pytest.mark.skipif(os.name != "posix", reason="Unix executable bits only")
def test_install_from_zip_preserves_worker_executable_bit(component_root: Path, tmp_path: Path) -> None:
    """zip 解压默认不还原 mode；worker 没执行位时 macOS/Linux 预热会 Permission denied。"""
    source = _make_component(tmp_path / "src")
    (source / "gamepilot-yolo").chmod(0o755)
    archive = _zip_dir(source, tmp_path / "component.zip")

    result = yolo_component.install(str(archive))

    assert result["installed"] is True
    worker = yolo_component.worker_exe()
    assert worker is not None
    assert worker.stat().st_mode & 0o111


def test_install_from_directory(component_root: Path, tmp_path: Path) -> None:
    source = _make_component(tmp_path / "src")

    result = yolo_component.install(str(source))

    assert result["installed"] is True
    assert yolo_component.current_version() == "0.1.0"


def test_install_handles_nested_zip(component_root: Path, tmp_path: Path) -> None:
    source = _make_component(tmp_path / "src")
    archive = _zip_dir(source, tmp_path / "nested.zip", nested=True)

    result = yolo_component.install(str(archive))

    assert result["installed"] is True


def test_upgrade_keeps_old_version_on_failure(component_root: Path, tmp_path: Path) -> None:
    source = _make_component(tmp_path / "src", version="0.1.0")
    yolo_component.install(str(source))

    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "manifest.json").write_text('{"name": "gamepilot-yolo", "version": "0.2.0"}', encoding="utf-8")
    with pytest.raises(ValueError):
        yolo_component.install(str(broken))

    assert yolo_component.current_version() == "0.1.0"
    assert yolo_component.status()["installed"] is True


@pytest.mark.parametrize(
    "manifest",
    [
        {"name": "other", "version": "0.1.0"},
        {"name": "gamepilot-yolo", "version": "../escape"},
        {"name": "gamepilot-yolo", "version": "0.1.0", "worker": "missing.exe"},
    ],
)
def test_rejects_bad_manifest(component_root: Path, tmp_path: Path, manifest: dict) -> None:
    bad = tmp_path / "bad"
    bad.mkdir()
    (bad / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (bad / "gamepilot-yolo.exe").write_text("binary", encoding="utf-8")

    with pytest.raises(ValueError):
        yolo_component.install(str(bad))


def test_zip_slip_is_rejected(component_root: Path, tmp_path: Path) -> None:
    archive = tmp_path / "evil.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("../evil.txt", "x")
        bundle.writestr("manifest.json", "{}")

    with pytest.raises(ValueError):
        yolo_component.install(str(archive))


def test_worker_env_override_wins(component_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    exe = tmp_path / "custom-worker.exe"
    exe.write_text("binary", encoding="utf-8")
    monkeypatch.setenv("GAMEPILOT_YOLO_WORKER", str(exe))

    assert yolo_component.worker_exe() == exe


def test_worker_variant_reads_the_worker_manifest(
    component_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    exe = tmp_path / "gamepilot-yolo.exe"
    exe.write_text("binary", encoding="utf-8")
    (tmp_path / "manifest.json").write_text(
        json.dumps({"name": "gamepilot-yolo", "version": "0.2.0", "worker": exe.name, "variant": "cuda"}),
        encoding="utf-8",
    )
    monkeypatch.setenv("GAMEPILOT_YOLO_WORKER", str(exe))

    assert yolo_component.worker_variant() == "cuda"


def test_worker_variant_missing_is_empty(component_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GAMEPILOT_YOLO_WORKER", str(tmp_path / "missing.exe"))

    assert yolo_component.worker_variant() == ""


def test_remove_clears_current(component_root: Path, tmp_path: Path) -> None:
    source = _make_component(tmp_path / "src")
    yolo_component.install(str(source))

    result = yolo_component.remove()

    assert result["installed"] is False
    assert yolo_component.current_version() is None


def test_model_selection_roundtrip(component_root: Path, tmp_path: Path) -> None:
    source = _make_component(tmp_path / "src")
    (source / "models" / "yoloe-11m-seg.pt").write_bytes(b"weights")
    yolo_component.install(str(source))

    assert yolo_component.list_models() == ["yoloe-11m-seg.pt"]
    assert yolo_component.selected_model() is None

    yolo_component.save_selected_model("yoloe-11m-seg.pt")

    assert yolo_component.selected_model() == "yoloe-11m-seg.pt"


def test_import_models_accepts_pt_and_zip(tmp_path: Path) -> None:
    import zipfile

    target = tmp_path / "models"
    single = tmp_path / "yoloe-11s-seg.pt"
    single.write_bytes(b"weights")
    assert yolo_component.import_models(single, target) == ["yoloe-11s-seg.pt"]

    archive = tmp_path / "weights.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("nested/yoloe-11m-seg.pt", b"weights-m")
        bundle.writestr("readme.txt", "not a model")
    assert yolo_component.import_models(archive, target) == ["yoloe-11m-seg.pt"]
    assert (target / "yoloe-11m-seg.pt").is_file()

    empty = tmp_path / "empty.zip"
    with zipfile.ZipFile(empty, "w") as bundle:
        bundle.writestr("readme.txt", "nothing")
    with pytest.raises(ValueError):
        yolo_component.import_models(empty, target)
