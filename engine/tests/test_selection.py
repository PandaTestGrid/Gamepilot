"""同一识别器命中多个目标时的选择策略。

背景：整帧搜索一排相同的剑/金币图标时，老逻辑只留最高分，同分就拒绝点击。
这里钉住每种策略选的是哪一个，以及默认 `auto` 仍然拒绝猜。
"""

from __future__ import annotations

import random

import pytest

from gamepilot.core.frame import Detection, best_per_label, reading_order
from gamepilot.core.geometry import Rect
from gamepilot.core.selection import (
    SELECTION_STRATEGIES,
    normalize_index,
    normalize_strategy,
    select_rects,
    selection_summary,
)

# 3x2 网格：行内从左到右，三行
GRID = [
    Rect(0.10, 0.20, 0.05, 0.05),
    Rect(0.30, 0.21, 0.05, 0.05),
    Rect(0.50, 0.19, 0.05, 0.05),
    Rect(0.12, 0.50, 0.05, 0.05),
    Rect(0.32, 0.51, 0.05, 0.05),
    Rect(0.52, 0.49, 0.05, 0.05),
]


def _detection(rects: list[Rect] | None = None, score: float = 0.9, ambiguous: bool = False) -> Detection:
    items = rects or GRID
    return Detection("剑", items[0], score=score, state="confirmed", ambiguous=ambiguous, candidates=list(items))


def test_reading_order_is_top_to_bottom_then_left_to_right() -> None:
    shuffled = [GRID[5], GRID[1], GRID[3], GRID[0], GRID[4], GRID[2]]
    assert reading_order(shuffled) == GRID


def test_best_per_label_collects_distinct_candidates() -> None:
    raw = [Detection("剑", rect, score=0.9) for rect in GRID]
    # 同一位置的多尺度命中只能算一个候选
    raw.append(Detection("剑", Rect(0.101, 0.201, 0.05, 0.05), score=0.88))
    best = best_per_label(raw)
    assert set(best) == {"剑"}
    assert best["剑"].candidates == GRID
    assert best["剑"].ambiguous is False  # 歧义标记由识别器给，best_per_label 不猜


def test_candidates_are_not_sent_for_single_hit() -> None:
    single = Detection("btn", GRID[0])
    assert "candidates" not in single.to_dict()
    many = _detection()
    assert len(many.to_dict()["candidates"]) == 6


def test_auto_keeps_old_behaviour_of_highest_score() -> None:
    """没有同分歧义时 auto 仍点最高分：老脚本不因为多命中而突然失败。"""
    assert select_rects(_detection(), "auto") == [GRID[0]]


def test_auto_refuses_to_guess_when_scores_tie() -> None:
    with pytest.raises(ValueError, match="6 个同分候选"):
        select_rects(_detection(ambiguous=True), "auto")


def test_auto_uses_the_only_target() -> None:
    assert select_rects(Detection("btn", GRID[0]), "auto") == [GRID[0]]


def test_nearest_uses_recording_anchor() -> None:
    # 锚点在第三行右侧附近 → 最近的是 (0.52, 0.49)
    picked = select_rects(_detection(), "nearest", anchor=(0.55, 0.50))
    assert picked == [GRID[5]]


def test_first_last_and_nth_follow_reading_order() -> None:
    assert select_rects(_detection(), "first") == [GRID[0]]
    assert select_rects(_detection(), "last") == [GRID[5]]
    assert select_rects(_detection(), "nth", index=4) == [GRID[3]]
    assert select_rects(_detection(), "nth", index="2") == [GRID[1]]


def test_nth_out_of_range_fails_instead_of_clamping() -> None:
    with pytest.raises(ValueError, match="只有 6 个候选"):
        select_rects(_detection(), "nth", index=9)


def test_extremes_pick_by_screen_coordinates() -> None:
    assert select_rects(_detection(), "leftmost") == [GRID[0]]
    assert select_rects(_detection(), "rightmost") == [GRID[5]]
    assert select_rects(_detection(), "topmost") == [GRID[2]]
    assert select_rects(_detection(), "bottommost") == [GRID[4]]


def test_all_returns_every_candidate_in_reading_order() -> None:
    assert select_rects(_detection(), "all") == GRID


def test_random_is_seeded_and_within_candidates() -> None:
    rng = random.Random(7)
    picked = select_rects(_detection(), "random", rng=rng)
    assert len(picked) == 1
    assert picked[0] in GRID


def test_strategy_names_are_stable_for_the_ui() -> None:
    assert SELECTION_STRATEGIES[0] == "auto"
    assert set(SELECTION_STRATEGIES) == {
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
    }
    assert selection_summary("nth", 3) == "第 3 个"


def test_invalid_strategy_raises() -> None:
    with pytest.raises(ValueError, match="未知识别器多目标策略"):
        normalize_strategy("closest")


def test_index_falls_back_and_clamps_to_one() -> None:
    assert normalize_index(None) == 1
    assert normalize_index("0") == 1
    with pytest.raises(ValueError, match="必须是整数"):
        normalize_index("abc")


def test_legacy_ambiguous_without_candidates_still_refuses() -> None:
    legacy = Detection("开始", Rect(0.2, 0.2, 0.1, 0.1), score=0.9, state="confirmed", ambiguous=True)
    with pytest.raises(ValueError, match="多个同分候选"):
        select_rects(legacy, "auto")
    # 但显式策略仍然可以点：老脚本升级后不必重新录
    assert select_rects(legacy, "first") == [legacy.rect]
