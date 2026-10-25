"""独立 YOLO 子进程：只用自己的 stdin/stdout，绝不碰引擎 JSON-RPC 管道。

协议与 OCR worker 一致（长度前缀 + pickle），但消息类型更少：

    ← {"type": "ready"}                    模型加载完成
    → {"type": "config", "classes": [...]} 换词表（只重建向量，不重载权重）
    ← {"type": "config_ok", "classes": [...]}
    → {"type": "infer", "image": ndarray, "conf": 0.3, "iou": 0.45, "imgsz": 640}
    ← {"type": "result", "dets": [...]}
    ← {"type": "error", "error": "..."}     单条命令失败不退出，便于引擎看到原因
"""

from __future__ import annotations

import contextlib
import logging
import sys
from typing import Any

from gamepilot.core.ocr import _ipc_read_blocking, _ipc_write
from gamepilot.core.yolo_infer import Detector

logger = logging.getLogger("gamepilot.yolo.worker")


def _handle(detector: Detector, job: dict[str, Any]) -> dict[str, Any]:
    kind = str(job.get("type") or "")
    if kind == "config":
        detector.configure(
            [str(item) for item in job.get("classes") or []],
            [dict(item) for item in job.get("examples") or []],
        )
        return {"type": "config_ok", "classes": list(detector.names)}
    if kind == "infer":
        dets = detector.infer(
            job["image"],
            conf=float(job.get("conf", 0.3)),
            iou=float(job.get("iou", 0.45)),
            imgsz=int(job.get("imgsz", 640)),
            tile=bool(job.get("tile", False)),
            tile_size=int(job.get("tile_size", 640)),
            tile_overlap=float(job.get("tile_overlap", 0.2)),
        )
        return {"type": "result", "dets": dets}
    raise ValueError(f"未知命令: {kind!r}")


def main() -> int:
    # 和 OCR 一样限制线程：torch 默认会吃满所有核，把截图/触控饿死
    import os

    os.environ.setdefault("OMP_NUM_THREADS", "1")
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    try:
        detector = Detector()
        _ipc_write(stdout, {"type": "ready", "device": detector.device})
    except Exception as exc:
        logger.exception("YOLO 子进程加载失败")
        with contextlib.suppress(Exception):
            _ipc_write(stdout, {"type": "ready_error", "error": str(exc)})
        return 1

    while True:
        try:
            job = _ipc_read_blocking(stdin)
        except (EOFError, OSError, BrokenPipeError):
            return 0
        if not isinstance(job, dict):
            return 0
        try:
            _ipc_write(stdout, _handle(detector, job))
        except Exception as exc:
            logger.exception("YOLO 子进程命令失败")
            with contextlib.suppress(Exception):
                _ipc_write(stdout, {"type": "error", "error": str(exc)})


if __name__ == "__main__":
    raise SystemExit(main())
