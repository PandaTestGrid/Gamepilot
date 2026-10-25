"""YoloManager：worker 推理设备上报 + 预览期间给运行时识别让路。

背景：AI 弹窗的「实时检测」和运行时识别器共用同一个 worker。两者用不同的
词表/示例配置时会来回重建类向量，还会抢 IO 锁，实测能把手动预览饿到 10s+。
这里钉住：设备要如实上报（GPU/CPU 决定节流与提示），预览期间运行时让路。
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from unittest.mock import Mock

import numpy as np
import pytest

from gamepilot.core import yolo


def test_spawn_records_worker_device(monkeypatch: pytest.MonkeyPatch) -> None:
    manager = yolo.YoloManager()
    proc = Mock()
    proc.poll.return_value = None
    monkeypatch.setattr(yolo.subprocess, "Popen", lambda *_a, **_k: proc)
    monkeypatch.setattr(yolo, "_read", lambda _stream, _timeout: {"type": "ready", "device": "cuda"})
    try:
        manager._spawn()
        assert manager.device == "cuda"
        assert manager.status()["device"] == "cuda"
    finally:
        manager._stop_worker()


def test_cpu_worker_logs_warning(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    manager = yolo.YoloManager()
    proc = Mock()
    proc.poll.return_value = None
    monkeypatch.setattr(yolo.subprocess, "Popen", lambda *_a, **_k: proc)
    monkeypatch.setattr(yolo, "_read", lambda _stream, _timeout: {"type": "ready", "device": "cpu"})
    monkeypatch.setattr(yolo.yolo_component, "worker_variant", lambda: "cpu")
    try:
        with caplog.at_level(logging.WARNING, logger="gamepilot.yolo"):
            manager._spawn()
        assert manager.device == "cpu"
        assert any("CPU" in record.getMessage() for record in caplog.records)
    finally:
        manager._stop_worker()


def test_stop_worker_clears_device(monkeypatch: pytest.MonkeyPatch) -> None:
    manager = yolo.YoloManager()
    manager._device = "cuda"
    manager._stop_worker()
    assert manager.device == ""


def test_preview_hold_pauses_runtime_submit(monkeypatch: pytest.MonkeyPatch) -> None:
    manager = yolo.YoloManager()
    monkeypatch.setattr(manager, "available", lambda: True)
    manager._result = ([{"class": "target", "conf": 0.9, "bbox": [0, 0, 1, 1]}], 7)
    manager._preview_at = time.monotonic()

    started: list[object] = []

    class FakeThread:
        def __init__(self, target: object = None, **_kwargs: object) -> None:
            started.append(target)

        def start(self) -> None:
            raise AssertionError("预览期间不该启动运行时推理线程")

    monkeypatch.setattr(yolo.threading, "Thread", FakeThread)

    cached = manager.submit(np.zeros((4, 4, 3), dtype=np.uint8), [], [], conf=0.3, iou=0.45, imgsz=640, frame_index=9)

    # 预览期间不应把弹窗里的旧框投射回游戏画面，宁可先空一帧。
    assert cached == ([], 9)
    assert started == []


def test_preview_stamps_activity(monkeypatch: pytest.MonkeyPatch) -> None:
    manager = yolo.YoloManager()
    monkeypatch.setattr(manager, "available", lambda: True)
    monkeypatch.setattr(manager, "_ensure_worker", lambda: None)
    monkeypatch.setattr(manager, "_ensure_config", lambda *_args, **_kwargs: None)
    manager._proc = Mock()
    manager._proc.stdin = Mock()
    manager._proc.stdout = Mock()
    monkeypatch.setattr(yolo, "_ipc_write", lambda *_args: None)
    monkeypatch.setattr(
        yolo,
        "_read",
        lambda *_args: {"type": "result", "dets": [{"class": "target", "conf": 0.9, "bbox": [1, 2, 3, 4]}]},
    )

    before = time.monotonic()
    dets, _queue_ms, _infer_ms = manager.preview(
        np.zeros((8, 8, 3), dtype=np.uint8),
        [{"path": "ref.png", "rect": [0, 0, 1, 1]}],
        conf=0.3,
        iou=0.45,
        imgsz=640,
        tile=False,
        tile_size=640,
        tile_overlap=0.2,
    )

    assert manager._preview_at >= before
    assert dets == [{"class": "target", "conf": 0.9, "bbox": [1, 2, 3, 4]}]


def test_union_config_merges_active_recognizers(tmp_path: Path) -> None:
    first = tmp_path / "a.png"
    second = tmp_path / "b.png"
    first.write_bytes(b"x")
    second.write_bytes(b"x")
    manager = yolo.YoloManager()
    manager._remember_config(("monster",), [{"path": str(first), "rect": [0.1, 0.1, 0.2, 0.2], "label": "ai_8"}])
    manager._remember_config(("boss",), [{"path": str(second), "rect": [0.3, 0.3, 0.2, 0.2], "label": "ai_9"}])

    classes, examples = manager._union_config()

    assert classes == ("boss", "monster")
    assert [item["label"] for item in examples] == ["ai_8", "ai_9"]


def test_union_config_expires_stale_recognizers(tmp_path: Path) -> None:
    old = tmp_path / "old.png"
    new = tmp_path / "new.png"
    old.write_bytes(b"x")
    new.write_bytes(b"x")
    manager = yolo.YoloManager()
    manager._remember_config((), [{"path": str(old), "rect": [0, 0, 1, 1], "label": "old"}])
    for key in list(manager._active_configs):
        manager._active_configs[key] = time.monotonic() - yolo.CONFIG_TTL_S - 1
    manager._remember_config((), [{"path": str(new), "rect": [0, 0, 1, 1], "label": "new"}])

    _classes, examples = manager._union_config()

    assert [item["label"] for item in examples] == ["new"]


def test_new_rect_for_same_file_replaces_old_config(tmp_path: Path) -> None:
    """编辑示例框后文件路径不变、rect 变了：旧签名必须立刻作废。

    否则 TTL 内并集里会同时有「旧框」和「新框」，worker 把两份视觉提示平均，
    等于拿错框去检测。
    """
    shot = tmp_path / "ai_9_ai0.png"
    shot.write_bytes(b"x")
    manager = yolo.YoloManager()
    manager._remember_config((), [{"path": str(shot), "rect": [0, 0, 0.2, 0.2], "label": "ai_9"}])
    manager._remember_config((), [{"path": str(shot), "rect": [0.5, 0.5, 0.2, 0.2], "label": "ai_9"}])

    _classes, examples = manager._union_config()

    assert [item["rect"] for item in examples] == [[0.5, 0.5, 0.2, 0.2]]


def test_ensure_config_skips_empty_union(monkeypatch: pytest.MonkeyPatch) -> None:
    """并集全空时不要把空配置发给 worker（老组件会退出，触发反复重启）。"""
    manager = yolo.YoloManager()
    proc = Mock()
    proc.stdin = Mock()
    proc.stdout = Mock()
    manager._proc = proc
    sent: list[object] = []
    monkeypatch.setattr(yolo, "_ipc_write", lambda *_args: sent.append(_args))

    manager._ensure_config((), [])

    assert sent == []
    assert manager._applied_key is None


def test_union_config_drops_deleted_example_files(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    """编辑识别器会按序号重写示例文件：旧配置里的路径可能已经不存在。

    这种路径不能继续喂给 worker（旧组件会直接 FileNotFoundError，整台识别器都跑不了）。
    """
    kept = tmp_path / "kept.png"
    kept.write_bytes(b"x")
    gone = tmp_path / "gone.png"
    manager = yolo.YoloManager()
    manager._remember_config(
        ("boss",),
        [
            {"path": str(kept), "rect": [0, 0, 0.2, 0.2], "label": "ai_9"},
            {"path": str(gone), "rect": [0.2, 0.2, 0.2, 0.2], "label": "ai_9"},
        ],
    )

    with caplog.at_level(logging.WARNING, logger="gamepilot.yolo"):
        _classes, examples = manager._union_config()

    assert [item["path"] for item in examples] == [str(kept)]
    assert any("已不存在" in record.getMessage() for record in caplog.records)


def test_submit_configures_union_of_recognizers(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    manager = yolo.YoloManager()
    monkeypatch.setattr(manager, "available", lambda: True)
    monkeypatch.setattr(manager, "_ensure_worker", lambda: None)
    manager._proc = Mock()
    manager._proc.stdin = Mock()
    manager._proc.stdout = Mock()
    monkeypatch.setattr(yolo, "_ipc_write", lambda *_args: None)
    monkeypatch.setattr(yolo, "_read", lambda *_args: {"type": "result", "dets": []})

    configs: list[tuple[tuple[str, ...], tuple[str, ...]]] = []

    def fake_ensure_config(classes: tuple[str, ...], examples: list[dict[str, object]]) -> None:
        configs.append((classes, tuple(str(item.get("label") or "") for item in examples)))

    monkeypatch.setattr(manager, "_ensure_config", fake_ensure_config)

    class SyncThread:
        def __init__(self, target: object = None, args: tuple[object, ...] = (), **_kwargs: object) -> None:
            self._target = target
            self._args = args

        def start(self) -> None:
            assert callable(self._target)
            self._target(*self._args)

    monkeypatch.setattr(yolo.threading, "Thread", SyncThread)

    a = tmp_path / "a.png"
    b = tmp_path / "b.png"
    a.write_bytes(b"x")
    b.write_bytes(b"x")
    image = np.zeros((8, 8, 3), dtype=np.uint8)
    manager.submit(
        image,
        [],
        [{"path": str(a), "rect": [0, 0, 0.2, 0.2], "label": "ai_8"}],
        conf=0.3,
        iou=0.45,
        imgsz=640,
        frame_index=1,
    )
    manager._last_submit = 0.0  # 绕过节流，模拟下一帧
    manager.submit(
        image,
        [],
        [{"path": str(b), "rect": [0.1, 0.1, 0.2, 0.2], "label": "ai_9"}],
        conf=0.3,
        iou=0.45,
        imgsz=640,
        frame_index=2,
    )

    assert configs[0][1] == ("ai_8",)
    assert configs[-1][1] == ("ai_8", "ai_9")  # 第二次直接配并集，不再来回切
