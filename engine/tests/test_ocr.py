"""离线 OCR 模块单测：内置模型加载、选区识字、整屏文字框扫描。"""

from __future__ import annotations

import threading
from typing import Any

import cv2
import numpy as np

from gamepilot.core.frame import Frame
from gamepilot.core.geometry import Rect
from gamepilot.core.ocr import OcrManager


def _make_test_frame() -> Frame:
    img = np.full((360, 640, 3), 255, dtype=np.uint8)
    cv2.putText(img, "START GAME", (60, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (10, 10, 10), 3)
    cv2.putText(img, "SETTINGS", (360, 260), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (20, 20, 20), 3)
    return Frame(image=img, size=(640, 360))


def test_ocr_bundled_models_load_and_recognize() -> None:
    mgr = OcrManager()

    initial = mgr.status()
    assert initial["downloaded"] is True
    assert initial["state"] in {"downloaded", "ready"}
    assert initial["loaded"] is False or initial["state"] == "ready"

    events: list[dict[str, Any]] = []
    started = threading.Event()
    original_worker = mgr._load_worker

    def slow_worker() -> None:
        started.set()
        original_worker()

    mgr._load_worker = slow_worker  # type: ignore[method-assign]
    pending = mgr.load(on_progress=lambda payload: events.append(payload), wait=True)
    assert started.wait(2.0)
    assert pending["state"] in {"downloading", "ready"}
    final_status = mgr.load(on_progress=lambda payload: events.append(payload), wait=True)

    assert final_status["state"] == "ready"
    assert final_status["downloaded"] is True
    assert final_status["loaded"] is True
    assert final_status["progress"] == 100.0
    assert len(events) >= 1

    frame = _make_test_frame()

    region_res = mgr.recognize(frame, Rect(0.05, 0.12, 0.5, 0.25))
    assert "START" in region_res["text"].upper()
    assert region_res["score"] > 0.8

    full_res = mgr.recognize(frame)
    assert len(full_res["items"]) >= 2
    texts = [item["text"].upper() for item in full_res["items"]]
    assert any("START" in t for t in texts)
    assert any("SETTING" in t for t in texts)
    for item in full_res["items"]:
        rx, ry, rw, rh = item["rect"]
        assert 0.0 <= rx <= 1.0
        assert 0.0 <= ry <= 1.0
        assert 0.0 < rw <= 1.0
        assert 0.0 < rh <= 1.0


def test_begin_recognize_returns_immediately_and_can_cancel() -> None:
    mgr = OcrManager()
    frame = _make_test_frame()
    results: list[dict[str, Any]] = []
    started = threading.Event()

    def on_complete(payload: dict[str, Any]) -> None:
        results.append(payload)
        started.set()

    t0 = threading.Event()
    original_spawn = mgr._spawn_worker

    def slow_spawn() -> None:
        t0.set()
        original_spawn()

    mgr._spawn_worker = slow_spawn  # type: ignore[method-assign]
    accepted = mgr.begin_recognize(frame, None, on_complete=on_complete)
    assert accepted == {"accepted": True}
    assert t0.wait(5.0)
    cancelled = mgr.cancel_recognize()
    assert cancelled == {"cancelled": True}
    assert started.wait(8.0)
    assert results and results[-1].get("cancelled") is True
    assert mgr._worker is None or not mgr._worker.is_alive()
