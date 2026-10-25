"""YOLO 识别器的进程管理：一个常驻子进程 + 非阻塞的「最新一帧」推理。

为什么不直接在引擎进程里跑：
- `import torch + ultralytics` 约 2~5s、常驻 1~2GB；引擎进程还要管截图/触控，不能跟它绑死；
- 推理卡住/模型炸了，杀子进程即可恢复，不影响状态机。

为什么非阻塞（与 OCR 同一套思路）：
- 采集循环 8~28fps，GPU 推理 20~80ms；同步等会把采集拖慢。
- 提交后立刻返回**上一次**的结果，识别器按 `max_age_frames` 判断是否还新鲜。

线程/进程模型：
- 引擎侧只有一个 worker，所有 `yolo` 识别器共用：每次真正推理前把**最近活跃识别器**的
  词表/示例取并集再配置（`CONFIG_TTL_S` 内没再出现的淘汰）。不取并集的话两个识别器会
  每帧来回切配置，每个示例都要重跑一次视觉向量，CPU 版组件能慢到秒级；
- 同一时刻最多一个推理在飞，超出 `MIN_INTERVAL` 的请求直接复用缓存，天然限流；
- 预览弹窗活跃时（`PREVIEW_HOLD_S`）运行时识别暂停提交，避免抢 worker / 抢配置。
"""

from __future__ import annotations

import contextlib
import logging
import os
import subprocess
import sys
import threading
import time
from typing import IO, Any

import numpy as np

from . import yolo_component
from .ocr import _ipc_read, _ipc_write

logger = logging.getLogger("gamepilot.yolo")


def _read(stream: IO[bytes], timeout: float) -> Any:
    """读一条 IPC 消息。底层复用 OCR 的帧格式，但进程退出时要报 YOLO 的进程名。

    Windows 上子进程退出后，读它的 stdout 可能抛 `ValueError: read of closed file`
    而不是 EOFError；两种情况都按「子进程已关闭」处理，交给上层重启。
    """
    try:
        return _ipc_read(stream, timeout)
    except (EOFError, ValueError, OSError) as exc:
        raise RuntimeError("YOLO 子进程已关闭") from exc


#: 冻结态（PyInstaller）启动 worker 的开关，由 `packaging/engine_sidecar_entry.py` 分派。
#: 与 OCR 同理：冻结态不能用 `sys.executable -m ...`，否则会再拉起一个完整引擎。
YOLO_WORKER_FLAG = "--yolo-worker"
WORKER_READY_TIMEOUT_S = 180.0
INFER_TIMEOUT_S = 30.0
#: 推理节流：无论采集多快，最多每秒推 10 次
MIN_INTERVAL_S = 0.1
#: GPU 上识别可以跑到接近 30fps（CPU 上仍按 10fps 节流，避免饿死截图/触控）
GPU_MIN_INTERVAL_S = 0.033
#: 预览弹窗在跑时暂停运行时识别（秒）。预览和运行时识别共用一个 worker，词表/示例
#: 在两套配置之间来回切换会把时间全花在重建类向量上；线程抢 IO 锁还会把预览饿到
#: 十几秒（实测 CPU 组件 + 运行中识别出现过 10s+）。预览期间运行时直接复用缓存结果，
#: 弹窗关掉 3s 后自动恢复。
PREVIEW_HOLD_S = 3.0
#: 多个 yolo 识别器共用同一个 worker。每帧各提交各的示例会让配置来回切换
#: （每个示例都要重跑一次视觉向量，实测 14s 切了 8 次）——所以把最近活跃识别器的
#: 词表+示例取并集，只配置一次；超过 TTL 没再出现的识别器从并集里淘汰。
CONFIG_TTL_S = 120.0
#: 默认容忍的结果过期帧数（按采集帧序号计）
DEFAULT_MAX_AGE_FRAMES = 4


