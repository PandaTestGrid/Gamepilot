"""YOLO 识别器（不依赖 torch）：spec 解析、坐标归一化、结果新鲜度、不可用降级。"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from gamepilot.core import recognizer as recognizer_module
from gamepilot.core.frame import Frame
from gamepilot.core.geometry import Rect
from gamepilot.core.recognizer import YoloRecognizer, build_recognizer


class FakeManager:
    """替身：记录调用参数，返回预置结果，用来把识别器逻辑和真模型解耦。"""

    def __init__(self, dets: list[dict[str, Any]] | None = None, frame_index: int = 0) -> None:
        self.dets = dets or []
        self.result_frame = frame_index
        self.calls: list[dict[str, Any]] = []

    def submit(
        self,
        image: np.ndarray,
        classes: list[str],
        examples: list[dict[str, Any]],
        **kwargs: object,
    ) -> tuple[list[dict[str, Any]], int]:
        self.calls.append({"image": image, "classes": list(classes), "examples": examples, **kwargs})
        return self.dets, self.result_frame


class UnavailableManager:
    def submit(
        self,
        image: np.ndarray,
        classes: list[str],
        examples: list[dict[str, Any]],
        **kwargs: object,
    ) -> None:
        return None


def make_frame(width: int = 100, height: int = 200, index: int = 0) -> Frame:
    return Frame(image=np.zeros((height, width, 3), dtype=np.uint8), size=(width, height), index=index)


def test_roi_offset_is_applied() -> None:
    # 推理保持整帧坐标；目标中心落在 ROI 内时才保留。
    manager = FakeManager(dets=[{"class": "monster", "conf": 0.9, "bbox": [60, 120, 80, 140]}])
    recognizer = YoloRecognizer(
        label="m",
        classes=["monster"],
        roi=Rect(0.5, 0.5, 0.5, 0.5),
        manager=manager,
    )

    hits = recognizer.detect(make_frame())

    assert len(hits) == 1
    rect = hits[0].rect
    assert rect.x == pytest.approx(0.6)
    assert rect.y == pytest.approx(0.6)
    assert rect.w == pytest.approx(0.2)
    assert rect.h == pytest.approx(0.1)
    assert hits[0].source == "yolo"
    assert hits[0].label == "m"


def test_other_classes_are_filtered_out() -> None:
    manager = FakeManager(
        dets=[
            {"class": "monster", "conf": 0.9, "bbox": [0, 0, 10, 10]},
            {"class": "bus", "conf": 0.8, "bbox": [0, 0, 10, 10]},
        ]
    )
    recognizer = YoloRecognizer(label="m", classes=["monster"], manager=manager)

    hits = recognizer.detect(make_frame())

    assert [hit.label for hit in hits] == ["m"]


def test_stale_result_is_dropped() -> None:
    manager = FakeManager(dets=[{"class": "monster", "conf": 0.9, "bbox": [0, 0, 10, 10]}], frame_index=5)
    recognizer = YoloRecognizer(label="m", classes=["monster"], max_age_frames=4, manager=manager)

    # 恰好 4 帧旧（9-5）仍可用
    assert len(recognizer.detect(make_frame(index=9))) == 1
    # 5 帧旧就丢掉，避免拿过期位置去点击
    assert recognizer.detect(make_frame(index=10)) == []


def test_runtime_ttl_keeps_200ms_result_across_capture_frame_gap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = [1000.0]
    monkeypatch.setattr(recognizer_module.time, "time", lambda: now[0])
    manager = FakeManager(dets=[{"class": "monster", "conf": 0.9, "bbox": [0, 0, 10, 10]}], frame_index=1)
    recognizer = YoloRecognizer(label="m", classes=["monster"], manager=manager)
    source = make_frame(index=1)
    source.ts = 1000.0
    source.async_max_age_seconds = 0.5
    assert recognizer.detect(source)
    now[0] = 1000.2
    current = make_frame(index=100)
    current.ts = now[0]
    current.async_max_age_seconds = 0.5
    assert recognizer.detect(current), "源图仅200ms旧，不受99帧capture跳号影响"
    now[0] = 1000.5
    assert recognizer.detect(current)
    now[0] = 1000.501
    assert recognizer.detect(current) == [], "缓存结果不能按完成/消费时刻续期"


def test_runtime_ttl_unknown_source_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(recognizer_module.time, "time", lambda: 1000.0)
    manager = FakeManager(dets=[{"class": "monster", "conf": 0.9, "bbox": [0, 0, 10, 10]}], frame_index=5)
    recognizer = YoloRecognizer(label="m", classes=["monster"], manager=manager)
    frame = make_frame(index=6)
    frame.ts = 1000.0
    frame.async_max_age_seconds = 0.5
    assert recognizer.detect(frame) == [], "未知源不能用当前Frame.ts为旧结果赋新时间"


def test_runtime_source_history_is_bounded_and_does_not_refresh_same_index(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = [1000.0]
    monkeypatch.setattr(recognizer_module.time, "time", lambda: now[0])
    manager = FakeManager(dets=[{"class": "monster", "conf": 0.9, "bbox": [0, 0, 10, 10]}], frame_index=0)
    recognizer = YoloRecognizer(label="m", classes=["monster"], manager=manager)
    frame = make_frame(index=0)
    frame.ts = 1000.0
    frame.async_max_age_seconds = 0.5
    assert recognizer.detect(frame)
    now[0] = 1001.0
    frame.ts = 1001.0
    assert recognizer.detect(frame) == [], "同source index的时间不可刷新"
    for index in range(1, recognizer_module.ASYNC_SOURCE_HISTORY_LIMIT + 1):
        frame = make_frame(index=index)
        frame.ts = 1001.0
        frame.async_max_age_seconds = 0.5
        recognizer.detect(frame)
    assert len(recognizer._source_timestamps) == recognizer_module.ASYNC_SOURCE_HISTORY_LIMIT
    assert 0 not in recognizer._source_timestamps
    # 即便时钟回到原图TTL内，已淘汰源也不可重新推算时间。
    now[0] = 1000.1
    assert recognizer.detect(frame) == []


@pytest.mark.parametrize("ttl", [-1.0, float("inf"), float("nan")])
def test_runtime_ttl_must_be_finite_and_nonnegative(monkeypatch: pytest.MonkeyPatch, ttl: float) -> None:
    monkeypatch.setattr(recognizer_module.time, "time", lambda: 1000.0)
    manager = FakeManager(dets=[{"class": "monster", "conf": 0.9, "bbox": [0, 0, 10, 10]}])
    recognizer = YoloRecognizer(label="m", classes=["monster"], manager=manager)
    frame = make_frame()
    frame.ts = 1000.0
    frame.async_max_age_seconds = ttl
    assert recognizer.detect(frame) == []


def test_full_search_ignores_roi_and_maps_whole_frame() -> None:
    manager = FakeManager(dets=[{"class": "monster", "conf": 0.9, "bbox": [70, 10, 90, 30]}])
    recognizer = YoloRecognizer(
        label="m",
        classes=["monster"],
        roi=Rect(0.0, 0.0, 0.5, 0.5),
        search="full",
        manager=manager,
    )

    hits = recognizer.detect(make_frame())
    call = manager.calls[0]

    assert call["image"].shape == (200, 100, 3)  # 整帧，不是 roi 裁剪
    assert hits[0].rect.x == pytest.approx(0.7)
    assert hits[0].rect.y == pytest.approx(0.05)


def test_manager_unavailable_returns_empty() -> None:
    recognizer = YoloRecognizer(label="m", classes=["monster"], manager=UnavailableManager())
    assert recognizer.detect(make_frame()) == []


def test_threshold_and_imgsz_are_passed_to_manager() -> None:
    manager = FakeManager()
    recognizer = YoloRecognizer(
        label="m",
        classes=["monster"],
        threshold=0.42,
        imgsz=960,
        manager=manager,
    )
    recognizer.detect(make_frame())

    call = manager.calls[0]
    assert call["conf"] == pytest.approx(0.42)
    assert call["imgsz"] == 960


def test_build_recognizer_accepts_list_and_csv() -> None:
    from_list = build_recognizer("m", {"type": "yolo", "classes": ["monster", "HP bar"]}, ".")
    assert isinstance(from_list, YoloRecognizer)
    assert list(from_list.classes) == ["monster", "HP bar"]

    from_csv = build_recognizer("m", {"type": "yolo", "classes": "monster, HP bar"}, ".")
    assert isinstance(from_csv, YoloRecognizer)
    assert list(from_csv.classes) == ["monster", "HP bar"]


def test_build_recognizer_rejects_bad_specs() -> None:
    with pytest.raises(ValueError):
        build_recognizer("m", {"type": "yolo", "classes": []}, ".")
    with pytest.raises(ValueError):
        build_recognizer("m", {"type": "yolo", "classes": ["monster"], "imgsz": 123}, ".")
    with pytest.raises(ValueError):
        build_recognizer("m", {"type": "yolo", "classes": ["monster"], "search": "sideways"}, ".")


def test_build_recognizer_parses_examples() -> None:
    built = build_recognizer(
        "monster",
        {
            "type": "yolo",
            "examples": [
                {"template": "templates/monster_ai0.png", "rect": [0.1, 0.2, 0.3, 0.4]},
            ],
        },
        "/workflow",
    )
    assert isinstance(built, YoloRecognizer)
    assert len(built.examples) == 1
    example = built.examples[0]
    assert example["path"].endswith("monster_ai0.png")
    assert example["rect"] == [0.1, 0.2, 0.3, 0.4]
    assert example["label"] == "monster"


def test_recognizer_without_examples_or_classes_is_rejected() -> None:
    with pytest.raises(ValueError):
        YoloRecognizer(label="m", classes=[], examples=[])


def test_example_labels_are_accepted() -> None:
    manager = FakeManager(
        dets=[
            {"class": "monster", "conf": 0.9, "bbox": [0, 0, 10, 10]},
            {"class": "bus", "conf": 0.8, "bbox": [0, 0, 10, 10]},
        ]
    )
    recognizer = YoloRecognizer(
        label="m",
        examples=[{"path": "x.png", "rect": [0, 0, 1, 1], "label": "monster"}],
        manager=manager,
    )

    hits = recognizer.detect(make_frame())

    assert len(hits) == 1
    call = manager.calls[0]
    assert call["examples"][0]["label"] == "monster"


def test_build_recognizer_parses_tile_options() -> None:
    built = build_recognizer(
        "m",
        {
            "type": "yolo",
            "examples": [{"template": "templates/m_ai0.png", "rect": [0.1, 0.1, 0.2, 0.2]}],
            "tile": True,
            "tile_size": 960,
            "tile_overlap": 0.3,
            "imgsz": 1280,
        },
        "/workflow",
    )
    assert isinstance(built, YoloRecognizer)
    assert built.tile is True
    assert built.tile_size == 960
    assert built.tile_overlap == 0.3
    assert built.imgsz == 1280
