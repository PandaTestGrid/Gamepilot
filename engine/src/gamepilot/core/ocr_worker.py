"""独立 OCR 子进程：只用自己的 stdin/stdout，绝不碰引擎 JSON-RPC 管道。"""

from __future__ import annotations

import contextlib
import logging
import sys

from gamepilot.core.frame import Frame
from gamepilot.core.geometry import Rect
from gamepilot.core.ocr import (
    OcrManager,
    _ipc_read_blocking,
    _ipc_write,
    _limit_runtime_threads,
    _make_rapidocr,
    resolve_model_dir,
)

logger = logging.getLogger("gamepilot.ocr.worker")


def main() -> int:
    _limit_runtime_threads()
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    try:
        mgr = OcrManager()
        mgr._engine = _make_rapidocr(resolve_model_dir())
        _ipc_write(stdout, {"type": "ready"})
    except Exception as exc:
        with contextlib.suppress(Exception):
            _ipc_write(stdout, {"type": "error", "error": str(exc)})
        return 1

    while True:
        try:
            job = _ipc_read_blocking(stdin)
        except (EOFError, OSError, BrokenPipeError):
            return 0
        if job is None:
            return 0
        try:
            frame = Frame(image=job["image"], size=(int(job["width"]), int(job["height"])))
            rect_raw = job.get("rect")
            if rect_raw is not None:
                region = Rect(
                    float(rect_raw[0]),
                    float(rect_raw[1]),
                    float(rect_raw[2]),
                    float(rect_raw[3]),
                ).clamp()
                payload = mgr._recognize_region(mgr._engine, frame, region)
            else:
                payload = mgr._recognize_full(mgr._engine, frame)
            _ipc_write(stdout, {"type": "result", "payload": payload})
        except Exception as exc:
            logger.exception("OCR 子进程识别失败")
            try:
                _ipc_write(stdout, {"type": "error", "error": str(exc)})
            except Exception:
                return 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")
    raise SystemExit(main())
