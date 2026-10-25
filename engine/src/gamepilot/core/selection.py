"""同一识别器在一帧里命中多个目标时，点哪一个。

模板匹配（尤其是「全屏」搜索）经常一次找到一排相同的图标：剑、金币、列表项。
老行为是「只留最高分，同分就拒绝点击」；现在把选择权交给步骤：

| 策略 | 语义 |
|---|---|
| `auto`（默认） | 只有一个目标就点；多个就报错，不猜 |
| `nearest` | 离录制区域中心最近的 |
| `first` / `last` | 按「从上到下、从左到右」的第一个 / 最后一个 |
| `nth` | 第 N 个（1 开始，同样按阅读顺序） |
| `leftmost` / `rightmost` / `topmost` / `bottommost` | 按屏幕坐标取极值 |
| `random` | 候选里随机一个 |
| `all` | 依次点击这一帧的全部候选（点完会消失/重排的界面请改用循环 + `nearest`） |

阅读顺序在 `frame.reading_order()`：同一行允许一点上下抖动，行内从左到右。
"""

from __future__ import annotations

import random

from .frame import Detection
from .geometry import Rect

SELECTION_STRATEGIES = (
    "auto",
    "nearest",
    "first",
    "last",
    "nth",
    "leftmost",
    "rightmost",
    "topmost",
    "bottommost",
    "random",
    "all",
)

#: 界面下拉用的中文名（前端 `flow-click-params.ts` 保持同口径）
SELECTION_LABELS = {
    "auto": "自动（多个就报错）",
    "nearest": "离录制位置最近",
    "first": "第一个（左上起）",
    "last": "最后一个",
    "nth": "第 N 个",
    "leftmost": "最左",
    "rightmost": "最右",
    "topmost": "最上",
    "bottommost": "最下",
    "random": "随机一个",
    "all": "全部依次点击",
}


def normalize_strategy(value: object) -> str:
    """非法值明确报错，不静默退回 auto（静默降级会让用户以为策略生效了）。"""
    strategy = str(value or "auto").strip().lower()
    if strategy not in SELECTION_STRATEGIES:
        raise ValueError(f"未知识别器多目标策略: {strategy!r}（支持 {' / '.join(SELECTION_STRATEGIES)}）")
    return strategy


def normalize_index(value: object, fallback: int = 1) -> int:
    if value is None or value == "":
        return fallback
    try:
        index = int(str(value).strip())
    except (TypeError, ValueError) as error:
        raise ValueError(f"第 N 个的 N 必须是整数，收到: {value!r}") from error
    return max(1, index)


def _distance(rect: Rect, anchor: tuple[float, float]) -> float:
    return (rect.cx - anchor[0]) ** 2 + (rect.cy - anchor[1]) ** 2


def select_rects(
    detection: Detection,
    strategy: object = "auto",
    *,
    anchor: tuple[float, float] | None = None,
    index: object = 1,
    rng: random.Random | None = None,
) -> list[Rect]:
    """按策略从这一帧的命中里选出要点的矩形（`all` 可能返回多个）。

    只有一个命中时任何策略都直接用它 —— 单目标场景不会因为策略配置而变慢或变脆。
    """
    rects = detection.all_rects()
    mode = normalize_strategy(strategy)
    if mode == "auto":
        # 保持老语义：同分歧义才拒绝；分数分得开就点最高分（不改变已有脚本的行为）
        if detection.ambiguous:
            count = len(rects)
            what = f"有 {count} 个同分候选" if count > 1 else "有多个同分候选"
            raise ValueError(
                f"目标 {detection.label} {what}，无法确定点哪一个"
                "（把这一步的「多目标」改成 最近 / 第 N 个 / 全部，或把搜索范围改回原区域）"
            )
        return [detection.rect]
    if len(rects) <= 1:
        return rects
    if mode == "all":
        return list(rects)
    if mode == "first":
        return [rects[0]]
    if mode == "last":
        return [rects[-1]]
    if mode == "nth":
        position = normalize_index(index)
        if position > len(rects):
            raise ValueError(f"目标 {detection.label} 只有 {len(rects)} 个候选，取不到第 {position} 个")
        return [rects[position - 1]]
    if mode == "leftmost":
        return [min(rects, key=lambda item: (item.cx, item.cy))]
    if mode == "rightmost":
        return [max(rects, key=lambda item: (item.cx, -item.cy))]
    if mode == "topmost":
        return [min(rects, key=lambda item: (item.cy, item.cx))]
    if mode == "bottommost":
        return [max(rects, key=lambda item: (item.cy, -item.cx))]
    if mode == "random":
        return [(rng or random).choice(rects)]
    # nearest：没有锚点就退回阅读顺序第一个，不让"最近"变成随机
    origin = anchor if anchor is not None else (0.5, 0.5)
    return [min(rects, key=lambda item: (_distance(item, origin), item.cy, item.cx))]


def selection_summary(strategy: object, index: object = 1) -> str:
    mode = normalize_strategy(strategy)
    if mode == "nth":
        return f"第 {normalize_index(index)} 个"
    return SELECTION_LABELS[mode]
