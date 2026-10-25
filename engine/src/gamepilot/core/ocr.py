"""离线 OCR 引擎（基于 PP-OCRv4 Mobile ONNX + RapidOCR）。

模型随仓库 / wheel 内置在 `gamepilot/assets/ppocr_v4/`，无需联网下载。
可选环境变量 `GAMEPILOT_OCR_MODEL_DIR` 覆盖模型目录。

支持能力：
1. `ocr.status` / `ocr.load`：按需初始化 ONNXRuntime（后台线程 + `ocr.progress`，避免 RPC 超时）
2. 选区识字（`ocr.recognize` 带 `rect`）：小区域留白 + det 失败时单行直识
3. 整屏识字（不带 `rect`）：返回各文字框归一化坐标供前端点选
"""

from __future__ import annotations

import contextlib
import logging
import os
import pickle
import struct
import subprocess
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

import cv2
import numpy as np

from .frame import Frame
from .geometry import Rect

logger = logging.getLogger("gamepilot.ocr")

MODEL_ID = "ppocr_v4_mobile"
MODEL_NAME = "PP-OCRv4 轻量离线模型 (ONNX)"

MODEL_FILES: tuple[tuple[str, str, int], ...] = (
    ("ch_PP-OCRv4_det_infer.onnx", "文本检测模型 (det)", 4_739_937),
    ("ch_ppocr_mobile_v2.0_cls_infer.onnx", "方向分类模型 (cls)", 585_596),
    ("ch_PP-OCRv4_rec_infer.onnx", "中英文字识别模型 (rec)", 10_916_334),
)

TOTAL_ESTIMATED_BYTES = sum(item[2] for item in MODEL_FILES)
# 整屏识字前先缩小，避免 2K/4K 投屏把 CPU/内存打满拖死引擎
MAX_OCR_FULL_SIDE = 1280
# ONNX 默认会吃满所有核，截图/触控会被饿死甚至把进程拖垮
OCR_INTRA_THREADS = 1
OCR_INTER_THREADS = 1
WORKER_READY_TIMEOUT_S = 120.0
#: 打包态（PyInstaller）启动 OCR 子进程用的开关，由 `packaging/engine_sidecar_entry.py` 分派。
#: **不能**在冻结态用 `sys.executable -m gamepilot.core.ocr_worker`：`sys.executable` 那时是 sidecar
#: 本体，PyInstaller 把 `-m` 之后的东西当普通参数丢掉 → 又拉起一个**完整引擎**，
#: 那孩子一上来就把 `engine.ready` 写进 stdout，父进程照着 pickle 帧头去读 → "OCR 消息过大"。
OCR_WORKER_FLAG = "--ocr-worker"


@dataclass(frozen=True)
class OcrBox:
    """单个 OCR 识别出的文字框（归一化坐标）。"""

    text: str
    score: float
    rect: Rect

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "score": round(float(self.score), 4),
            "rect": list(self.rect.to_list()),
        }


ProgressCallback = Callable[[dict[str, Any]], None]


def _limit_runtime_threads() -> None:
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("MKL_NUM_THREADS", "1")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")
    with contextlib.suppress(Exception):
        cv2.setNumThreads(1)


def _make_rapidocr(model_dir: Path) -> Any:
    from rapidocr_onnxruntime import RapidOCR

    _limit_runtime_threads()
    det_path = str(model_dir / "ch_PP-OCRv4_det_infer.onnx")
    cls_path = str(model_dir / "ch_ppocr_mobile_v2.0_cls_infer.onnx")
    rec_path = str(model_dir / "ch_PP-OCRv4_rec_infer.onnx")
    return RapidOCR(
        det_model_path=det_path,
        cls_model_path=cls_path,
        rec_model_path=rec_path,
        intra_op_num_threads=OCR_INTRA_THREADS,
        inter_op_num_threads=OCR_INTER_THREADS,
        max_side_len=MAX_OCR_FULL_SIDE,
    )


def _ipc_write(stream: IO[bytes], obj: Any) -> None:
    data = pickle.dumps(obj, protocol=4)
    stream.write(struct.pack(">I", len(data)))
    stream.write(data)
    stream.flush()


