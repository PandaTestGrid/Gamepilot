"""YOLO 开放词汇检测的推理核心（不依赖引擎其他模块，可独立复用）。

**示例优先**：给参考帧里的一个框（或多框），从图像特征算出「类向量」，再在画面里找同类。
文字提示作为可选的补充（融合模式），不需要时完全不加载文本编码器。

设计要点：
- **延迟导入**：torch / ultralytics 只在构造 Detector 时才导入；引擎主进程从不 import 重依赖。
- **示例参考图的取法**：把整张参考帧交给 YOLOE 的视觉提示预测器（内置 letterbox 到
  imgsz），框用原图坐标 —— 和整图推理同一分布；不要紧贴目标裁剪，缩放失真会让召回掉到 0。
- **坐标口径**：示例 `rect` 是归一化 [x, y, w, h]（相对参考帧）；返回值是输入图的**像素坐标**。
"""

from __future__ import annotations

import logging
import os
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import cv2
import numpy as np

DEFAULT_MODEL = "yoloe-11s-seg.pt"
#: 换模型：GAMEPILOT_YOLO_MODEL 指定权重文件名（如 yoloe-11m-seg.pt）；目录见 model_dir()
MODEL_ENV = "GAMEPILOT_YOLO_MODEL"
DEFAULT_IMGSZ = 640
#: 词表上限：类别太多会让对比头难判，20 是经验上限
MAX_CLASSES = 20
VALID_IMGSZ = (480, 640, 800, 960, 1280)
#: 示例参考图的推理尺寸（与整图推理的 imgsz 对齐）
REFERENCE_IMGSZ = 640

logger = logging.getLogger("gamepilot.yolo.infer")

_lock = None
_detector: Detector | None = None


def model_dir() -> Path:
    """模型目录：环境变量 > 包内 assets/yolo（模型不进 git，见 CONVENTIONS §11.2.5）。"""
    override = os.environ.get("GAMEPILOT_YOLO_MODEL_DIR", "").strip()
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent / "assets" / "yolo"


def default_model() -> str:
    """当前使用的权重文件名（环境变量 > 内置默认）。"""
    return os.environ.get(MODEL_ENV, "").strip() or DEFAULT_MODEL


def model_file(name: str | None = None) -> Path:
    return model_dir() / (name or default_model())


def available(name: str | None = None) -> bool:
    if not model_file(name).is_file():
        return False
    try:
        import importlib.util

        return importlib.util.find_spec("ultralytics") is not None
    except Exception:
        return False


def status() -> dict[str, Any]:
    return {
        "available": available(),
        "modelDir": str(model_dir()),
        "model": default_model(),
        "modelPresent": model_file().is_file(),
    }


#: 分块检测的瓦片上限（超过就退化成整图，避免一张 8K 图切出几百块把显存打爆）
MAX_TILES = 80
#: 分块推理的批大小：一次喂 8 块比逐块快，再多会在 CUDA 上触发分配器抖动
TILE_BATCH = 8


def tile_grid(width: int, height: int, tile_size: int, overlap: float) -> list[tuple[int, int, int, int]]:
    """把画面切成互相重叠的瓦片：[x, y, w, h]（像素），按行优先。"""
    tile_size = max(64, min(int(tile_size), max(width, height)))
    step = max(32, int(tile_size * (1.0 - max(0.0, min(float(overlap), 0.8)))))
    xs = list(range(0, max(1, width - tile_size + 1), step)) or [0]
    ys = list(range(0, max(1, height - tile_size + 1), step)) or [0]
    if xs[-1] + tile_size < width:
        xs.append(max(0, width - tile_size))
    if ys[-1] + tile_size < height:
        ys.append(max(0, height - tile_size))
    tiles: list[tuple[int, int, int, int]] = []
    for y in ys:
        for x in xs:
            tiles.append((x, y, min(tile_size, width - x), min(tile_size, height - y)))
    return tiles


