"""状态查询慢 IO 不得阻塞推理管理锁；组件大小缓存失效与公开契约。"""

from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import numpy as np
import pytest

from gamepilot.core import yolo, yolo_component, yolo_infer


@pytest.mark.parametrize("slow_query", ["component", "infer", "default_model", "poll"])
def test_status_io_does_not_hold_manager_lock(monkeypatch: pytest.MonkeyPatch, slow_query: str) -> None:
    manager = yolo.YoloManager()
    manager._device = "cuda"
    manager._model_selected = None
    manager._applied_key = (("target",), ())
    manager._result = ([], 7)
    manager._inflight = True
    manager._ready.set()
    proc = Mock()
    proc.poll.return_value = None
    manager._proc = proc
    monkeypatch.setattr(manager, "available", lambda: True)
    monkeypatch.setattr(yolo_component, "status", lambda: {"installed": True})
    monkeypatch.setattr(yolo_infer, "status", lambda: {"available": True, "model": "default.pt"})
    monkeypatch.setattr(yolo_infer, "default_model", lambda: "default.pt")
    entered = threading.Event()
    release = threading.Event()

    def slow() -> Any:
        entered.set()
        assert release.wait(5), "test did not release blocked status IO"
        return (
            {"installed": True}
            if slow_query == "component"
            else "default.pt"
            if slow_query == "default_model"
            else None
        )

    if slow_query == "component":
        monkeypatch.setattr(yolo_component, "status", slow)
    elif slow_query == "infer":

        def slow_infer() -> dict[str, Any]:
            slow()
            return {"available": True}

        monkeypatch.setattr(yolo_infer, "status", slow_infer)
    elif slow_query == "default_model":
        monkeypatch.setattr(yolo_infer, "default_model", slow)
    else:
        proc.poll.side_effect = slow

    def submit_and_publish() -> None:
        assert manager.device == "cuda"
        result = manager.submit(
            np.zeros((2, 2, 3), dtype=np.uint8),
            ["target"],
            [],
            conf=0.3,
            iou=0.45,
            imgsz=640,
            frame_index=8,
        )
        assert result == ([], 7)
        with manager._lock:
            manager._device = "cpu"
            manager._result = ([], 8)

    with ThreadPoolExecutor(max_workers=2) as pool:
        status = pool.submit(manager.status)
        try:
            assert entered.wait(2)
            pool.submit(submit_and_publish).result(timeout=2)
        finally:
            release.set()
        result = status.result(timeout=2)
    assert result["device"] == "cuda"  # 同一份管理状态快照，不被 IO 期间的更新撕裂
    assert result["classes"] == ["target"]
    assert result["workerReady"] is True
    assert result["model"] == "default.pt"


def _make_component(path: Path, *, version: str = "1", payload_size: int = 1024 * 1024) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / yolo_component._exe_name()).write_bytes(b"worker")
    (path / "manifest.json").write_text(
        json.dumps({"name": "gamepilot-yolo", "version": version, "variant": "cpu"}), encoding="utf-8"
    )
    models = path / "models"
    models.mkdir(exist_ok=True)
    (models / "weights.pt").write_bytes(b"x" * payload_size)
    return path


@pytest.fixture()
def component_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "component"
    monkeypatch.setenv(yolo_component.COMPONENT_DIR_ENV, str(root))
    monkeypatch.delenv(yolo_component.WORKER_EXE_ENV, raising=False)
    _make_component(root / "1")
    (root / "current.json").write_text('{"version": "1"}', encoding="utf-8")
    yolo_component._invalidate_size_cache()
    return root