def _ipc_read_blocking(stream: IO[bytes]) -> Any:
    header = stream.read(4)
    if not header or len(header) < 4:
        raise EOFError("OCR 子进程已关闭")
    (size,) = struct.unpack(">I", header)
    if size > 64 * 1024 * 1024:
        # 帧头不可能这么大：几乎只有一种成因 —— 对面往 stdout 写了非 IPC 的东西（协议不同步）。
        # 把前几个字节当文本带出来，比只报"消息过大"好查得多（打包版 OCR 加载失败就是这么查出来的）。
        head = header.decode("utf-8", "replace")
        raise RuntimeError(f"OCR 消息过大（帧头 {size} 字节，stdout 上先出现了 {head!r}：协议不同步？）")
    buf = stream.read(size)
    if len(buf) < size:
        raise EOFError("OCR 消息不完整")
    return pickle.loads(buf)


def _ipc_read(stream: IO[bytes], timeout: float) -> Any:
    holder: list[Any] = []
    errors: list[BaseException] = []
    done = threading.Event()

    def run() -> None:
        try:
            holder.append(_ipc_read_blocking(stream))
        except BaseException as exc:
            errors.append(exc)
        finally:
            done.set()

    threading.Thread(target=run, name="ocr-ipc-read", daemon=True).start()
    if not done.wait(timeout):
        raise TimeoutError("OCR 子进程响应超时")
    if errors:
        raise errors[0]
    return holder[0]


def _worker_command() -> list[str]:
    """OCR 子进程的命令行。冻结态和开发态**不一样**，见 `OCR_WORKER_FLAG` 的注释。"""
    if getattr(sys, "frozen", False):
        return [sys.executable, OCR_WORKER_FLAG]
    return [sys.executable, "-m", "gamepilot.core.ocr_worker"]


