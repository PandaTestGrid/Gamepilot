"""分辨率自适应：同一张模板在**换了分辨率**的画面里也要认得出。

背景：模板是从某一帧里裁下来的 PNG，录制时的像素尺寸和运行时的帧尺寸不一定一样 ——
同一台设备改了投屏尺寸（scrcpy `max_size`）、换台机器、或重连后引擎换了编码尺寸，
都会让模板"大小对不上"，而 `TM_CCOEFF_NORMED` 对缩放非常敏感（差 20% 基本就 0 分）。

钉住四件事：
1. spec 里没有 `recorded_size`（老工作流）→ 行为完全不变，还是单尺度 1.0；
2. 有 `recorded_size` 且帧尺寸一致 → 也只用 1.0（不做无意义的 3 倍开销）；
3. 帧尺寸变了 → 按比例缩放，并在比例附近 ±6% 容错；
4. spec 里显式写了 `scales` → 以它为准（手调优先）。
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from gamepilot.core.frame import Frame
from gamepilot.core.geometry import Rect
from gamepilot.core.recognizer import TemplateRecognizer, build_recognizer

W, H = 1280, 720
TARGET = (400, 200, 160, 80)


def _canvas(width: int, height: int) -> np.ndarray:
    return np.full((height, width, 3), 24, dtype=np.uint8)


def _stripe(image: np.ndarray, box: tuple[int, int, int, int], cell: int = 8) -> None:
    """带纹理的目标：纯色模板的 NCC 是退化的，必须要有非恒定像素。"""
    x, y, w, h = box
    yy, xx = np.mgrid[0:h, 0:w]
    mask = ((xx // cell + yy // cell) % 2 == 0)[:, :, None]
    image[y : y + h, x : x + w] = np.where(mask, np.array([230] * 3, np.uint8), np.array([70] * 3, np.uint8))


def _template_png(tmp_path: Path) -> str:
    scene = _canvas(W, H)
    _stripe(scene, TARGET)
    x, y, w, h = TARGET
    path = tmp_path / "target.png"
    cv2.imwrite(str(path), scene[y : y + h, x : x + w])
    return str(path)


def _frame_at(scale: float) -> Frame:
    """按 `scale` 缩放后的整帧（目标位置同比缩放，模拟"换了个分辨率"）。"""
    width, height = round(W * scale), round(H * scale)
    image = _canvas(width, height)
    x, y, w, h = TARGET
    box = (round(x * scale), round(y * scale), round(w * scale), round(h * scale))
    _stripe(image, box, cell=max(4, round(8 * scale)))
    return Frame(image=image, size=(width, height), index=1)


def _recognizer(tmp_path: Path, **spec: object) -> TemplateRecognizer:
    built = build_recognizer("目标", {"type": "template", "template": _template_png(tmp_path), **spec}, str(tmp_path))
    assert isinstance(built, TemplateRecognizer)
    return built


def test_old_workflow_without_recorded_size_keeps_single_scale(tmp_path: Path) -> None:
    recognizer = _recognizer(tmp_path)
    assert recognizer._scales_for(_frame_at(1.0)) == (1.0,)
    assert recognizer.detect(_frame_at(1.0)), "原分辨率必须能认出来"


def test_same_size_does_not_pay_for_extra_scales(tmp_path: Path) -> None:
    recognizer = _recognizer(tmp_path, recorded_size=[W, H])
    assert recognizer._scales_for(_frame_at(1.0)) == (1.0,)


def test_scales_follow_the_frame_ratio(tmp_path: Path) -> None:
    recognizer = _recognizer(tmp_path, recorded_size=[W, H])
    scales = recognizer._scales_for(_frame_at(0.75))
    assert min(scales) < 0.75 < max(scales), f"比例附近要有容错: {scales}"
    assert any(abs(item - 0.75) < 1e-6 for item in scales), "主尺度应当就是帧/录制比例"


def test_smaller_frame_still_matches(tmp_path: Path) -> None:
    recognizer = _recognizer(tmp_path, recorded_size=[W, H])
    hits = recognizer.detect(_frame_at(0.75))

    assert hits, "降到 75% 分辨率后模板应该仍然命中"
    assert hits[0].score > 0.8, f"按比例缩放后分数不该垮掉: {hits[0].score}"
    # 目标在 0.75 帧里的位置：(400,200,160,80) × 0.75 / (960,540)
    expected = Rect(300 / 960, 150 / 540, 120 / 960, 60 / 540)
    assert hits[0].rect.x == pytest.approx(expected.x, abs=0.02)
    assert hits[0].rect.y == pytest.approx(expected.y, abs=0.02)
    assert hits[0].rect.w == pytest.approx(expected.w, abs=0.02)


def test_explicit_scales_win(tmp_path: Path) -> None:
    recognizer = _recognizer(tmp_path, recorded_size=[W, H], scales=[1.0, 1.25])
    assert recognizer._scales_for(_frame_at(0.5)) == (1.0, 1.25)


def test_garbage_recorded_size_is_ignored(tmp_path: Path) -> None:
    for value in ([0, 0], [-1, 720], ["a", "b"], [1, 2, 3], None):
        recognizer = _recognizer(tmp_path, recorded_size=value)
        assert recognizer._scales_for(_frame_at(0.75)) == (1.0,), f"{value!r} 应当被忽略"