@pytest.fixture()
def scans(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    calls: list[Path] = []
    original = yolo_component._directory_size

    def count(path: Path) -> tuple[int, bool]:
        calls.append(path)
        return original(path)

    monkeypatch.setattr(yolo_component, "_directory_size", count)
    return calls


def test_repeated_status_reuses_size_but_returns_fresh_manifest(component_root: Path, scans: list[Path]) -> None:
    first = yolo_component.status()
    assert first == yolo_component.status()
    assert first["installed"] is True
    assert first["sizeMb"] == 1.0
    assert set(first) == {"installed", "version", "path", "sizeMb", "manifest"}
    first["manifest"]["variant"] = "mutated by caller"
    assert yolo_component.status()["manifest"]["variant"] == "cpu"
    assert scans == [component_root / "1"]


def test_manifest_and_current_changes_invalidate_size(component_root: Path, scans: list[Path]) -> None:
    yolo_component.status()
    (component_root / "1" / "models" / "weights.pt").write_bytes(b"x" * (2 * 1024 * 1024))
    manifest_path = component_root / "1" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["variant"] = "cuda"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    result = yolo_component.status()
    assert result["sizeMb"] == 2.0
    assert result["manifest"]["variant"] == "cuda"
    assert len(scans) == 2
    _make_component(component_root / "2", version="2", payload_size=3 * 1024 * 1024)
    (component_root / "current.json").write_text('{"version": "2"}', encoding="utf-8")
    assert yolo_component.status()["sizeMb"] == 3.0
    assert len(scans) == 3


def test_root_and_worker_environment_changes_preserve_status_contract(
    component_root: Path, scans: list[Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = yolo_component.status()
    missing = tmp_path / "missing-worker"
    monkeypatch.setenv(yolo_component.WORKER_EXE_ENV, str(missing))
    result = yolo_component.status()
    assert result == {**first, "installed": False}
    missing.write_bytes(b"external worker")
    assert yolo_component.status()["installed"] is True  # installed 不能随 size 一起缓存
    assert len(scans) == 2
    other = tmp_path / "other"
    _make_component(other / "1", payload_size=2 * 1024 * 1024)
    (other / "current.json").write_text('{"version": "1"}', encoding="utf-8")
    monkeypatch.setenv(yolo_component.COMPONENT_DIR_ENV, str(other))
    assert yolo_component.status()["sizeMb"] == 2.0
    assert yolo_component.status()["path"] == str(other / "1")
    assert len(scans) == 3


def test_same_version_reinstall_remove_and_model_import_invalidate_size(
    component_root: Path, scans: list[Path], tmp_path: Path
) -> None:
    assert yolo_component.status()["sizeMb"] == 1.0
    source = _make_component(tmp_path / "source", payload_size=2 * 1024 * 1024)
    assert yolo_component.install(str(source))["sizeMb"] == 2.0
    weights = tmp_path / "weights.pt"
    weights.write_bytes(b"x" * (3 * 1024 * 1024))
    yolo_component.import_models(weights)
    assert yolo_component.status()["sizeMb"] == 3.0
    assert len(scans) == 3
    assert yolo_component.remove() == {
        "installed": False,
        "version": None,
        "path": str(component_root),
        "sizeMb": 0.0,
        "manifest": {},
    }
    assert yolo_component.install(str(source))["sizeMb"] == 2.0
    assert len(scans) == 4


def test_external_deep_file_changes_refresh_after_ttl(
    component_root: Path, scans: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    now = [100.0]
    monkeypatch.setattr(time, "monotonic", lambda: now[0])
    assert yolo_component.status()["sizeMb"] == 1.0
    (component_root / "1" / "models" / "weights.pt").write_bytes(b"x" * (2 * 1024 * 1024))
    assert yolo_component.status()["sizeMb"] == 1.0
    now[0] += yolo_component._SIZE_CACHE_TTL_S + 1
    assert yolo_component.status()["sizeMb"] == 2.0
    assert len(scans) == 2


def test_partial_size_scan_is_not_cached(component_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    results = iter([(1, False), (1024 * 1024, True)])
    monkeypatch.setattr(yolo_component, "_directory_size", lambda _path: next(results))
    assert yolo_component.status()["sizeMb"] == 0.0
    assert yolo_component.status()["sizeMb"] == 1.0
    assert yolo_component.status()["sizeMb"] == 1.0


def test_invalidation_during_scan_does_not_wait_or_publish_stale_cache(
    component_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entered = threading.Event()
    release = threading.Event()
    calls: list[Path] = []

    def scan(path: Path) -> tuple[int, bool]:
        calls.append(path)
        entered.set()
        assert release.wait(5)
        return 1024 * 1024, True

    monkeypatch.setattr(yolo_component, "_directory_size", scan)
    with ThreadPoolExecutor(max_workers=2) as pool:
        status = pool.submit(yolo_component.status)
        try:
            assert entered.wait(2)
            pool.submit(yolo_component._invalidate_size_cache).result(timeout=2)
        finally:
            release.set()
        status.result(timeout=2)
    yolo_component.status()
    assert len(calls) == 2


def test_concurrent_status_queries_share_one_size_scan(component_root: Path, scans: list[Path]) -> None:
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: yolo_component.status(), range(8)))
    assert all(result == results[0] for result in results)
    assert scans == [component_root / "1"]


def test_worker_override_without_current_does_not_change_component_metadata(
    component_root: Path, scans: list[Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (component_root / "current.json").unlink()
    worker = tmp_path / "external-worker"
    worker.write_bytes(b"worker")
    monkeypatch.setenv(yolo_component.WORKER_EXE_ENV, str(worker))
    assert yolo_component.status() == {
        "installed": True,
        "version": None,
        "path": str(component_root),
        "sizeMb": 0.0,
        "manifest": {},
    }
    assert scans == []
