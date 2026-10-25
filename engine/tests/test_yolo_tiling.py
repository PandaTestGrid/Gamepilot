"""分块检测的纯函数：瓦片切分 + 按类 NMS（不依赖 torch）。"""

from __future__ import annotations

import pytest

from gamepilot.core.yolo_infer import MAX_TILES, nms_per_class, tile_grid


def test_tile_grid_covers_edges() -> None:
    tiles = tile_grid(1920, 1080, 640, 0.2)
    assert tiles
    assert all(x >= 0 and y >= 0 for x, y, _, _ in tiles)
    assert all(x + w <= 1920 and y + h <= 1080 for x, y, w, h in tiles)
    # 右下角必须被某块覆盖（否则边缘目标永远漏）
    assert any(x + w == 1920 for x, _, w, _ in tiles)
    assert any(y + h == 1080 for _, y, _, h in tiles)


def test_tile_grid_small_image_is_single_tile() -> None:
    assert tile_grid(400, 300, 640, 0.2) == [(0, 0, 400, 300)]


def test_tile_grid_overlap_produces_more_tiles() -> None:
    low = tile_grid(1920, 1080, 640, 0.0)
    high = tile_grid(1920, 1080, 640, 0.4)
    assert len(high) >= len(low)


def test_nms_per_class_keeps_best_of_overlapping() -> None:
    dets = [
        {"class": "bus", "conf": 0.9, "bbox": [0, 0, 100, 100]},
        {"class": "bus", "conf": 0.8, "bbox": [5, 5, 105, 105]},
        {"class": "person", "conf": 0.7, "bbox": [0, 0, 100, 100]},
    ]
    kept = nms_per_class(dets, 0.5)
    assert [item["class"] for item in kept] == ["bus", "person"]
    assert kept[0]["conf"] == 0.9


def test_constant_matches_tiling_cap() -> None:
    assert MAX_TILES >= 16


@pytest.mark.parametrize("size", [640, 1280])
def test_tile_size_is_clamped_to_image(size: int) -> None:
    tiles = tile_grid(300, 200, size, 0.2)
    assert tiles == [(0, 0, 300, 200)]