def _models_complete(model_dir: Path) -> bool:
    for filename, _, min_bytes in MODEL_FILES:
        fp = model_dir / filename
        if not fp.is_file() or fp.stat().st_size < max(1024, min_bytes // 2):
            return False
    return True


def _package_model_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "assets" / "ppocr_v4"


def _rapidocr_wheel_model_dir() -> Path | None:
    try:
        import rapidocr_onnxruntime

        pkg_dir = Path(rapidocr_onnxruntime.__file__).resolve().parent / "models"
        if pkg_dir.is_dir() and _models_complete(pkg_dir):
            return pkg_dir
    except Exception:
        return None
    return None


def resolve_model_dir() -> Path:
    override = os.environ.get("GAMEPILOT_OCR_MODEL_DIR", "").strip()
    if override:
        return Path(override)
    bundled = _package_model_dir()
    if _models_complete(bundled):
        return bundled
    wheel = _rapidocr_wheel_model_dir()
    if wheel is not None:
        return wheel
    return bundled


class OcrManager:
    """管理 PP-OCRv4 ONNX 模型的加载与推理（线程安全单例）。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._engine: Any = None
        self._state: str = "not_downloaded"
        self._progress: float = 0.0
        self._downloaded_bytes: int = 0
        self._total_bytes: int = TOTAL_ESTIMATED_BYTES
        self._stage: str = ""
        self._error: str | None = None
        self._load_thread: threading.Thread | None = None
        self._on_progress: ProgressCallback | None = None
        self._recognize_lock = threading.Lock()
        self._recognize_cancel = threading.Event()
        self._recognize_thread: threading.Thread | None = None
        self._recognize_job_id = 0
        self._active_on_complete: Callable[[dict[str, Any]], None] | None = None
        self._worker: subprocess.Popen[bytes] | None = None
        self._worker_io = threading.Lock()
        self._worker_ready = threading.Event()
        self._worker_error: str | None = None

    def is_downloaded(self) -> bool:
        return _models_complete(resolve_model_dir())

    def status(self) -> dict[str, Any]:
        with self._lock:
            downloaded = self.is_downloaded()
            worker_ready = self._worker_alive() and self._worker_ready.is_set()
            loaded = self._engine is not None or worker_ready
            if loaded and downloaded:
                state = "ready"
                progress = 100.0
            elif self._state == "downloading":
                state = "downloading"
                progress = self._progress
            elif self._state == "error":
                state = "error"
                progress = self._progress
            elif downloaded:
                state = "downloaded"
                progress = 100.0
            else:
                state = "not_downloaded"
                progress = 0.0

            return {
                "modelId": MODEL_ID,
                "modelName": MODEL_NAME,
                "sizeMb": round(TOTAL_ESTIMATED_BYTES / (1024 * 1024), 1),
                "state": state,
                "downloaded": downloaded,
                "loaded": loaded,
                "progress": round(progress, 1),
                "downloadedBytes": self._downloaded_bytes if downloaded else 0,
                "totalBytes": self._total_bytes,
                "stage": self._stage,
                "error": self._error,
            }

    def load(self, on_progress: ProgressCallback | None = None, *, wait: bool = True) -> dict[str, Any]:
        """按需加载模型。`wait=False` 时后台初始化，进度走 `ocr.progress`。"""
        with self._lock:
            if on_progress is not None:
                self._on_progress = on_progress
            worker_ready = self._worker_alive() and self._worker_ready.is_set()
            if self.is_downloaded() and (self._engine is not None or worker_ready):
                status = self.status()
                callback = self._on_progress
            else:
                status = None
                callback = None
                thread = self._load_thread
                already = self._state == "downloading" and thread is not None and thread.is_alive()
                if not already:
                    self._state = "downloading"
                    self._progress = 5.0
                    self._downloaded_bytes = TOTAL_ESTIMATED_BYTES if self.is_downloaded() else 0
                    self._total_bytes = TOTAL_ESTIMATED_BYTES
                    self._stage = "正在加载 PP-OCRv4 模型…"
                    self._error = None
                    # UI 走 wait=False：在子进程加载，避免 ONNX 把引擎进程拖垮
                    target = self._load_worker_isolated if not wait else self._load_worker
                    self._load_thread = threading.Thread(target=target, name="ocr-load", daemon=True)
                    self._load_thread.start()
        if status is not None:
            if callback:
                callback(status)
            return status
        if wait:
            worker = self._load_thread
            if worker is not None:
                worker.join()
            with self._lock:
                if self._engine is None:
                    raise RuntimeError(self._error or "OCR 模型加载失败")
        return self.status()

    def _emit(
        self,
        progress: float,
        downloaded_bytes: int,
        stage: str,
        *,
        state: str = "downloading",
        error: str | None = None,
    ) -> None:
        with self._lock:
            self._state = state
            self._progress = max(0.0, min(100.0, progress))
            self._downloaded_bytes = downloaded_bytes
            self._stage = stage
            self._error = error
            callback = self._on_progress
        if callback:
            callback(self.status())

    def _load_worker(self) -> None:
        try:
            model_dir = resolve_model_dir()
            if not _models_complete(model_dir):
                raise RuntimeError(
                    "OCR 模型文件缺失：请确认 gamepilot/assets/ppocr_v4 下有三个 ONNX，"
                    "或安装可选依赖 rapidocr-onnxruntime（会使用 wheel 内模型）"
                )
            self._emit(40.0, TOTAL_ESTIMATED_BYTES, "正在校验内置 PP-OCRv4 模型…")
            self._emit(85.0, TOTAL_ESTIMATED_BYTES, "正在初始化 ONNX 推理引擎…")
            engine = self._create_engine(model_dir)
            with self._lock:
                self._engine = engine
                self._state = "ready"
                self._progress = 100.0
                self._downloaded_bytes = TOTAL_ESTIMATED_BYTES
                self._stage = "OCR 模型已就绪"
                self._error = None
                callback = self._on_progress
            if callback:
                callback(self.status())
        except Exception as exc:
            message = f"OCR 模型加载失败: {exc}"
            logger.exception(message)
            self._emit(self._progress, self._downloaded_bytes, message, state="error", error=message)

    def _create_engine(self, model_dir: Path) -> Any:
        return _make_rapidocr(model_dir)

    def _worker_alive(self) -> bool:
        return self._worker is not None and self._worker.poll() is None

    def _stop_worker(self) -> None:
        proc = self._worker
        self._worker = None
        self._worker_ready.clear()
        if proc is None:
            return
        for pipe in (proc.stdin, proc.stdout):
            if pipe is not None:
                with contextlib.suppress(Exception):
                    pipe.close()
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=1.0)

    def _spawn_worker(self) -> None:
        model_dir = resolve_model_dir()
        if not _models_complete(model_dir):
            raise RuntimeError(
                "OCR 模型文件缺失：请确认 gamepilot/assets/ppocr_v4 下有三个 ONNX，"
                "或安装可选依赖 rapidocr-onnxruntime（会使用 wheel 内模型）"
            )
        with self._worker_io:
            if self._worker_alive() and self._worker_ready.is_set():
                return
            self._stop_worker()
            creationflags = 0x08000000 if os.name == "nt" else 0
            proc = subprocess.Popen(
                _worker_command(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=None,
                env=os.environ.copy(),
                close_fds=True,
                creationflags=creationflags,
            )
            self._worker = proc
            self._worker_error = None
        stdout = proc.stdout
        if stdout is None:
            with self._worker_io:
                if self._worker is proc:
                    self._stop_worker()
            raise RuntimeError("OCR 子进程管道不可用")
        try:
            msg = _ipc_read(stdout, WORKER_READY_TIMEOUT_S)
        except (EOFError, OSError, BrokenPipeError, TimeoutError) as exc:
            with self._worker_io:
                if self._worker is proc:
                    self._stop_worker()
            raise RuntimeError("OCR 子进程启动失败") from exc
        if not isinstance(msg, dict) or msg.get("type") == "error":
            error = str(msg.get("error") if isinstance(msg, dict) else msg)
            with self._worker_io:
                if self._worker is proc:
                    self._stop_worker()
            raise RuntimeError(error or "OCR 子进程启动失败")
        with self._worker_io:
            if self._worker is not proc:
                raise RuntimeError("OCR 已被取消")
            if proc.poll() is not None:
                self._stop_worker()
                raise RuntimeError("OCR 子进程启动后立即退出")
            self._worker_ready.set()

    def _load_worker_isolated(self) -> None:
        try:
            self._emit(40.0, TOTAL_ESTIMATED_BYTES, "正在启动子进程加载 PP-OCRv4…")
            self._emit(85.0, TOTAL_ESTIMATED_BYTES, "正在初始化 ONNX 推理引擎…")
            self._spawn_worker()
            with self._lock:
                self._state = "ready"
                self._progress = 100.0
                self._downloaded_bytes = TOTAL_ESTIMATED_BYTES
                self._stage = "OCR 模型已就绪"
                self._error = None
                callback = self._on_progress
            if callback:
                callback(self.status())
        except Exception as exc:
            message = f"OCR 模型加载失败: {exc}"
            logger.exception(message)
            self._emit(self._progress, self._downloaded_bytes, message, state="error", error=message)

    def ensure_loaded(self, on_progress: ProgressCallback | None = None) -> Any:
        if self._engine is None:
            self.load(on_progress=on_progress)
        return self._engine

    def cancel_recognize(self) -> dict[str, Any]:
        """立刻结束本次 OCR：杀掉子进程（ONNX 无法协作式中断）。"""
        with self._recognize_lock:
            self._recognize_job_id += 1
            self._recognize_cancel.set()
            callback = self._active_on_complete
            self._active_on_complete = None
        with self._worker_io:
            self._stop_worker()
        if callback is not None:
            callback({"text": "", "score": 0.0, "items": [], "cancelled": True})
        return {"cancelled": True}

    def recognize(
        self,
        frame: Frame,
        rect: Rect | None = None,
        *,
        on_progress: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        """同步 OCR（单测 / 脚本用）；界面走 begin_recognize + ocr.result 通知。"""
        engine = self.ensure_loaded(on_progress=on_progress)
        img_w, img_h = frame.image_size
        if img_w <= 0 or img_h <= 0:
            return {"text": "", "score": 0.0, "items": []}
        clamped = rect.clamp() if rect is not None else None
        if clamped is not None:
            return self._recognize_region(engine, frame, clamped)
        return self._recognize_full(engine, frame)

    def begin_recognize(
        self,
        frame: Frame,
        rect: Rect | None,
        *,
        on_progress: ProgressCallback | None = None,
        on_complete: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        """提交 OCR 并立刻返回；推理在独立子进程，完成时 on_complete（RPC 推 ocr.result）。"""
        if not self.is_downloaded():
            raise RuntimeError("OCR 模型未就绪")

        img_w, img_h = frame.image_size
        if img_w <= 0 or img_h <= 0:
            if on_complete:
                on_complete({"text": "", "score": 0.0, "items": [], "cancelled": False})
            return {"accepted": True}

        work = frame if rect is not None else self._frame_for_fullscreen_ocr(frame)
        work_w, work_h = work.image_size
        image_copy = work.image.copy()
        rect_tuple = tuple(rect.clamp().to_list()) if rect is not None else None

        with self._recognize_lock:
            replacing = self._recognize_thread is not None and self._recognize_thread.is_alive()
            if replacing:
                self._recognize_cancel.set()
            self._recognize_cancel.clear()
            self._recognize_job_id += 1
            job_id = self._recognize_job_id
            self._active_on_complete = on_complete

        if replacing:
            with self._worker_io:
                self._stop_worker()

        def worker() -> None:
            result: dict[str, Any] = {"text": "", "score": 0.0, "items": [], "cancelled": False}
            try:
                if self._recognize_cancel.is_set() or job_id != self._recognize_job_id:
                    result = {"text": "", "score": 0.0, "items": [], "cancelled": True}
                else:
                    if on_progress is not None:
                        self._on_progress = on_progress
                    self._spawn_worker()
                    if self._recognize_cancel.is_set() or job_id != self._recognize_job_id:
                        with self._worker_io:
                            self._stop_worker()
                        result = {"text": "", "score": 0.0, "items": [], "cancelled": True}
                    else:
                        proc = self._worker
                        if proc is None or proc.stdin is None or proc.stdout is None:
                            raise RuntimeError("OCR 子进程不可用")
                        _ipc_write(
                            proc.stdin,
                            {
                                "image": image_copy,
                                "width": int(work_w),
                                "height": int(work_h),
                                "rect": rect_tuple,
                            },
                        )
                        msg = _ipc_read(proc.stdout, 180.0)
                        if self._recognize_cancel.is_set() or job_id != self._recognize_job_id:
                            result = {"text": "", "score": 0.0, "items": [], "cancelled": True}
                        elif not isinstance(msg, dict):
                            raise RuntimeError("OCR 子进程返回异常")
                        elif msg.get("type") == "error":
                            raise RuntimeError(str(msg.get("error") or "OCR 识别失败"))
                        else:
                            payload = msg.get("payload") if msg.get("type") == "result" else msg
                            if not isinstance(payload, dict):
                                payload = {}
                            result = {**payload, "cancelled": False}
            except (EOFError, OSError, BrokenPipeError):
                if self._recognize_cancel.is_set() or job_id != self._recognize_job_id:
                    result = {"text": "", "score": 0.0, "items": [], "cancelled": True}
                else:
                    result = {
                        "text": "",
                        "score": 0.0,
                        "items": [],
                        "cancelled": False,
                        "error": "OCR 子进程已退出（未影响引擎）",
                    }
            except Exception as exc:
                logger.exception("OCR 识别失败")
                result = {
                    "text": "",
                    "score": 0.0,
                    "items": [],
                    "cancelled": False,
                    "error": str(exc),
                }
            if self._recognize_cancel.is_set() or job_id != self._recognize_job_id:
                result = {"text": "", "score": 0.0, "items": [], "cancelled": True}
            with self._recognize_lock:
                callback = self._active_on_complete if job_id == self._recognize_job_id else None
                if job_id == self._recognize_job_id:
                    self._active_on_complete = None
            if callback is not None:
                callback(result)

        self._recognize_thread = threading.Thread(
            target=worker,
            name="ocr-recognize",
            daemon=True,
        )
        self._recognize_thread.start()
        return {"accepted": True}

    def _frame_for_fullscreen_ocr(self, frame: Frame) -> Frame:
        img_w, img_h = frame.image_size
        max_side = max(img_w, img_h)
        if max_side <= MAX_OCR_FULL_SIDE:
            return frame
        scale = MAX_OCR_FULL_SIDE / float(max_side)
        new_w = max(1, int(img_w * scale))
        new_h = max(1, int(img_h * scale))
        resized = cv2.resize(frame.image, (new_w, new_h), interpolation=cv2.INTER_AREA)
        return Frame(image=resized, size=(new_w, new_h))

    def _recognize_full(self, engine: Any, frame: Frame) -> dict[str, Any]:
        work = self._frame_for_fullscreen_ocr(frame)
        img_w, img_h = work.image_size
        raw_res, _ = engine(work.image)
        items: list[OcrBox] = []
        if raw_res:
            for entry in raw_res:
                if not isinstance(entry, (list, tuple)) or len(entry) < 3:
                    continue
                box_pts, text_raw, score_raw = entry[0], str(entry[1]).strip(), float(entry[2])
                if not text_raw:
                    continue
                box_rect = _polygon_to_norm_rect(box_pts, img_w, img_h)
                if box_rect.w <= 0 or box_rect.h <= 0:
                    continue
                items.append(OcrBox(text=text_raw, score=score_raw, rect=box_rect))

        joined = " ".join(item.text for item in items).strip()
        best_score = max((item.score for item in items), default=0.0)
        return {
            "text": joined,
            "score": round(best_score, 4),
            "items": [item.to_dict() for item in items],
        }

    def _recognize_region(self, engine: Any, frame: Frame, region_rect: Rect) -> dict[str, Any]:
        crop = frame.crop(region_rect)
        if crop.size == 0:
            return {"text": "", "score": 0.0, "items": []}

        scale = 2.0 if crop.shape[0] < 44 else 1.0
        working = (
            cv2.resize(
                crop,
                (max(1, round(crop.shape[1] * scale)), max(1, round(crop.shape[0] * scale))),
                interpolation=cv2.INTER_CUBIC,
            )
            if scale > 1.0
            else crop
        )
        pad = 16
        padded = cv2.copyMakeBorder(working, pad, pad, pad, pad, cv2.BORDER_REPLICATE)

        raw_res, _ = engine(padded)
        items: list[OcrBox] = []
        offset_x, offset_y, _, _ = region_rect.to_pixels(frame.image_size)
        img_w, img_h = frame.image_size

        if raw_res:
            for entry in raw_res:
                if not isinstance(entry, (list, tuple)) or len(entry) < 3:
                    continue
                box_pts, text_raw, score_raw = entry[0], str(entry[1]).strip(), float(entry[2])
                if not text_raw:
                    continue
                unpadded_pts = [[(pt[0] - pad) / scale + offset_x, (pt[1] - pad) / scale + offset_y] for pt in box_pts]
                box_rect = _polygon_to_norm_rect(unpadded_pts, img_w, img_h)
                items.append(OcrBox(text=text_raw, score=score_raw, rect=box_rect))

        if not items:
            rec_res, _ = engine(working, use_det=False, use_cls=True, use_rec=True)
            if rec_res:
                for entry in rec_res:
                    if not isinstance(entry, (list, tuple)) or len(entry) < 2:
                        continue
                    text_raw = str(entry[0]).strip()
                    score_raw = float(entry[1])
                    if text_raw:
                        items.append(OcrBox(text=text_raw, score=score_raw, rect=region_rect))

        joined = "".join(item.text for item in items).strip()
        best_score = max((item.score for item in items), default=0.0)
        return {
            "text": joined,
            "score": round(best_score, 4),
            "items": [item.to_dict() for item in items],
        }


def _polygon_to_norm_rect(pts: Any, img_w: int, img_h: int) -> Rect:
    try:
        arr = np.asarray(pts, dtype=np.float32)
        xs = arr[:, 0]
        ys = arr[:, 1]
        x1 = float(np.min(xs))
        y1 = float(np.min(ys))
        x2 = float(np.max(xs))
        y2 = float(np.max(ys))
        return Rect.from_pixels(x1, y1, max(1.0, x2 - x1), max(1.0, y2 - y1), (img_w, img_h)).clamp()
    except Exception:
        return Rect(0.0, 0.0, 0.0, 0.0)


OCR_MANAGER = OcrManager()
