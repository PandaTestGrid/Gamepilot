"""识别器：模板匹配（主力）+ 颜色匹配，统一产出 Detection。

约定：
- 识别器是**纯函数**（除模板缓存外不持有状态），输入 Frame，输出归一化 Detection；
- 同一标签只保留最高分的一条，状态（confirmed/pending）由投票过滤在引擎里决定；
- 模板按 mtime 缓存，避免每帧从磁盘读（5~10fps 轮询下的经典性能坑）。

搜索范围（`search`）：
- `region`（默认）：只在 `roi` 里找。录制时 roi = 框选矩形，所以默认行为与老版本一致；
- `full`：忽略 roi，整帧搜索，命中后 Detection.rect 就是目标**当前**位置 ——
  同一个按钮出现在屏幕别处也能点到。
整帧搜索走「降采样粗搜 → 候选窗口原分辨率复核」，精度由复核那一步决定，
单尺度耗时从 1080p 的 45~75ms 降到 ~15ms（见 docs/DESIGN.md §7）。
"""

from __future__ import annotations

import math
import os
import re
import threading
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

import cv2
import numpy as np

from .frame import Detection, Frame, best_per_label
from .geometry import Rect, Size
from .ocr import OCR_MANAGER
from .yolo import DEFAULT_MAX_AGE_FRAMES, YOLO_MANAGER
from .yolo_infer import DEFAULT_IMGSZ as YOLO_DEFAULT_IMGSZ
from .yolo_infer import MAX_CLASSES as YOLO_MAX_CLASSES
from .yolo_infer import VALID_IMGSZ as YOLO_VALID_IMGSZ

TEMPLATE_MIN_STD = 2.0  # 模板灰度标准差低于此值视为纯色，不可用于模板匹配
YOLO_DEFAULT_THRESHOLD = 0.3

# 搜索区域超过这么多像素才走「降采样粗搜 + 原分辨率复核」。
# 小区域（状态图里的局部判定）直接全分辨率匹配，几百微秒就够，没必要引入近似。
COARSE_SEARCH_MIN_PIXELS = 640 * 480
COARSE_SEARCH_FACTOR = 2
# 粗搜阈值放低一点：降采样会让分数轻微抖动，宁可多收几个候选，也不要漏掉真目标
COARSE_SCORE_MARGIN = 0.10
# 只复核「离最高分不太远」的候选，避免低阈值在噪点上生成一堆无意义窗口
COARSE_SCORE_SPREAD = 0.15
COARSE_MAX_CANDIDATES = 12
# 前两名分数差小于这个值、且位置明显不同 → 视为"多个同分候选"（默认不猜）。
AMBIGUITY_EPS = 0.02
# 同一模板在画面里最多保留多少个候选（整帧搜一排图标时可能远多于 4 个）。
MAX_CANDIDATES = 24

SEARCH_MODES = ("region", "full")

#: OCR 文本的匹配方式（`contains` 最常用：识别一段里包含关键字就算命中）
OCR_MODES = ("contains", "equals", "regex")

# YOLO manager 只返回源帧 index；有界保留提交过的源图时间，未知源一律不猜。
ASYNC_SOURCE_HISTORY_LIMIT = 128


def _async_result_is_fresh(frame: Frame, result_frame: int, source_ts: float | None, max_age_frames: int) -> bool:
    ttl = frame.async_max_age_seconds
    if ttl is None:
        return frame.index - result_frame <= max_age_frames
    if source_ts is None:
        return False
    age = time.time() - source_ts
    return math.isfinite(ttl) and ttl >= 0 and math.isfinite(age) and 0 <= age <= ttl


class Recognizer(Protocol):
    label: str

    def detect(self, frame: Frame) -> list[Detection]: ...


def _parse_size(value: object) -> Size | None:
    """`[w, h]` → (w, h)；老工作流没有这个字段 → None（退回单尺度 1.0）。"""
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    try:
        width, height = int(value[0]), int(value[1])
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return (width, height)


