"""离线 OCR 模块单测：内置模型加载、选区识字、整屏文字框扫描、子进程命令行契约。"""

from __future__ import annotations

import importlib.util
import io
import sys
import threading
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pytest

from gamepilot.core import ocr as ocr_mod
from gamepilot.core.frame import Frame
from gamepilot.core.geometry import Rect
from gamepilot.core.ocr import OcrManager


def _load_sidecar_entry() -> Any:
    """`engine/packaging/engine_sidecar_entry.py`：不是包，只能按路径加载。"""
    path = Path(__file__).resolve().parents[1] / "packaging" / "engine_sidecar_entry.py"
    spec = importlib.util.spec_from_file_location("engine_sidecar_entry", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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
    # _worker 是 subprocess.Popen（没有 is_alive —— 那是 multiprocessing 的 API）：退出看 poll()
    assert mgr._worker is None or mgr._worker.poll() is not None


def test_worker_command_frozen_uses_the_flag_not_dash_m(monkeypatch: pytest.MonkeyPatch) -> None:
    """打包态的 OCR 子进程**必须**走 --ocr-worker：
    冻结态下 sys.executable 是 sidecar 本体，`-m ...` 会被 PyInstaller 丢掉 → 又拉起一个完整引擎，
    而引擎一启动就往 stdout 写 engine.ready，父进程按 pickle 帧头去读 → "OCR 消息过大"。
    """
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    cmd = ocr_mod._worker_command()
    assert cmd[-1] == ocr_mod.OCR_WORKER_FLAG
    assert "-m" not in cmd


def test_worker_command_dev_still_uses_dash_m(monkeypatch: pytest.MonkeyPatch) -> None:
    """开发态保持不变（那是已经跑通的那条路）。"""
    monkeypatch.delattr(sys, "frozen", raising=False)
    assert ocr_mod._worker_command()[-2:] == ["-m", "gamepilot.core.ocr_worker"]


def test_frozen_spawn_argv_is_understood_by_the_sidecar_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    """两侧的约定：**引擎起的命令，sidecar 入口必须认得**（不然就是第二个引擎）。"""
    entry = _load_sidecar_entry()
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    cmd = ocr_mod._worker_command()
    assert entry._is_ocr_worker(["gamepilot-engine.exe", *cmd[1:]]) is True
    # 老写法也认（兼容：别人照着开发态那行代码写也能工作）
    assert entry._is_ocr_worker(["gamepilot-engine.exe", "-m", "gamepilot.core.ocr_worker"]) is True
    # 正常启动引擎的 argv 不能被误判成 OCR 子进程
    assert entry._is_ocr_worker(["gamepilot-engine.exe", "--stdio"]) is False


def test_ipc_read_rejects_protocol_desync_with_actionable_message() -> None:
    """对面往 stdout 写了 JSON（而不是 pickle 帧）时，报错要能看出是"协议不同步"。"""
    stream = io.BytesIO(b'{"jsonrpc": "2.0", "method": "engine.ready", "params": {}}')
    with pytest.raises(RuntimeError) as excinfo:
        ocr_mod._ipc_read_blocking(stream)
    message = str(excinfo.value)
    assert "协议不同步" in message
    # 只读了 4 字节帧头，所以预览就是 JSON 的开头 —— 足够认出"对面在说 JSON-RPC 而不是 pickle"
    assert '{"js' in message
