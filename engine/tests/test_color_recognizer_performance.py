"""Golden comparisons against the previous NumPy color detector, not timing gates."""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from gamepilot.core.frame import Detection, Frame
from gamepilot.core.geometry import Rect
from gamepilot.core.recognizer import ColorRecognizer


def _reference(recognizer: ColorRecognizer, frame: Frame) -> list[dict[str, Any]]:
    if not recognizer.enabled:
        return []
    region_rect = (recognizer.roi or Rect(0, 0, 1, 1)).clamp()
    region = frame.crop(region_rect)
    if not region.size:
        return []
    offset_x, offset_y, _, _ = region_rect.to_pixels(frame.image_size)
    target = np.array(recognizer.target_bgr[:3], dtype=np.int16)
    mask = (np.abs(region.astype(np.int16) - target).max(axis=2) <= recognizer.tolerance).astype(np.uint8)
    if int(mask.sum()) < recognizer.min_pixels:
        return []
    ys, xs = np.nonzero(mask)
    rect = Rect.from_pixels(
        offset_x + float(np.min(xs)),
        offset_y + float(np.min(ys)),
        float(np.max(xs) - np.min(xs) + 1),
        float(np.max(ys) - np.min(ys) + 1),
        frame.image_size,
    ).clamp()
    return [Detection(recognizer.label, rect, score=float(min(1.0, float(mask.mean()) * 4)), source="color").to_dict()]


@pytest.mark.parametrize("seed", range(54))
def test_optimized_color_detector_matches_numpy_golden(seed: int) -> None:
    rng = np.random.default_rng(seed)
    image = rng.integers(0, 256, (47, 61, 3), dtype=np.uint8)
    target = [int(value) for value in rng.integers(0, 256, 3)]
    image[9:19, 13:29] = target
    roi = [None, Rect(0.1, 0.1, 0.7, 0.8), Rect(-0.2, 0.2, 0.8, 1.1)][seed % 3]
    tolerance = [0, 1, 30, 127, 255, 300][seed % 6]
    recognizer = ColorRecognizer("target", target, tolerance=tolerance, min_pixels=[1, 60, 10000][seed % 3], roi=roi)
    frame = Frame(image, size=(122, 94))
    assert [hit.to_dict() for hit in recognizer.detect(frame)] == _reference(recognizer, frame)


@pytest.mark.parametrize(
    ("target", "tolerance", "min_pixels"),
    [
        ([-1, 0, 0], 1, 1),
        ([256, 255, 255], 1, 1),
        ([32767, 0, 0], 255, 1),
        ([0, 0, 0], -1, 1),
        ([0, 0, 0], -1, 0),
        ([127, 127, 127], 0, 0),
        ([0, 0, 0], 0.9, 1),
        ([0, 0, 0], 1.9, 1),
        ([255, 255, 255], 1000, 1),
    ],
)
def test_boundary_parameters_preserve_results_or_original_error(target: Any, tolerance: Any, min_pixels: int) -> None:
    image = np.array([[[0, 0, 0], [1, 1, 1]], [[255, 255, 255], [128, 128, 128]]], dtype=np.uint8)
    frame = Frame(image, size=(2, 2))
    recognizer = ColorRecognizer("target", target, tolerance=tolerance, min_pixels=min_pixels)
    try:
        expected = _reference(recognizer, frame)
    except (ValueError, OverflowError) as error:
        with pytest.raises(type(error)):
            recognizer.detect(frame)
    else:
        assert [hit.to_dict() for hit in recognizer.detect(frame)] == expected


def test_disabled_color_detector_keeps_empty_result() -> None:
    recognizer = ColorRecognizer("target", [0, 0, 0], enabled=False)
    assert recognizer.detect(Frame(np.zeros((16, 16, 3), dtype=np.uint8), size=(16, 16))) == []