def normalize_search(value: object) -> str:
    """把 spec 里的 `search` 规范成 `region` / `full`；非法值明确报错，不静默降级。"""
    search = str(value or "region").strip().lower()
    if search not in SEARCH_MODES:
        raise ValueError(f"未知识别器搜索范围: {search!r}（支持 {' / '.join(SEARCH_MODES)}）")
    return search


@dataclass
class TemplateRecognizer:
    """单模板多尺度匹配。threshold 是命中门槛，scales 覆盖投屏缩放差异。

    `search="full"` 时忽略 `roi` 做整帧搜索；`roi` 仍保留，方便界面切回局部时复用。
    """

    label: str
    path: str
    threshold: float = 0.82
    roi: Rect | None = None
    #: 显式缩放表（spec 里写了 `scales` 才有）。None = 按 `recorded_size` 与当前帧的比例自动算，
    #: 换分辨率（录在 1080p、跑在 720p）时不用重新录模板
    scales: Sequence[float] | None = None
    #: 录制时那一帧的像素尺寸。有了它才能知道"现在这帧比录制时缩了多少"
    recorded_size: Size | None = None
    search: str = "region"
    enabled: bool = True
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

    def _search_rect(self, search: str) -> Rect:
        if search == "full":
            return Rect(0, 0, 1, 1)
        return (self.roi or Rect(0, 0, 1, 1)).clamp()

    def _scales_for(self, frame: Frame) -> Sequence[float]:
        """这次该用哪些缩放。显式 `scales` 优先；否则按录制尺寸 vs 当前帧算 + 少量容错。"""
        if self.scales is not None:
            return self.scales
        if self.recorded_size is None or self.recorded_size[0] <= 0:
            return (1.0,)
        ratio = frame.image_size[0] / float(self.recorded_size[0])
        if 0.97 <= ratio <= 1.03:
            return (1.0,)
        scales = [ratio]
        for delta in (-0.06, 0.06):
            candidate = ratio * (1.0 + delta)
            if 0.35 <= candidate <= 2.8:
                scales.append(round(candidate, 4))
        return tuple(dict.fromkeys(scales))

    def detect(self, frame: Frame, *, search: str | None = None) -> list[Detection]:
        """识别一帧。`search` 是**本次调用**的搜索范围覆盖（步骤链用），
        不传则用模板自己的默认值（`self.search`）。"""
        if not self.enabled:
            return []
        template = self._template()
        if template is None:
            return []
        # 纯色模板没有可判别特征：TM_CCOEFF_NORMED 在 std=0 时是退化的，
        # 会在画面任意位置给出 1.0 分。宁可返回"识别不到"，也不要报假命中。
        if float(template.std()) < TEMPLATE_MIN_STD:
            return []
        mode = self.search if search is None else normalize_search(search)
        region_rect = self._search_rect(mode)
        gray = frame.gray_crop(region_rect)
        if gray.size == 0:
            return []
        offset_x, offset_y, _, _ = region_rect.to_pixels(frame.image_size)

        hits: list[Detection] = []
        for scale in self._scales_for(frame):
            height, width = template.shape[:2]
            target_h, target_w = round(height * scale), round(width * scale)
            if target_h < 4 or target_w < 4 or target_h > gray.shape[0] or target_w > gray.shape[1]:
                continue
            scaled = cv2.resize(
                template,
                (target_w, target_h),
                interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR,
            )
            hits.extend(
                self._match(
                    gray,
                    np.asarray(scaled),
                    (offset_x, offset_y),
                    frame.image_size,
                )
            )
        kept = _nms(hits)[:MAX_CANDIDATES]
        near_top = [item for item in kept[1:] if kept[0].score - item.score <= AMBIGUITY_EPS]
        if any(_distinct(kept[0].rect, item.rect) for item in near_top):
            # 画面里有多个几乎同分、位置不同的目标：只标记，不在这里决定要不要点。
            # 点哪一个由步骤的 `strategy` 决定（默认仍拒绝猜，见 core/selection.py）。
            kept[0].ambiguous = True
        return kept

    def _match(
        self,
        gray: np.ndarray,
        template: np.ndarray,
        offset: tuple[int, int],
        size: Size,
    ) -> list[Detection]:
        """按搜索区域大小选全分辨率直搜或「粗搜 + 复核」。"""
        if not _use_coarse(gray.shape, template.shape):
            return self._match_exact(gray, template, offset, size)
        return self._match_coarse(gray, template, offset, size)

    def _match_exact(
        self,
        gray: np.ndarray,
        template: np.ndarray,
        offset: tuple[int, int],
        size: Size,
        *,
        origin: tuple[int, int] = (0, 0),
    ) -> list[Detection]:
        result = np.asarray(cv2.matchTemplate(gray, template, cv2.TM_CCOEFF_NORMED))
        return self._hits(result, template.shape[1], template.shape[0], offset, size, origin)

    def _hits(
        self,
        result: np.ndarray,
        template_w: int,
        template_h: int,
        offset: tuple[int, int],
        size: Size,
        origin: tuple[int, int],
    ) -> list[Detection]:
        ys, xs = np.where(result >= self.threshold)
        offset_x, offset_y = offset
        origin_x, origin_y = origin
        hits: list[Detection] = []
        for y, x in zip(ys.tolist(), xs.tolist(), strict=True):
            rect = Rect.from_pixels(
                offset_x + origin_x + x,
                offset_y + origin_y + y,
                template_w,
                template_h,
                size,
            ).clamp()
            hits.append(
                Detection(
                    label=self.label,
                    rect=rect,
                    score=float(result[y, x]),
                    source="template",
                )
            )
        return hits

    def _match_coarse(
        self,
        gray: np.ndarray,
        template: np.ndarray,
        offset: tuple[int, int],
        size: Size,
    ) -> list[Detection]:
        """1/N 分辨率粗搜找候选，再在原分辨率的小窗口里复核出精确位置。

        精度由复核决定（阈值仍在原分辨率上判定），粗搜只负责"别漏"。
        """
        height, width = gray.shape[:2]
        small_w = max(1, width // COARSE_SEARCH_FACTOR)
        small_h = max(1, height // COARSE_SEARCH_FACTOR)
        template_w = max(1, round(template.shape[1] / COARSE_SEARCH_FACTOR))
        template_h = max(1, round(template.shape[0] / COARSE_SEARCH_FACTOR))
        if small_w < template_w or small_h < template_h:
            return self._match_exact(gray, template, offset, size)
        small = cv2.resize(gray, (small_w, small_h), interpolation=cv2.INTER_AREA)
        small_template = cv2.resize(template, (template_w, template_h), interpolation=cv2.INTER_AREA)
        coarse = np.asarray(cv2.matchTemplate(small, small_template, cv2.TM_CCOEFF_NORMED))
        candidates = _peak_candidates(coarse, self.threshold - COARSE_SCORE_MARGIN, COARSE_MAX_CANDIDATES)
        if not candidates:
            return []

        hits: list[Detection] = []
        full_w, full_h = template.shape[1], template.shape[0]
        ratio_x = width / small_w
        ratio_y = height / small_h
        pad = COARSE_SEARCH_FACTOR * 2 + 2
        for _, coarse_x, coarse_y in candidates:
            center_x, center_y = round(coarse_x * ratio_x), round(coarse_y * ratio_y)
            x0 = max(0, center_x - pad)
            y0 = max(0, center_y - pad)
            x1 = min(width, center_x + full_w + pad)
            y1 = min(height, center_y + full_h + pad)
            window = gray[y0:y1, x0:x1]
            if window.shape[0] < full_h or window.shape[1] < full_w:
                continue
            hits.extend(
                self._match_exact(
                    window,
                    template,
                    offset,
                    size,
                    origin=(x0, y0),
                )
            )
        return hits


@dataclass
class ColorRecognizer:
    """按颜色找区域：血条、体力条、按钮高亮态这类纯色 UI 比模板更稳。"""

    label: str
    target_bgr: Sequence[int]
    tolerance: int = 30
    min_pixels: int = 60
    roi: Rect | None = None
    enabled: bool = True

    def detect(self, frame: Frame) -> list[Detection]:
        if not self.enabled:
            return []
        region_rect = (self.roi or Rect(0, 0, 1, 1)).clamp()
        region = frame.crop(region_rect)
        if region.size == 0:
            return []
        offset_x, offset_y, _, _ = region_rect.to_pixels(frame.image_size)
        target = np.array(self.target_bgr[:3], dtype=np.int16)
        if (
            region.dtype == np.uint8
            and region.ndim == 3
            and region.shape[2] == 3
            and target.shape == (3,)
            and bool(np.all((target >= 0) & (target <= 255)))
            and self.tolerance >= 0
        ):
            # OpenCV scans the interleaved BGR image without allocating a full
            # int16 difference tensor or coordinate arrays for every hit pixel.
            lower = tuple(math.ceil(max(0.0, float(value) - self.tolerance)) for value in target)
            upper = tuple(math.floor(min(255.0, float(value) + self.tolerance)) for value in target)
            mask = cv2.inRange(region, lower, upper)
            pixels = cv2.countNonZero(mask)
            if pixels < self.min_pixels:
                return []
            if pixels:
                x, y, width, height = cv2.boundingRect(mask)
                coverage = pixels / float(mask.size)
                rect = Rect.from_pixels(offset_x + x, offset_y + y, width, height, frame.image_size).clamp()
                return [Detection(label=self.label, rect=rect, score=float(min(1.0, coverage * 4)), source="color")]
        # Preserve legacy behavior for unusual dtypes, targets, negative tolerance
        # and invalid empty-hit/min_pixels combinations (including their errors).
        mask = (np.abs(region.astype(np.int16) - target).max(axis=2) <= self.tolerance).astype(np.uint8)
        if int(mask.sum()) < self.min_pixels:
            return []
        ys, xs = np.nonzero(mask)
        rect = Rect.from_pixels(
            offset_x + float(np.min(xs)),
            offset_y + float(np.min(ys)),
            float(np.max(xs) - np.min(xs) + 1),
            float(np.max(ys) - np.min(ys) + 1),
            frame.image_size,
        ).clamp()
        coverage = float(mask.mean())
        return [Detection(label=self.label, rect=rect, score=float(min(1.0, coverage * 4)), source="color")]


def _use_coarse(gray_shape: tuple[int, ...], template_shape: tuple[int, int]) -> bool:
    height, width = gray_shape[:2]
    if width * height < COARSE_SEARCH_MIN_PIXELS:
        return False
    # 模板缩到 1/2 后至少要还有 4px，否则粗搜没有意义
    return template_shape[0] >= 4 * COARSE_SEARCH_FACTOR and template_shape[1] >= 4 * COARSE_SEARCH_FACTOR


def _peak_candidates(result: np.ndarray, threshold: float, limit: int) -> list[tuple[float, int, int]]:
    """取粗搜结果里的局部峰值（每个连通块取一个最高点），按分数降序返回前 limit 个。"""
    if result.size == 0:
        return []
    top = float(result.max())
    if top < threshold:
        return []
    floor = max(threshold, top - COARSE_SCORE_SPREAD)
    mask = (result >= floor).astype(np.uint8)
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    stats_array = np.asarray(stats)
    peaks: list[tuple[float, int, int]] = []
    for index in range(1, count):
        x = int(stats_array[index, cv2.CC_STAT_LEFT])
        y = int(stats_array[index, cv2.CC_STAT_TOP])
        w = int(stats_array[index, cv2.CC_STAT_WIDTH])
        h = int(stats_array[index, cv2.CC_STAT_HEIGHT])
        patch = result[y : y + h, x : x + w]
        local_y, local_x = np.unravel_index(int(np.argmax(patch)), patch.shape)
        peaks.append((float(patch[local_y, local_x]), x + int(local_x), y + int(local_y)))
    peaks.sort(key=lambda item: item[0], reverse=True)
    return peaks[:limit]


def _distinct(a: Rect, b: Rect) -> bool:
    """两个矩形中心是否明显不是同一个目标（避免多尺度命中被误判成"同分候选"）。"""
    return abs(a.cx - b.cx) > 0.5 * max(a.w, b.w) or abs(a.cy - b.cy) > 0.5 * max(a.h, b.h)


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


@dataclass
class OcrRecognizer:
    """OCR 识别器：框一块区域，读里面的字，按「包含 / 相等 / 正则」判定。

    为什么是**异步 + 缓存**：OCR 一次 100ms~1s（PP-OCRv4 走子进程），而采集循环是
    8~28fps。绝不能在这一帧里同步等结果，否则整个采集停摆。做法是：
      - 提交一次推理，立刻返回上一帧的结果（默认最多落后 `max_age_frames` 帧；
        Frame.async_max_age_seconds 启用时改为源图时间 TTL）；
      - 同一时刻只有一个在跑（`_pending`），OCR 未就绪/失败时返回"没命中"并记 `last_error`。

    `rect` 取命中文字的外框（识别不到具体条目时退化成 roi），所以 OCR 也能当点击目标。
    """

    label: str
    text: str
    mode: str = "contains"
    threshold: float = 0.6
    roi: Rect | None = None
    search: str = "region"
    max_age_frames: int = 3
    enabled: bool = True
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)
    _result: dict[str, Any] | None = field(default=None, init=False, repr=False)
    _result_frame: int = field(default=0, init=False, repr=False)
    _result_ts: float | None = field(default=None, init=False, repr=False)
    _pending: bool = field(default=False, init=False, repr=False)
    last_error: str | None = field(default=None, init=False, repr=False)
    _pattern: re.Pattern[str] | None = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        if not str(self.text).strip():
            raise ValueError(f"识别器「{self.label}」：OCR 必须填写要识别的文字")
        if self.mode not in OCR_MODES:
            raise ValueError(f"识别器「{self.label}」：OCR 匹配方式只能是 {' / '.join(OCR_MODES)}")
        if self.mode == "regex":
            try:
                self._pattern = re.compile(self.text)
            except re.error as error:
                raise ValueError(f"识别器「{self.label}」：正则写错了（{error}）") from error

    # ---------- 识别 ----------

    def detect(self, frame: Frame) -> list[Detection]:
        if not self.enabled:
            return []
        self._submit(frame)
        return self._match(frame)

    def _submit(self, frame: Frame) -> None:
        """没有在跑的任务时提交一次（拿不到图/模型没就绪就跳过，不阻塞）。"""
        if frame.image is None or frame.image.size == 0:
            return
        with self._lock:
            if self._pending:
                return
            self._pending = True
            frame_index = frame.index
            source_ts = frame.ts
        try:
            OCR_MANAGER.begin_recognize(
                frame,
                self.roi,
                on_complete=lambda payload: self._store(payload, frame_index, source_ts),
            )
            self.last_error = None
        except Exception as error:  # 模型没下载 / 子进程起不来
            with self._lock:
                self._pending = False
            self.last_error = str(error)

    def _store(self, payload: dict[str, Any], frame_index: int, source_ts: float) -> None:
        with self._lock:
            self._pending = False
            if payload.get("cancelled"):
                return
            self._result = payload
            self._result_frame = frame_index
            self._result_ts = source_ts
            self.last_error = str(payload.get("error") or "") or None

    def _text_matches(self, text: str) -> bool:
        target = self.text
        if self.mode == "equals":
            return text.strip() == target.strip()
        if self.mode == "regex":
            pattern = self._pattern or re.compile(target)
            return pattern.search(text) is not None
        return target in text

    def _target_rect(self, payload: dict[str, Any]) -> Rect:
        items = payload.get("items")
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                text = str(item.get("text") or "")
                raw_rect = item.get("rect")
                if text and raw_rect is not None and self._text_matches(text):
                    try:
                        return Rect.parse(raw_rect).clamp()
                    except (TypeError, ValueError):
                        continue
            first = items[0] if items else None
            if isinstance(first, dict) and first.get("rect") is not None:
                try:
                    return Rect.parse(first["rect"]).clamp()
                except (TypeError, ValueError):
                    pass
        return (self.roi or Rect(0, 0, 1, 1)).clamp()

    def _match(self, frame: Frame) -> list[Detection]:
        with self._lock:
            payload = self._result
            result_frame = self._result_frame
            source_ts = self._result_ts
        if payload is None:
            return []
        # 结果太旧就当没看见：OCR 慢的时候，屏幕上那行字可能已经没了
        if not _async_result_is_fresh(frame, result_frame, source_ts, self.max_age_frames):
            return []
        text = str(payload.get("text") or "")
        score = float(payload.get("score") or 0.0)
        if not text or score < self.threshold or not self._text_matches(text):
            return []
        return [Detection(self.label, self._target_rect(payload), score=score, source="ocr")]


@dataclass
class YoloRecognizer:
    """开放词汇检测：给几个类别名（英文名词短语），在画面里找任意同类目标。

    和模板识别器的区别：不依赖预先截的 PNG，换目标只改词；代价是慢（GPU 20~80ms/次）
    且结果来自子进程，默认按 `max_age_frames` 限龄；Frame 显式启用 TTL 时按源图 ts 限龄。

    `search` 与模板一致：`region` 只看 `roi`，`full` 整帧找。整帧模式下返回的
    `Detection.rect` 就是目标当前所在位置，点击动作直接可用。
    """

    label: str
    classes: Sequence[str] = ()
    #: 示例：[{path: 参考帧绝对路径, rect: 归一化 [x,y,w,h], label?: 类别名}]（示例优先）
    examples: Sequence[dict[str, Any]] = ()
    threshold: float = YOLO_DEFAULT_THRESHOLD
    roi: Rect | None = None
    search: str = "region"
    imgsz: int = YOLO_DEFAULT_IMGSZ
    #: 分块检测：大分辨率/目标小的时候开；tile_size 建议等于 imgsz
    tile: bool = False
    tile_size: int = 640
    tile_overlap: float = 0.2
    max_age_frames: int = DEFAULT_MAX_AGE_FRAMES
    #: 依赖注入点：单测传 fake，运行时不传则用全局单例
    manager: Any = field(default=None, repr=False, compare=False)
    enabled: bool = True
    enabled_after_frame: int = field(default=-1, repr=False)
    _source_timestamps: dict[int, float] = field(default_factory=dict, init=False, repr=False)

    def __post_init__(self) -> None:
        cleaned = [str(item).strip() for item in self.classes if str(item).strip()]
        if not cleaned and not self.examples:
            raise ValueError(f"识别器「{self.label}」：YOLO 至少需要一个示例框（或类别名）")
        if len(cleaned) > YOLO_MAX_CLASSES:
            raise ValueError(f"识别器「{self.label}」：类别太多（{len(cleaned)} > {YOLO_MAX_CLASSES}）")
        if not 0.0 < float(self.threshold) <= 1.0:
            raise ValueError(f"识别器「{self.label}」：YOLO 阈值必须在 (0, 1] 内")
        if self.imgsz not in YOLO_VALID_IMGSZ:
            raise ValueError(f"识别器「{self.label}」：YOLO imgsz 只能是 {' / '.join(map(str, YOLO_VALID_IMGSZ))}")
        self.classes = cleaned
        self.search = normalize_search(self.search)
        self.max_age_frames = max(1, int(self.max_age_frames))

    def detect(self, frame: Frame, *, search: str | None = None) -> list[Detection]:
        if not self.enabled:
            return []
        manager = self.manager if self.manager is not None else YOLO_MANAGER
        mode = normalize_search(self.search if search is None else search)
        region = Rect(0, 0, 1, 1) if mode == "full" else (self.roi or Rect(0, 0, 1, 1)).clamp()
        # YOLO 的视觉提示向量是按“整张参考帧 + 原始示例框”生成的；不能把当前帧
        # 先裁成 ROI 再推理，否则输入坐标系变了，参考框仍是整帧坐标，结果会漂移。
        # 统一整帧推理，最后按目标中心过滤 ROI，既保持坐标系一致也避免框闪跳。
        image = frame.image
        if image.size == 0:
            return []

        # 必须在 submit 前记源时间（fake/极快 worker 可能同步回结果）。同 index
        # 重复消费不得刷新时间或移动到队尾，以免旧图获得新的有效期。
        self._source_timestamps.setdefault(frame.index, frame.ts)
        while len(self._source_timestamps) > ASYNC_SOURCE_HISTORY_LIMIT:
            del self._source_timestamps[next(iter(self._source_timestamps))]
        submitted = manager.submit(
            image,
            list(self.classes),
            [dict(item) for item in self.examples],
            conf=float(self.threshold),
            iou=0.45,
            imgsz=int(self.imgsz),
            tile=bool(self.tile),
            tile_size=int(self.tile_size),
            tile_overlap=float(self.tile_overlap),
            frame_index=frame.index,
        )
        if submitted is None:
            return []
        dets, result_frame = submitted
        if int(result_frame) <= self.enabled_after_frame:
            return []
        if not _async_result_is_fresh(
            frame, int(result_frame), self._source_timestamps.get(int(result_frame)), self.max_age_frames
        ):
            return []

        hits: list[Detection] = []
        for det in dets:
            cls = str(det.get("class") or "")
            allowed = set(self.classes) | {str(item.get("label") or self.label) for item in self.examples}
            if cls not in allowed:
                continue
            try:
                x1, y1, x2, y2 = (float(v) for v in det["bbox"])
            except (KeyError, TypeError, ValueError):
                continue
            rect = Rect.from_pixels(
                x1,
                y1,
                max(1.0, x2 - x1),
                max(1.0, y2 - y1),
                frame.image_size,
            ).clamp()
            if mode == "region" and self.roi is not None:
                roi = self.roi.clamp()
                if not (roi.x <= rect.cx <= roi.x + roi.w and roi.y <= rect.cy <= roi.y + roi.h):
                    continue
            hits.append(
                Detection(
                    label=self.label,
                    rect=rect,
                    score=float(det.get("conf") or 0.0),
                    source="yolo",
                )
            )
        return hits


def _yolo_classes(raw: object) -> list[str]:
    """`["monster", "HP bar"]` 或 `"monster, HP bar"` 都接受（界面上两种都会出现）。"""
    if isinstance(raw, str):
        return [item.strip() for item in raw.replace("，", ",").split(",") if item.strip()]
    if isinstance(raw, (list, tuple)):
        return [str(item).strip() for item in raw if str(item).strip()]
    return []


def build_recognizer(
    label: str,
    spec: dict[str, Any],
    base_dir: str,
    *,
    default_threshold: float = 0.82,
) -> Recognizer:
    """按 DSL 片段构造识别器（types: template / color / ocr / yolo）。"""
    enabled = spec.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ValueError(f"识别器「{label}」：enabled 必须是布尔值")
    kind = str(spec.get("type", "template")).lower()
    roi = Rect.parse(spec["roi"]) if spec.get("roi") else None
    if kind == "template":
        path = str(spec["template"])
        if not os.path.isabs(path):
            path = os.path.join(base_dir, path)
        scales = tuple(float(item) for item in spec["scales"]) if spec.get("scales") else None
        return TemplateRecognizer(
            label=label,
            enabled=enabled,
            path=path,
            threshold=float(spec.get("threshold", default_threshold)),
            roi=roi,
            scales=scales,
            recorded_size=_parse_size(spec.get("recorded_size")),
            search=normalize_search(spec.get("search")),
        )
    if kind == "ocr":
        return OcrRecognizer(
            label=label,
            enabled=enabled,
            text=str(spec.get("text") or ""),
            mode=str(spec.get("mode") or "contains").strip().lower(),
            threshold=float(spec.get("threshold", 0.6)),
            roi=roi,
            search=normalize_search(spec.get("search")),
        )
    if kind == "color":
        return ColorRecognizer(
            label=label,
            enabled=enabled,
            target_bgr=[int(item) for item in spec.get("target_bgr", [0, 0, 0])],
            tolerance=int(spec.get("tolerance", 30)),
            min_pixels=int(spec.get("min_pixels", 60)),
            roi=roi,
        )
    if kind == "yolo":
        examples: list[dict[str, Any]] = []
        for item in spec.get("examples") or []:
            if not isinstance(item, dict):
                continue
            template = item.get("template")
            if not isinstance(template, str) or not template:
                continue
            path = template if os.path.isabs(template) else os.path.join(base_dir, template)
            rect = item.get("rect")
            if not isinstance(rect, (list, tuple)) or len(rect) != 4:
                continue
            examples.append(
                {
                    "path": path,
                    "rect": [float(v) for v in rect],
                    "label": str(item.get("label") or label),
                }
            )
        return YoloRecognizer(
            label=label,
            enabled=enabled,
            classes=_yolo_classes(spec.get("classes")),
            examples=examples,
            threshold=float(spec.get("threshold", YOLO_DEFAULT_THRESHOLD)),
            roi=roi,
            search=normalize_search(spec.get("search")),
            imgsz=int(spec.get("imgsz", YOLO_DEFAULT_IMGSZ)),
            tile=bool(spec.get("tile", False)),
            tile_size=int(spec.get("tile_size", YOLO_DEFAULT_IMGSZ)),
            tile_overlap=float(spec.get("tile_overlap", 0.2)),
            max_age_frames=int(spec.get("max_age_frames", DEFAULT_MAX_AGE_FRAMES)),
        )
    raise ValueError(f"未知识别器类型: {kind!r}（当前支持 template / color / ocr / yolo）")


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


def perceive(
    graph_recognizers: dict[str, Recognizer],
    frame: Frame,
    vote: VoteFilter,
    search_overrides: dict[str, str] | None = None,
) -> dict[str, Detection]:
    """跑一遍所有识别器，返回 {label: Detection}，并把投票状态写进 Detection.state。

    `search_overrides` 是**按这一拍执行的步骤**给出的搜索范围（label → region/full）：
    同一个模板在 A 步可以区域搜、B 步可以全屏搜。没给的标签一律按 `region`
    （只认录制框选区域）——搜索范围只在步骤上配，模板不再存自己的默认值。
    """
    overrides = search_overrides or {}
    raw: list[Detection] = []
    origins: dict[str, Recognizer] = {}
    for label, recognizer in list(graph_recognizers.items()):
        if not getattr(recognizer, "enabled", True):
            vote.update(label, False)
            continue
        try:
            if isinstance(recognizer, (TemplateRecognizer, YoloRecognizer)):
                detections = recognizer.detect(frame, search=overrides.get(label) or "region")
            else:
                # 颜色 / OCR 本来就只在 roi 里工作，没有整帧模式
                detections = recognizer.detect(frame)
            if graph_recognizers.get(label) is recognizer and getattr(recognizer, "enabled", True):
                raw.extend(detections)
                origins[label] = recognizer
        except Exception:  # 单个识别器坏掉不该拖垮整帧
            continue
    raw = [
        detection
        for detection in raw
        if graph_recognizers.get(detection.label) is origins.get(detection.label)
        and getattr(graph_recognizers.get(detection.label), "enabled", True)
    ]
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
