"""模板搜索范围（region / full）与整帧「粗搜 + 复核」。

钉住四件事：
1. 默认 `region` 只认 roi：目标换个位置就找不到（老行为，不能悄悄变）；
2. `search=full` 在目标换位置后仍能命中，且 Detection.rect 是**当前**位置（点击才准）；
3. 大画面走降采样粗搜时，精度仍由原分辨率复核决定（分数/位置不能降级）；
4. 两个一模一样的目标同分 → `ambiguous`，点击执行器拒绝猜。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pytest

from gamepilot.core.flow_engine import FlowEngine
from gamepilot.core.frame import Frame
from gamepilot.core.geometry import Rect
from gamepilot.core.graph import Graph
from gamepilot.core.recognizer import TemplateRecognizer, VoteFilter, _use_coarse, build_recognizer, perceive

W, H = 1280, 720
RECORDED = (900, 400, 120, 60)  # 录制时目标所在像素框
MOVED = (200, 100, 120, 60)  # 目标换了位置


def _canvas() -> np.ndarray:
    return np.full((H, W, 3), 26, dtype=np.uint8)


def _patterned(image: np.ndarray, box: tuple[int, int, int, int], cell: int = 6) -> None:
    """带纹理的目标：纯色模板的 NCC 是退化的，模板匹配需要非恒定像素。"""
    x, y, w, h = box
    yy, xx = np.mgrid[0:h, 0:w]
    mask = ((xx // cell + yy // cell) % 2 == 0)[:, :, None]
    image[y : y + h, x : x + w] = np.where(mask, np.array([235] * 3, np.uint8), np.array([60] * 3, np.uint8))


def _crop(image: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    x, y, w, h = box
    return image[y : y + h, x : x + w]


def _frame(image: np.ndarray) -> Frame:
    return Frame(image=image, size=(W, H), index=1)


def _rect_of(box: tuple[int, int, int, int]) -> Rect:
    x, y, w, h = box
    return Rect(x / W, y / H, w / W, h / H)


def _template(tmp_path: Path) -> str:
    scene = _canvas()
    _patterned(scene, RECORDED)
    path = tmp_path / "btn.png"
    cv2.imwrite(str(path), _crop(scene, RECORDED))
    return str(path)


def _recognizer(tmp_path: Path, *, search: str = "region", threshold: float = 0.9) -> TemplateRecognizer:
    return TemplateRecognizer(
        label="btn",
        path=_template(tmp_path),
        threshold=threshold,
        roi=_rect_of(RECORDED),
        search=search,
    )


def _scene_with(box: tuple[int, int, int, int]) -> np.ndarray:
    scene = _canvas()
    _patterned(scene, box)
    return scene


def test_region_search_misses_when_target_moves(tmp_path: Path) -> None:
    recognizer = _recognizer(tmp_path)
    assert recognizer.detect(_frame(_scene_with(MOVED))) == []


def test_full_search_finds_target_anywhere_and_returns_current_position(tmp_path: Path) -> None:
    recognizer = _recognizer(tmp_path, search="full")
    hits = recognizer.detect(_frame(_scene_with(MOVED)))

    assert hits, "全屏搜索应当找到换了位置的目标"
    x, y, w, h = hits[0].rect.to_pixels((W, H))
    expected_x, expected_y, expected_w, expected_h = MOVED
    assert abs((x + w / 2) - (expected_x + expected_w / 2)) <= 2, hits[0].rect
    assert abs((y + h / 2) - (expected_y + expected_h / 2)) <= 2, hits[0].rect
    assert hits[0].score >= 0.99
    assert hits[0].ambiguous is False


def test_perceive_override_uses_step_scope(tmp_path: Path) -> None:
    """搜索范围是步骤的能力：同一个模板默认 region，这一步可以覆盖成 full。"""
    recognizer = _recognizer(tmp_path)  # 模板默认 region
    frame = _frame(_scene_with(MOVED))
    vote = VoteFilter(window=1)

    assert perceive({"btn": recognizer}, frame, vote) == {}, "不覆盖时仍按模板默认 region 搜"

    hits = perceive({"btn": recognizer}, frame, vote, {"btn": "full"})
    assert "btn" in hits
    assert hits["btn"].state == "confirmed"
    x, y, _, _ = hits["btn"].rect.to_pixels((W, H))
    assert (x, y) == (MOVED[0], MOVED[1])


def test_perceive_ignores_legacy_recognizer_default(tmp_path: Path) -> None:
    """搜索范围只在步骤上配：模板上残留的 search=full 不再生效，默认就是原区域。

    老版本支持「录制时设模板默认」；这套配置界面上已经去掉，引擎也不能再偷偷整帧搜，
    否则用户在步骤里选「原区域」，实际却还在整帧找。
    """
    recognizer = _recognizer(tmp_path, search="full")
    frame = _frame(_scene_with(MOVED))
    vote = VoteFilter(window=1)

    assert perceive({"btn": recognizer}, frame, vote) == {}, "没有步骤覆盖时应按 region 找"
    assert "btn" in perceive({"btn": recognizer}, frame, vote, {"btn": "full"})


def test_coarse_search_keeps_full_resolution_accuracy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """1280x720 全屏会走 1/2 降采样粗搜；最终分数/位置必须仍是原分辨率的。"""
    assert _use_coarse((H, W), (60, 120)) is True

    calls: list[int] = []
    original = TemplateRecognizer._match_coarse

    def spy(self: TemplateRecognizer, *args: Any, **kwargs: Any) -> Any:
        calls.append(1)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(TemplateRecognizer, "_match_coarse", spy)
    recognizer = _recognizer(tmp_path, search="full", threshold=0.99)
    hits = recognizer.detect(_frame(_scene_with(MOVED)))

    assert calls, "大区域全屏搜索应当走粗搜"
    assert hits and hits[0].score >= 0.99
    x, y, _, _ = hits[0].rect.to_pixels((W, H))
    assert (x, y) == (MOVED[0], MOVED[1])


def test_two_identical_targets_are_marked_ambiguous(tmp_path: Path) -> None:
    scene = _scene_with(MOVED)
    _patterned(scene, (800, 500, 120, 60))
    recognizer = _recognizer(tmp_path, search="full")
    hits = recognizer.detect(_frame(scene))

    assert len(hits) >= 2
    assert hits[0].score - hits[1].score <= 0.02
    assert hits[0].ambiguous is True, "两个同分目标时必须标记歧义，点击不能猜"


def test_single_region_hit_is_not_ambiguous(tmp_path: Path) -> None:
    recognizer = _recognizer(tmp_path)
    hits = recognizer.detect(_frame(_scene_with(RECORDED)))

    assert hits
    assert hits[0].ambiguous is False


def test_build_recognizer_defaults_to_region_and_parses_full(tmp_path: Path) -> None:
    default = build_recognizer("btn", {"type": "template", "template": "btn.png"}, str(tmp_path))
    assert isinstance(default, TemplateRecognizer)
    assert default.search == "region"

    full = build_recognizer("btn", {"type": "template", "template": "btn.png", "search": "full"}, str(tmp_path))
    assert isinstance(full, TemplateRecognizer)
    assert full.search == "full"


def test_build_recognizer_rejects_unknown_search(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="搜索范围"):
        build_recognizer("btn", {"type": "template", "template": "btn.png", "search": "everywhere"}, str(tmp_path))


def test_graph_set_recognizer_search_writes_and_clears(tmp_path: Path) -> None:
    graph = Graph.empty(str(tmp_path))
    graph.add_recognizer("btn", {"type": "template", "template": "btn.png", "roi": [0.1, 0.1, 0.2, 0.2]})

    assert graph.set_recognizer_search("btn", "full") == {"label": "btn", "search": "full"}
    assert graph.specs["btn"]["search"] == "full"
    assert isinstance(graph.recognizers["btn"], TemplateRecognizer)
    assert graph.recognizers["btn"].search == "full"

    graph.set_recognizer_search("btn", "region")
    assert "search" not in graph.specs["btn"], "默认值不落盘，graph.json 保持干净"
    assert isinstance(graph.recognizers["btn"], TemplateRecognizer)
    assert graph.recognizers["btn"].search == "region"

    # 落盘再读回来：settings 不能丢
    graph.set_recognizer_search("btn", "full")
    reloaded = Graph.from_dict(graph.to_dict(), str(tmp_path))
    assert reloaded.specs["btn"]["search"] == "full"


def test_graph_set_recognizer_search_rejects_color_recognizer(tmp_path: Path) -> None:
    graph = Graph.empty(str(tmp_path))
    graph.add_recognizer("bar", {"type": "color", "target_bgr": [0, 0, 0], "roi": [0.1, 0.1, 0.2, 0.2]})
    with pytest.raises(ValueError, match="不是模板识别器"):
        graph.set_recognizer_search("bar", "full")


def test_flow_click_strategy_picks_from_full_search_candidates(tmp_path: Path) -> None:
    """端到端：整帧搜到一排同款图标 → 步骤策略选第 3 个 → 点到第 3 个的位置。"""
    boxes = [(100, 100, 60, 60), (400, 100, 60, 60), (700, 100, 60, 60)]
    scene = _canvas()
    for box in boxes:
        _patterned(scene, box)
    cv2.imwrite(str(tmp_path / "icon.png"), _crop(scene, boxes[0]))

    graph = Graph.from_dict(
        {
            "version": 1,
            "defaults": {"click_jitter_px": 0, "click_micro_px": 0, "vote": 1},
            "nodes": [],
            "edges": [],
            "recognizers": {
                "剑": {
                    "type": "template",
                    "template": "icon.png",
                    "threshold": 0.9,
                    "roi": list(_rect_of(boxes[0]).to_list()),
                }
            },
            "flow": {
                "steps": [
                    {"id": "s1", "type": "manual", "params": {}},
                    {
                        "id": "s2",
                        "type": "click",
                        "params": {
                            "by": "recognizer",
                            "rec": "剑",
                            "search": "full",
                            "strategy": "nth",
                            "index": 3,
                        },
                    },
                ]
            },
        },
        str(tmp_path),
        str(tmp_path / "graph.json"),
    )

    calls: list[tuple[float, float]] = []

    class Controller:
        def click(self, x: float, y: float) -> None:
            calls.append((x, y))

        def swipe(self, *args: Any, **kwargs: Any) -> None:  # pragma: no cover - 本测试不用
            raise AssertionError("不该滑动")

    engine = FlowEngine(graph, Controller())  # type: ignore[arg-type]
    engine.start()
    detection = engine.perceive(_frame(scene), {"剑": "full"})["剑"]
    assert len(detection.all_rects()) == 3, "整帧应当收齐三个候选"

    engine.tick(_frame(scene))
    assert engine.result == "success"
    assert calls, "应当已经点击"
    x, y = calls[0]
    expected = _rect_of(boxes[2]).center
    assert abs(x - expected[0]) < 0.01 and abs(y - expected[1]) < 0.01, calls
