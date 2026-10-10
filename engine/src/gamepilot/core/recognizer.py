"""识别器：模板匹配（主力）+ 颜色匹配，统一产出 Detection。

约定：
- 识别器是**纯函数**（除模板缓存外不持有状态），输入 Frame，输出归一化 Detection；
- 同一标签只保留最高分的一条，状态（confirmed/pending）由投票过滤在引擎里决定；
- 模板按 mtime 缓存，避免每帧从磁盘读（5~10fps 轮询下的经典性能坑）。
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

import cv2
import numpy as np

from .frame import Detection, Frame, best_per_label
from .geometry import Rect


class Recognizer(Protocol):
    label: str

    def detect(self, frame: Frame) -> list[Detection]: ...


TEMPLATE_MIN_STD = 2.0  # 模板灰度标准差低于此值视为纯色，不可用于模板匹配


def _to_gray(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return image
    if image.shape[2] == 4:
        return cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


@dataclass
class TemplateRecognizer:
    """单模板多尺度匹配。threshold 是命中门槛，scales 覆盖投屏缩放差异。"""

    label: str
    path: str
    threshold: float = 0.82
    roi: Rect | None = None
    scales: Sequence[float] = (1.0,)
    _cache: np.ndarray | None = field(default=None, init=False, repr=False)
    _cache_key: tuple[float, int] | None = field(default=None, init=False, repr=False)

    # ---------- 模板加载 ----------

    def _template(self) -> np.ndarray | None:
        try:
            stat = os.stat(self.path)
        except OSError:
            return None
        key = (stat.st_mtime, stat.st_size)
        if self._cache is not None and self._cache_key == key:
            return self._cache
        image = cv2.imread(self.path, cv2.IMREAD_GRAYSCALE)
        if image is None:
            return None
        self._cache = image
        self._cache_key = key
        return image

    # ---------- 识别 ----------

    def detect(self, frame: Frame) -> list[Detection]:
        template = self._template()
        if template is None:
            return []
        # 纯色模板没有可判别特征：TM_CCOEFF_NORMED 在 std=0 时是退化的，
        # 会在画面任意位置给出 1.0 分。宁可返回"识别不到"，也不要报假命中。
        if float(template.std()) < TEMPLATE_MIN_STD:
            return []
        region_rect = (self.roi or Rect(0, 0, 1, 1)).clamp()
        region = frame.crop(region_rect)
        if region.size == 0:
            return []
        gray = _to_gray(region)
        offset_x, offset_y, _, _ = region_rect.to_pixels(frame.image_size)

        hits: list[Detection] = []
        for scale in self.scales:
            height, width = template.shape[:2]
            target_h, target_w = round(height * scale), round(width * scale)
            if target_h < 4 or target_w < 4 or target_h > gray.shape[0] or target_w > gray.shape[1]:
                continue
            scaled = cv2.resize(
                template,
                (target_w, target_h),
                interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR,
            )
            result = cv2.matchTemplate(gray, scaled, cv2.TM_CCOEFF_NORMED)
            ys, xs = np.where(result >= self.threshold)
            for y, x in zip(ys.tolist(), xs.tolist(), strict=True):
                rect = Rect.from_pixels(
                    offset_x + x,
                    offset_y + y,
                    target_w,
                    target_h,
                    frame.image_size,
                ).clamp()
                hits.append(
                    Detection(
                        label=self.label,
                        rect=rect,
                        score=float(result[y, x]),
                        source="template",
                    )
                )
        return _nms(hits)[:4]


@dataclass
class ColorRecognizer:
    """按颜色找区域：血条、体力条、按钮高亮态这类纯色 UI 比模板更稳。"""

    label: str
    target_bgr: Sequence[int]
    tolerance: int = 30
    min_pixels: int = 60
    roi: Rect | None = None

    def detect(self, frame: Frame) -> list[Detection]:
        region_rect = (self.roi or Rect(0, 0, 1, 1)).clamp()
        region = frame.crop(region_rect)
        if region.size == 0:
            return []
        offset_x, offset_y, _, _ = region_rect.to_pixels(frame.image_size)
        target = np.array(self.target_bgr[:3], dtype=np.int16)
        mask = (np.abs(region.astype(np.int16) - target).max(axis=2) <= self.tolerance).astype(np.uint8)
        if int(mask.sum()) < self.min_pixels:
            return []
        ys, xs = np.nonzero(mask)
        rect = Rect.from_pixels(
            offset_x + float(xs.min()),
            offset_y + float(ys.min()),
            float(xs.max() - xs.min() + 1),
            float(ys.max() - ys.min() + 1),
            frame.image_size,
        ).clamp()
        coverage = float(mask.mean())
        return [Detection(label=self.label, rect=rect, score=float(min(1.0, coverage * 4)), source="color")]


def _nms(hits: list[Detection], iou_threshold: float = 0.3) -> list[Detection]:
    ordered = sorted(hits, key=lambda item: item.score, reverse=True)
    kept: list[Detection] = []
    for hit in ordered:
        if all(_iou(hit.rect, item.rect) <= iou_threshold for item in kept):
            kept.append(hit)
    return kept


def _iou(a: Rect, b: Rect) -> float:
    x1, y1 = max(a.x, b.x), max(a.y, b.y)
    x2, y2 = min(a.x + a.w, b.x + b.w), min(a.y + a.h, b.y + b.h)
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    if inter <= 0:
        return 0.0
    union = a.w * a.h + b.w * b.h - inter
    return inter / union if union > 0 else 0.0


def build_recognizer(label: str, spec: dict[str, Any], base_dir: str) -> Recognizer:
    """按 DSL 片段构造识别器（types: template / color）。"""
    kind = str(spec.get("type", "template")).lower()
    roi = Rect.parse(spec["roi"]) if spec.get("roi") else None
    if kind == "template":
        path = str(spec["template"])
        if not os.path.isabs(path):
            path = os.path.join(base_dir, path)
        scales = tuple(float(item) for item in spec.get("scales", [1.0]))
        return TemplateRecognizer(
            label=label,
            path=path,
            threshold=float(spec.get("threshold", 0.82)),
            roi=roi,
            scales=scales,
        )
    if kind == "color":
        return ColorRecognizer(
            label=label,
            target_bgr=[int(item) for item in spec.get("target_bgr", [0, 0, 0])],
            tolerance=int(spec.get("tolerance", 30)),
            min_pixels=int(spec.get("min_pixels", 60)),
            roi=roi,
        )
    raise ValueError(f"未知识别器类型: {kind!r}（当前支持 template / color）")


class VoteFilter:
    """连续 N 帧命中才算"确认"，用来压掉动画/特效造成的单帧误判。"""

    def __init__(self, window: int = 2) -> None:
        self.window = max(1, window)
        self._streak: dict[str, int] = {}

    def update(self, label: str, hit: bool) -> bool:
        self._streak[label] = self._streak.get(label, 0) + 1 if hit else 0
        return self._streak[label] >= self.window

    def reset(self) -> None:
        self._streak.clear()

    def snapshot(self) -> dict[str, int]:
        return dict(self._streak)


def perceive(graph_recognizers: dict[str, Recognizer], frame: Frame, vote: VoteFilter) -> dict[str, Detection]:
    """跑一遍所有识别器，返回 {label: Detection}，并把投票状态写进 Detection.state。"""
    raw: list[Detection] = []
    for recognizer in graph_recognizers.values():
        try:
            raw.extend(recognizer.detect(frame))
        except Exception:  # 单个识别器坏掉不该拖垮整帧
            continue
    best = best_per_label(raw)
    out: dict[str, Detection] = {}
    for label, detection in best.items():
        confirmed = vote.update(label, True)
        detection.state = "confirmed" if confirmed else "pending"
        out[label] = detection
    for label in list(vote.snapshot()):
        if label not in best:
            vote.update(label, False)
    return out