def _iou(a: list[float], b: list[float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = inter_w * inter_h
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def nms_per_class(dets: list[dict[str, Any]], iou_threshold: float) -> list[dict[str, Any]]:
    """按类做 NMS（分块合并用）：同类重叠框只留置信度最高的。"""
    kept: list[dict[str, Any]] = []
    for det in sorted(dets, key=lambda item: -float(item.get("conf", 0.0))):
        cls = str(det.get("class") or "")
        box = [float(v) for v in det.get("bbox") or [0, 0, 0, 0]]
        if any(
            str(other.get("class") or "") == cls
            and _iou(box, [float(v) for v in other.get("bbox") or [0, 0, 0, 0]]) > iou_threshold
            for other in kept
        ):
            continue
        kept.append(det)
    return kept


class Detector:
    """一个 YOLOE 权重 + 一组示例/文字算出的类向量。"""

    def __init__(self, model: str | None = None, device: str | None = None) -> None:
        import torch
        from ultralytics import YOLOE

        self._torch = torch
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        path = model_file(model)
        if not path.is_file():
            raise FileNotFoundError(f"YOLO 模型缺失：{path}（设置 GAMEPILOT_YOLO_MODEL_DIR 指向权重目录）")
        self._model = YOLOE(str(path))
        self._model.to(self.device)
        self._names: tuple[str, ...] = ()

    # ---------- 配置 ----------

    def _vpe_from_example(self, image: np.ndarray, rect: Sequence[float]) -> Any:
        """示例框 → (1, 1, 512) 视觉提示向量。

        和整图推理同一分布：把**整张参考帧**交给 YOLOE 的视觉提示预测器，
        框用原图像素坐标（预测器内部会按 letterbox 缩放）。
        """
        from PIL import Image as PILImage
        from ultralytics.models.yolo.yoloe import YOLOEVPSegPredictor

        height, width = image.shape[:2]
        x, y, w, h = (float(v) for v in rect)
        box = [x * width, y * height, (x + w) * width, (y + h) * height]
        source = PILImage.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
        predictor = YOLOEVPSegPredictor(
            overrides={
                "task": "segment",
                "mode": "predict",
                "imgsz": REFERENCE_IMGSZ,
                "device": self.device,
                "verbose": False,
                "save": False,
                "batch": 1,
            },
            _callbacks=self._model.callbacks,
        )
        predictor.set_prompts(
            {
                "bboxes": np.asarray([box], dtype=np.float32),
                "cls": np.zeros(1, dtype=np.int64),
            }
        )
        predictor.setup_model(model=self._model.model, verbose=False)
        return predictor.get_vpe(source)  # (1, 1, 512)

    def configure(self, classes: list[str], examples: list[dict[str, Any]]) -> None:
        """配置类向量。

        examples: [{path: 参考帧路径, rect: 归一化 [x,y,w,h], label?: 类别名}]
        classes : 可选的文字提示（与示例融合；不需要就传空列表，不加载文本编码器）
        """
        cleaned_classes = tuple(dict.fromkeys(" ".join(str(c).split()) for c in classes if str(c).strip()))
        if not cleaned_classes and not examples:
            raise ValueError("YOLO 识别器至少需要一个示例框（或文字类别）")
        if len(cleaned_classes) > MAX_CLASSES:
            raise ValueError(f"类别太多（{len(cleaned_classes)} > {MAX_CLASSES}）")

        labels: list[str] = list(cleaned_classes)
        vectors: list[Any] = []
        if cleaned_classes:
            text_pe = self._model.model.get_text_pe(list(cleaned_classes), cache_clip_model=True)
            vectors.append(text_pe.to(self.device))

        grouped: dict[str, list[Any]] = {}
        for index, example in enumerate(examples):
            path = Path(str(example.get("path") or ""))
            if not path.is_file():
                # 图/盘不同步（旧引擎、手删文件）时不要让 worker 崩：跳过坏示例
                logger.warning("示例参考图不存在，跳过：%s", path)
                continue
            import cv2

            image = cv2.imread(str(path), cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError(f"示例参考图读不出来：{path}")
            rect = example.get("rect") or [0, 0, 1, 1]
            label = " ".join(str(example.get("label") or f"目标{index + 1}").split()) or f"目标{index + 1}"
            grouped.setdefault(label, []).append(self._vpe_from_example(image, rect))

        for label, items in grouped.items():
            merged = self._torch.cat(items, dim=0).mean(dim=0, keepdim=True)
            merged = self._torch.nn.functional.normalize(merged, p=2, dim=-1)
            # 和文字类别重名时改名，避免 names 字典丢类 / 向量数与类名数对不上
            final = label
            suffix = 1
            while final in labels:
                suffix += 1
                final = f"{label}·{suffix}"
            labels.append(final)
            vectors.append(merged)

        if not vectors:
            raise ValueError("没有可用的示例参考图（文件缺失或示例为空）")
        names = tuple(dict.fromkeys(labels))
        self._model.model.set_classes(list(names), self._torch.cat(vectors, dim=1))
        self._model.predictor = None
        self._names = names

    @property
    def names(self) -> tuple[str, ...]:
        return self._names

    # ---------- 推理 ----------

    def _predict(
        self,
        images: list[np.ndarray],
        *,
        conf: float,
        iou: float,
        imgsz: int,
    ) -> list[list[tuple[list[float], float, int]]]:
        """批量推理；返回每张图的 (像素框, 置信度, 类索引)。"""
        results = self._model.predict(
            images,
            conf=float(conf),
            iou=float(iou),
            imgsz=int(imgsz),
            verbose=False,
            device=self.device,
        )
        out: list[list[tuple[list[float], float, int]]] = []
        for result in results:
            items: list[tuple[list[float], float, int]] = []
            boxes = result.boxes
            if boxes is not None and len(boxes) > 0:
                for (x1, y1, x2, y2), score, cls in zip(
                    boxes.xyxy.cpu().numpy(),
                    boxes.conf.cpu().numpy(),
                    boxes.cls.cpu().numpy().astype(int),
                    strict=True,
                ):
                    items.append(([float(x1), float(y1), float(x2), float(y2)], float(score), int(cls)))
            out.append(items)
        return out

    def infer(
        self,
        image_bgr: np.ndarray,
        *,
        conf: float = 0.3,
        iou: float = 0.45,
        imgsz: int = DEFAULT_IMGSZ,
        tile: bool = False,
        tile_size: int = 640,
        tile_overlap: float = 0.2,
    ) -> list[dict[str, Any]]:
        if image_bgr.size == 0 or not self._names:
            return []
        if imgsz not in VALID_IMGSZ:
            imgsz = DEFAULT_IMGSZ
        height, width = image_bgr.shape[:2]
        names = self._names

        if not tile or (width <= tile_size and height <= tile_size):
            raw = self._predict([image_bgr], conf=conf, iou=iou, imgsz=imgsz)[0]
            full_dets: list[dict[str, Any]] = [
                {
                    "class": str(names[cls]) if 0 <= cls < len(names) else str(cls),
                    "conf": round(score, 4),
                    "bbox": [round(v, 1) for v in box],
                }
                for box, score, cls in raw
            ]
            full_dets.sort(key=lambda item: -float(item["conf"]))
            return full_dets

        tiles = tile_grid(width, height, tile_size, tile_overlap)
        if len(tiles) > MAX_TILES:
            # 太碎了：退回整图（结果差点但不会卡死）
            return self.infer(image_bgr, conf=conf, iou=iou, imgsz=imgsz, tile=False)

        dets: list[dict[str, Any]] = []
        for start in range(0, len(tiles), TILE_BATCH):
            batch = tiles[start : start + TILE_BATCH]
            crops = [image_bgr[y : y + h, x : x + w] for (x, y, w, h) in batch]
            for (bx, by, _, _), items in zip(
                batch, self._predict(crops, conf=conf, iou=iou, imgsz=tile_size), strict=True
            ):
                for box, score, cls in items:
                    dets.append(
                        {
                            "class": str(names[cls]) if 0 <= cls < len(names) else str(cls),
                            "conf": round(score, 4),
                            "bbox": [
                                round(box[0] + bx, 1),
                                round(box[1] + by, 1),
                                round(box[2] + bx, 1),
                                round(box[3] + by, 1),
                            ],
                        }
                    )
        merged = nms_per_class(dets, float(iou))
        merged.sort(key=lambda item: -float(item["conf"]))
        return merged


def shared_detector() -> Detector:
    """进程内单例（离线脚本 / 单进程 worker 用；引擎走子进程，不经过这里）。"""
    global _detector
    if _detector is None:
        _detector = Detector()
    return _detector