class YoloManager:
    """管理子进程与最近一次检测结果（线程安全单例）。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._io_lock = threading.Lock()
        self._proc: subprocess.Popen[bytes] | None = None
        #: worker 上报的推理设备（cuda/cpu）：GPU 上可以把识别节流放宽到 ~30fps
        self._device = ""
        self._stderr_file: IO[bytes] | None = None
        self._ready = threading.Event()
        self._error: str | None = None
        #: 串行化子进程启动：运行时识别和预览可能同时第一次用 worker，后到的等它起好，
        #: 不能直接抛"正在启动"（弹窗第一次预览就会失败）
        self._spawn_lock = threading.Lock()
        self._applied_key: tuple[Any, ...] | None = None
        self._model_selected: str | None = yolo_component.selected_model()
        self._result: tuple[list[dict[str, Any]], int] | None = None
        self._inflight = False
        self._last_submit = 0.0
        #: 最近一次预览弹窗调用的时刻：这段时间里运行时识别让路（见 PREVIEW_HOLD_S）
        self._preview_at = 0.0
        #: 最近活跃识别器的配置（词表+示例签名 → 最后出现时间）：worker 用它们的并集
        self._active_configs: dict[tuple[Any, ...], float] = {}
        #: 已经警告过的缺失示例（文件被删/改名）：只在第一次出现时提示，避免每帧刷日志
        self._missing_examples: set[str] = set()
        #: 并集为空的情况也只提示一次（避免每帧刷日志）
        self._empty_config_warned = False

    # ---------- 状态 ----------

    def available(self) -> bool:
        # 装了组件就用组件（引擎进程不需要 torch）；否则退回开发态的内置依赖
        if yolo_component.worker_exe() is not None:
            return True
        from . import yolo_infer

        return yolo_infer.available()

    def status(self) -> dict[str, Any]:
        from . import yolo_infer

        # 组件/模型查询会访问磁盘（首次统计组件目录可能耗时数秒）。这里只快照内存状态，
        # 绝不能让状态轮询占住 submit / 推理结果发布 / stop 共用的管理锁。
        with self._lock:
            proc = self._proc
            ready = self._ready.is_set()
            selected = self._model_selected
            runtime = {
                "device": self._device or "",
                "classes": list(self._applied_key[0]) if self._applied_key else [],
                "error": self._error,
            }
        return {
            **yolo_infer.status(),
            "component": yolo_component.status(),
            "workerReady": proc is not None and proc.poll() is None and ready,
            **runtime,
            "model": selected or yolo_infer.default_model(),
        }

    def warmup(self) -> dict[str, Any]:
        """后台预热：拉起 worker 并加载模型（不跑推理），界面打开弹窗时调用。

        失败不抛：把原因记进 error，状态接口照常返回，避免预热失败导致弹窗报错。
        """
        with self._lock:
            already = self._proc is not None and self._proc.poll() is None and self._ready.is_set()
        if already or not self.available():
            return self.status()
        try:
            self._ensure_worker()
        except Exception as exc:
            with self._lock:
                self._error = f"预热失败：{exc}"
        return self.status()

    @property
    def device(self) -> str:
        """当前 worker 的推理设备（cuda/cpu；还没就绪时为空）。"""
        with self._lock:
            return self._device

    # ---------- 配置并集 ----------

    @staticmethod
    def _config_key(classes: tuple[str, ...], examples: list[dict[str, Any]]) -> tuple[Any, ...]:
        """识别器配置的稳定签名（worker 只关心 path / rect / label）。"""
        return (
            tuple(classes),
            tuple(
                sorted(
                    (
                        str(item.get("path") or ""),
                        tuple(float(v) for v in (item.get("rect") or ())),
                        str(item.get("label") or ""),
                    )
                    for item in examples
                )
            ),
        )

    def _remember_config(self, classes: tuple[str, ...], examples: list[dict[str, Any]]) -> None:
        key = self._config_key(classes, examples)
        now = time.monotonic()
        # 同一张参考图换了框/标签（编辑示例、删掉中间一个示例后文件重排）：旧签名立刻作废，
        # 否则它会在 TTL 内继续参与并集，用旧框跑出一份错的类向量。
        reused = {str(item.get("path") or "") for item in examples if item.get("path")}
        with self._lock:
            for stale_key in [
                item
                for item in self._active_configs
                if item != key and any(path in reused for path, _rect, _label in item[1])
            ]:
                del self._active_configs[stale_key]
            self._active_configs[key] = now
            cutoff = now - CONFIG_TTL_S
            for stale in [item for item, seen in self._active_configs.items() if seen < cutoff]:
                del self._active_configs[stale]

    def _union_config(self) -> tuple[tuple[str, ...], list[dict[str, Any]]]:
        """最近活跃识别器的词表+示例并集（顺序稳定，避免配置 key 抖动）。

        文件已经不存在的示例直接剔除：编辑识别器时示例会按序号重排文件名
        （删掉中间一个，后面的文件就会改名/消失），而这条旧配置还会在
        `CONFIG_TTL_S` 里继续参与并集。不剔除的话 worker 每次配置都会读到不存在
        的路径，一个坏示例就能让整台识别器推理失败。
        """
        with self._lock:
            keys = sorted(self._active_configs)
        classes = sorted({name for config_classes, _ in keys for name in config_classes})
        examples: dict[tuple[Any, ...], dict[str, Any]] = {}
        for _config_classes, config_examples in keys:
            for path, rect, label in config_examples:
                if not path or not os.path.isfile(path):
                    if path not in self._missing_examples:
                        self._missing_examples.add(path)
                        logger.warning("示例参考图已不存在，跳过（不影响其它示例）：%s", path)
                    continue
                self._missing_examples.discard(path)
                examples[(path, rect, label)] = {"path": path, "rect": list(rect), "label": label}
        return tuple(classes), [examples[key] for key in sorted(examples)]

    # ---------- 推理 ----------

    def preview(
        self,
        image: np.ndarray,
        examples: list[dict[str, Any]],
        *,
        conf: float,
        iou: float,
        imgsz: int,
        tile: bool,
        tile_size: int,
        tile_overlap: float,
    ) -> tuple[list[dict[str, Any]], float, float]:
        """弹窗「实时检测」预览：同步跑一次，不走节流/帧缓存。

        返回 (dets, 推理耗时ms)。耗时里包含等 worker 锁的时间（和运行时识别共用同一个
        worker），界面据此判断是"模型慢"还是"排队慢"。

        示例参考图由调用方先落盘（同一组路径），这样预览循环里只算一次视觉向量。
        """
        if not self.available():
            raise RuntimeError("AI 组件未安装：装好后再预览")
        # 先标记预览活跃再排队：运行时识别在这段时间里让路（否则两套示例配置来回重建，
        # 预览会一直排在"重建 6 个示例向量"后面，实测十几秒）
        self._preview_at = time.monotonic()
        self._ensure_worker()
        self._ensure_config((), [dict(item) for item in examples])
        started = time.perf_counter()
        with self._io_lock:
            infer_started = time.perf_counter()
            proc = self._proc
            if proc is None or proc.stdin is None or proc.stdout is None:
                raise RuntimeError("YOLO 子进程不可用")
            _ipc_write(
                proc.stdin,
                {
                    "type": "infer",
                    "image": image,
                    "conf": conf,
                    "iou": iou,
                    "imgsz": imgsz,
                    "tile": tile,
                    "tile_size": tile_size,
                    "tile_overlap": tile_overlap,
                },
            )
            msg = _read(proc.stdout, INFER_TIMEOUT_S)
        if not isinstance(msg, dict):
            raise RuntimeError("YOLO 子进程返回异常")
        if msg.get("type") == "error":
            raise RuntimeError(str(msg.get("error") or "YOLO 预览失败"))
        infer_ms = (time.perf_counter() - infer_started) * 1000
        queue_ms = (infer_started - started) * 1000
        raw = msg.get("dets")
        dets = [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []
        return dets, queue_ms, infer_ms

    def submit(
        self,
        image: np.ndarray,
        classes: list[str],
        examples: list[dict[str, Any]],
        *,
        conf: float,
        iou: float,
        imgsz: int,
        tile: bool = False,
        tile_size: int = 640,
        tile_overlap: float = 0.2,
        frame_index: int,
    ) -> tuple[list[dict[str, Any]], int] | None:
        """提交一帧（非阻塞）。返回 `(dets, result_frame_index)`；不可用时返回 None。

        返回的可能是上一帧的结果；新鲜度由调用方用 `frame_index - result_frame_index` 判断。
        """
        with self._lock:
            if not self.available():
                return None
            # 记下这次请求（哪怕被节流/预览让路），并集里才有这台识别器的示例
            self._remember_config(tuple(classes), examples)
            now = time.monotonic()
            # 预览弹窗在跑：运行时识别先复用缓存结果（推理弹窗是当前焦点，别抢 worker）。
            # 预览关闭后不能把“冻结预览帧”的框带回游戏画面；否则刚保存 ROI 返回运行时
            # 时会先闪出一帧旧框，随后才换成真实游戏帧的结果。预览保持期结束时丢弃缓存，
            # 让运行时从当前游戏帧重新开始。
            if now - self._preview_at < PREVIEW_HOLD_S:
                # 预览使用的是弹窗帧/ROI，不能把那份框直接投射到游戏画面；
                # 预览刚关闭的短暂让路期宁可空一帧，也不能显示错误位置并闪回。
                return ([], frame_index)
            if self._preview_at:
                self._preview_at = 0.0
                self._result = None
            interval = GPU_MIN_INTERVAL_S if self._device == "cuda" else MIN_INTERVAL_S
            if self._inflight or (now - self._last_submit) < interval:
                # 外部画面采集通常比 YOLO 推理快：复用短暂缓存，避免每个采集帧
                # 先清空再等待推理完成，表现为框疯狂闪烁。
                return self._result
            self._inflight = True
            self._last_submit = now
            cached = self._result
            union_classes, union_examples = self._union_config()
        threading.Thread(
            target=self._run,
            args=(
                image.copy(),
                union_classes,
                tuple(tuple(sorted(item.items())) for item in union_examples),
                conf,
                iou,
                imgsz,
                tile,
                tile_size,
                tile_overlap,
                frame_index,
            ),
            name="yolo-infer",
            daemon=True,
        ).start()
        return cached

    def _run(
        self,
        image: np.ndarray,
        classes: tuple[str, ...],
        examples: tuple[tuple[tuple[str, Any], ...], ...],
        conf: float,
        iou: float,
        imgsz: int,
        tile: bool,
        tile_size: int,
        tile_overlap: float,
        frame_index: int,
    ) -> None:
        example_maps = [dict(item) for item in examples]
        try:
            self._ensure_worker()
            self._ensure_config(classes, example_maps)
            with self._io_lock:
                proc = self._proc
                if proc is None or proc.stdin is None or proc.stdout is None:
                    raise RuntimeError("YOLO 子进程不可用")
                _ipc_write(
                    proc.stdin,
                    {
                        "type": "infer",
                        "image": image,
                        "conf": conf,
                        "iou": iou,
                        "imgsz": imgsz,
                        "tile": tile,
                        "tile_size": tile_size,
                        "tile_overlap": tile_overlap,
                    },
                )
                msg = _read(proc.stdout, INFER_TIMEOUT_S)
            if not isinstance(msg, dict):
                raise RuntimeError("YOLO 子进程返回异常")
            if msg.get("type") == "error":
                raise RuntimeError(str(msg.get("error") or "YOLO 推理失败"))
            raw = msg.get("dets")
            dets: list[dict[str, Any]] = (
                [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []
            )
            with self._lock:
                self._result = (dets, frame_index)
                self._error = None
        except Exception as exc:  # 单次失败只记录，下一次请求会重启 worker
            logger.warning("YOLO 推理失败: %s", exc)
            with self._lock:
                self._error = str(exc)
            self._stop_worker()
        finally:
            with self._lock:
                self._inflight = False

    # ---------- 子进程 ----------

    def _worker_env(self) -> dict[str, str]:
        env = os.environ.copy()
        if self._model_selected:
            env["GAMEPILOT_YOLO_MODEL"] = self._model_selected
        return env

    # ---------- 模型 ----------

    def models(self) -> dict[str, Any]:
        from . import yolo_infer

        with self._lock:
            selected = self._model_selected
        return {
            "models": yolo_component.list_models(),
            "model": selected or yolo_infer.default_model(),
            "dir": str(yolo_component.model_dir()),
            "device": self._device or "",
        }

    def set_model(self, name: str) -> dict[str, Any]:
        clean = str(name or "").strip()
        if not clean:
            raise RuntimeError("模型名不能为空")
        if not (yolo_component.model_dir() / clean).is_file():
            raise RuntimeError(f"模型不存在: {clean}（先在上传/添加模型里导入）")
        yolo_component.save_selected_model(clean)
        with self._lock:
            self._model_selected = clean
        # 换模型要重启 worker（torch 权重在进程启动时加载）
        self._stop_worker()
        return {**self.models(), "reloading": True, "workerReady": False}

    def _worker_command(self) -> list[str]:
        # 组件优先（用户数据目录里的独立 exe，自带 torch/模型）；开发态才回落到模块启动
        component = yolo_component.worker_exe()
        if component is not None:
            return [str(component), "--worker"]
        if getattr(sys, "frozen", False):
            return [sys.executable, YOLO_WORKER_FLAG]
        return [sys.executable, "-m", "gamepilot.core.yolo_worker"]

    def _ensure_worker(self) -> None:
        with self._lock:
            if self._proc is not None and self._proc.poll() is None and self._ready.is_set():
                return
        with self._spawn_lock:
            with self._lock:
                if self._proc is not None and self._proc.poll() is None and self._ready.is_set():
                    return
            self._spawn()

    def _spawn(self) -> None:
        creationflags = 0x08000000 if os.name == "nt" else 0
        # worker 的 stderr 落文件：否则打包后它崩了完全没线索（只会表现为"每次检测都很慢"）
        stderr_target: IO[bytes] | int = subprocess.DEVNULL
        with contextlib.suppress(OSError):
            log_path = yolo_component.worker_log_path()
            log_path.parent.mkdir(parents=True, exist_ok=True)
            if log_path.is_file() and log_path.stat().st_size > 5 * 1024 * 1024:
                log_path.write_bytes(b"")
            handle = log_path.open("ab")
            self._stderr_file = handle
            stderr_target = handle
        proc = subprocess.Popen(
            self._worker_command(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr_target,
            env=self._worker_env(),
            close_fds=True,
            creationflags=creationflags,
        )
        with self._lock:
            self._proc = proc
            self._ready.clear()
            self._applied_key = None
        stdout: IO[bytes] | None = proc.stdout
        if stdout is None:
            self._stop_worker()
            raise RuntimeError("YOLO 子进程管道不可用")
        try:
            msg = _read(stdout, WORKER_READY_TIMEOUT_S)
        except Exception as exc:
            self._stop_worker()
            raise RuntimeError(f"YOLO 子进程启动失败: {exc}") from exc
        if not isinstance(msg, dict) or msg.get("type") != "ready":
            error = str(msg.get("error") if isinstance(msg, dict) else msg)
            self._stop_worker()
            raise RuntimeError(error or "YOLO 子进程启动失败")
        device = str(msg.get("device") or "").strip().lower()
        with self._lock:
            self._device = device
            self._ready.set()
        logger.info("YOLO 子进程就绪: device=%s", device or "unknown")
        if device != "cuda":
            # 装了 CPU 版组件时这里会一直是 cpu：界面/日志必须让人一眼看出为什么慢
            variant = yolo_component.worker_variant() or "unknown"
            logger.warning(
                "AI worker 在 CPU 上推理（variant=%s）：检测明显比 CUDA 慢，装 CUDA 版组件可快数倍",
                variant,
            )

    def _ensure_config(self, classes: tuple[str, ...], examples: list[dict[str, Any]]) -> None:
        if not classes and not examples:
            # 并集里的示例文件全没了（识别器被删/工作流被换）：别把空配置发给 worker。
            # 老组件会因此抛错并退出，导致每帧重启一次模型（几秒的加载）。
            if not self._empty_config_warned:
                self._empty_config_warned = True
                logger.warning("没有可用的示例参考图，跳过本次 YOLO 配置")
            return
        self._empty_config_warned = False
        key = (
            tuple(classes),
            tuple(
                (str(item.get("path")), tuple(item.get("rect") or ()), str(item.get("label") or ""))
                for item in examples
            ),
        )
        with self._lock:
            if self._applied_key == key:
                return
        with self._io_lock:
            with self._lock:
                if self._applied_key == key:
                    return
                proc = self._proc
            if proc is None or proc.stdin is None or proc.stdout is None:
                raise RuntimeError("YOLO 子进程不可用")
            _ipc_write(proc.stdin, {"type": "config", "classes": list(classes), "examples": examples})
            msg = _read(proc.stdout, INFER_TIMEOUT_S)
            if not isinstance(msg, dict) or msg.get("type") != "config_ok":
                error = str(msg.get("error") if isinstance(msg, dict) else msg)
                raise RuntimeError(error or "YOLO 配置失败")
            with self._lock:
                self._applied_key = key

    def _stop_worker(self) -> None:
        stderr_file = self._stderr_file
        self._stderr_file = None
        if stderr_file is not None:
            with contextlib.suppress(OSError):
                stderr_file.close()
        with self._lock:
            proc = self._proc
            self._proc = None
            self._ready.clear()
            self._applied_key = None
            self._device = ""
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
                with contextlib.suppress(Exception):
                    proc.wait(timeout=1.0)

    def shutdown(self) -> None:
        self._stop_worker()


YOLO_MANAGER = YoloManager()
