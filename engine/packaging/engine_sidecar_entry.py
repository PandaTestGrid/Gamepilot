"""PyInstaller 入口：默认与 `python -m gamepilot.rpc` 等价。

**同一个 exe 也是 OCR 子进程的宿主**：冻结态下 `sys.executable` 就是这个文件打出来的包，
`gamepilot.core.ocr.OcrManager._worker_command()` 会用 `--ocr-worker` 把"自己"再启动一次。
没有这段分派的话，OCR 子进程会变成**第二个完整的 JSON-RPC 引擎** —— 它一启动就把 `engine.ready`
写进 stdout，而父进程正照着 pickle 帧头去读那 4 个字节（`{"js` = 2065853043），
于是报 "OCR 消息过大"（打包版 OCR 一点就加载失败就是这么来的）。
"""

from __future__ import annotations

import logging
import sys


def _is_ocr_worker(argv: list[str]) -> bool:
    """这个 argv 是"启动 OCR 子进程"吗（两种写法都认，见下面注释）。"""
    if "--ocr-worker" in argv:
        return True
    # 开发态写法：冻结态以前也是这么起的，兼容一下，免得别人照着老代码写
    return "-m" in argv and "gamepilot.core.ocr_worker" in argv


def _run_ocr_worker() -> int:
    # 和 `python -m gamepilot.core.ocr_worker` 的 `__main__` 一样：stdout 只放 IPC 帧，日志进 stderr
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")
    from gamepilot.core.ocr_worker import main as ocr_worker_main

    return ocr_worker_main()


def _is_yolo_worker(argv: list[str]) -> bool:
    """这个 argv 是"启动 YOLO 子进程"吗（与 OCR 同理，两种写法都认）。"""
    if "--yolo-worker" in argv:
        return True
    return "-m" in argv and "gamepilot.core.yolo_worker" in argv


def _run_yolo_worker() -> int:
    # stdout 只放 IPC 帧，日志进 stderr
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")
    from gamepilot.core.yolo_worker import main as yolo_worker_main

    return yolo_worker_main()


if __name__ == "__main__":
    from gamepilot.runtime_paths import configure_frozen_environment, configure_stdio_encoding

    configure_stdio_encoding()
    configure_frozen_environment()
    if _is_ocr_worker(sys.argv):
        raise SystemExit(_run_ocr_worker())
    if _is_yolo_worker(sys.argv):
        raise SystemExit(_run_yolo_worker())
    from gamepilot.rpc.stdio import main

    raise SystemExit(main())
