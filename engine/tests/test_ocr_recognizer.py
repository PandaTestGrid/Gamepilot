"""OCR 识别器（`OcrRecognizer`）：把"区域里的字"变成能被条件/等待/点击使用的识别结果。

三个必须钉住的点：
  - **异步**：`detect` 不能等 OCR 跑完（一次 100ms~1s，采集循环只有 8~28fps），
    所以提交一次推理、先用上一帧的结果；
  - **不装死**：模型没下载 / 子进程失败要记在 `last_error` 上，并让失败原因能带出去；
  - **结果会过期**：OCR 慢的时候文字可能已经变了，超过 `max_age_frames` 帧就当没命中。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from gamepilot.core import recognizer as recognizer_module
from gamepilot.core.flow_engine import FlowEngine
from gamepilot.core.frame import Detection, Frame
from gamepilot.core.geometry import Rect
from gamepilot.core.graph import Graph
from gamepilot.core.recognizer import OcrRecognizer, build_recognizer


def _frame(index: int = 1) -> Frame:
    return Frame(image=np.zeros((72, 128, 3), dtype=np.uint8), size=(128, 72), index=index)


def _spec(**overrides: Any) -> dict[str, Any]:
    return {"type": "ocr", "text": "金币", "roi": [0.1, 0.1, 0.3, 0.2], **overrides}


class FakeOcr:
    """替身：手动决定什么时候回结果，模拟 OCR 的异步与失败。"""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, dict[str, Any] | None]] = []
        self.payload: dict[str, Any] | None = None
        self.error: Exception | None = None
        self.auto_complete = True
        self.callbacks: list[Any] = []

    def begin(self, frame: Frame, rect: Rect | None, *, on_complete=None, **_: Any) -> dict[str, Any]:
        self.calls.append((frame, rect))
        if self.error is not None:
            raise self.error
        if on_complete is not None:
            self.callbacks.append(on_complete)
        if self.auto_complete and on_complete is not None:
            on_complete(self.payload or {"text": "", "score": 0.0, "items": []})
        return {"accepted": True}


@pytest.fixture()
def fake_ocr(monkeypatch: pytest.MonkeyPatch) -> FakeOcr:
    fake = FakeOcr()
    monkeypatch.setattr(recognizer_module.OCR_MANAGER, "begin_recognize", fake.begin)
    return fake


def test_build_recognizer_reads_the_ocr_spec() -> None:
    built = build_recognizer("金币", _spec(mode="equals", threshold=0.75, rf=1), "/tmp")
    assert isinstance(built, OcrRecognizer)
    assert built.text == "金币"
    assert built.mode == "equals"
    assert built.threshold == 0.75


def test_ocr_requires_text_and_known_mode(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="要识别的文字"):
        build_recognizer("空", {"type": "ocr", "text": "  "}, str(tmp_path))
    with pytest.raises(ValueError, match="匹配方式"):
        build_recognizer("坏", _spec(mode="fuzzy"), str(tmp_path))
    with pytest.raises(ValueError, match="正则写错了"):
        build_recognizer("坏", _spec(mode="regex", text="["), str(tmp_path))


def test_contains_match_returns_detection_with_item_rect(fake_ocr: FakeOcr) -> None:
    fake_ocr.payload = {
        "text": "本局金币 1200",
        "score": 0.93,
        "items": [
            {"text": "本局", "score": 0.9, "rect": [0.2, 0.2, 0.1, 0.1]},
            {"text": "金币 1200", "score": 0.93, "rect": [0.4, 0.5, 0.2, 0.05]},
        ],
    }
    ocr = OcrRecognizer(label="金币", text="金币", roi=Rect(0.1, 0.1, 0.8, 0.2))

    hits = ocr.detect(_frame(1))
    assert len(hits) == 1
    assert isinstance(hits[0], Detection)
    assert hits[0].source == "ocr"
    assert hits[0].score == pytest.approx(0.93)
    assert hits[0].rect.x == pytest.approx(0.4)
    assert hits[0].rect.y == pytest.approx(0.5)
    assert hits[0].rect.w == pytest.approx(0.2)


def test_threshold_and_modes_filter_the_result(fake_ocr: FakeOcr) -> None:
    fake_ocr.payload = {"text": "金币 1200", "score": 0.55, "items": []}
    assert OcrRecognizer(label="金币", text="金币", threshold=0.6).detect(_frame(1)) == []

    fake_ocr.payload = {"text": "金币 1200", "score": 0.9, "items": []}
    assert OcrRecognizer(label="金币", text="金币 1200", mode="equals").detect(_frame(1))
    assert OcrRecognizer(label="金币", text="金币", mode="equals").detect(_frame(1)) == []
    assert OcrRecognizer(label="金币", text=r"金币 \d+", mode="regex").detect(_frame(1))


def test_stale_result_is_ignored(fake_ocr: FakeOcr) -> None:
    fake_ocr.payload = {"text": "金币", "score": 0.9, "items": []}
    ocr = OcrRecognizer(label="金币", text="金币", max_age_frames=2)

    assert ocr.detect(_frame(10)), "第 10 帧的结果马上能用"
    assert ocr.detect(_frame(12)), "落后 2 帧还在容忍范围内"
    # 第 13 帧会重新提交（fake 又立刻回结果，帧号刷新），所以直接测"不提交"的场景
    fake_ocr.auto_complete = False
    ocr.detect(_frame(13))  # 提交但没结果
    assert ocr.detect(_frame(30)) == [], "结果太旧就当没看见"


def test_runtime_ttl_keeps_200ms_result_despite_capture_frame_gap(
    fake_ocr: FakeOcr, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = [1000.0]
    monkeypatch.setattr(recognizer_module.time, "time", lambda: now[0])
    fake_ocr.auto_complete = False
    ocr = OcrRecognizer(label="金币", text="金币", max_age_frames=2)
    source = _frame(1)
    source.ts = now[0]
    source.async_max_age_seconds = 0.5
    assert ocr.detect(source) == []
    # 提交后源对象即使被改写，回调也必须保留提交时刻，而非完成时刻。
    source.ts = 2000.0
    now[0] += 0.2
    fake_ocr.callbacks[0]({"text": "金币", "score": 0.9, "items": []})
    current = _frame(100)
    current.async_max_age_seconds = 0.5
    assert ocr.detect(current), "200ms 推理结果不能因采集跨过99帧而失效"
    assert ocr._result_ts == 1000.0
    now[0] = 1000.5
    assert ocr.detect(current), "TTL 边界仍可用"
    now[0] = 1000.501
    assert ocr.detect(current) == [], "重复消费同一Frame也必须真实过期"


def test_runtime_ttl_rejects_result_already_expired_when_completed(
    fake_ocr: FakeOcr, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(recognizer_module.time, "time", lambda: 1001.0)
    fake_ocr.auto_complete = False
    ocr = OcrRecognizer(label="金币", text="金币")
    source = _frame(1)
    source.ts = 1000.0
    source.async_max_age_seconds = 0.5
    ocr.detect(source)
    fake_ocr.callbacks[0]({"text": "金币", "score": 0.9, "items": []})
    assert ocr._match(source) == [], "晚到结果不能用完成时刻重新获得TTL"


@pytest.mark.parametrize("source_ts", [float("nan"), float("inf"), 1002.0])
def test_runtime_ttl_rejects_invalid_source_time(
    fake_ocr: FakeOcr, monkeypatch: pytest.MonkeyPatch, source_ts: float
) -> None:
    monkeypatch.setattr(recognizer_module.time, "time", lambda: 1001.0)
    fake_ocr.payload = {"text": "金币", "score": 0.9, "items": []}
    frame = _frame(1)
    frame.ts = source_ts
    frame.async_max_age_seconds = 0.5
    assert OcrRecognizer(label="金币", text="金币").detect(frame) == []


def test_only_one_job_in_flight(fake_ocr: FakeOcr) -> None:
    fake_ocr.auto_complete = False
    ocr = OcrRecognizer(label="金币", text="金币")
    ocr.detect(_frame(1))
    ocr.detect(_frame(2))
    ocr.detect(_frame(3))
    assert len(fake_ocr.calls) == 1, "上一帧还没回来就不要再提交，否则 OCR 子进程被反复打断"


def test_missing_model_is_reported_not_swallowed(fake_ocr: FakeOcr) -> None:
    fake_ocr.error = RuntimeError("OCR 模型未就绪")
    ocr = OcrRecognizer(label="金币", text="金币")

    assert ocr.detect(_frame(1)) == []
    assert ocr.last_error == "OCR 模型未就绪", "模型没就绪要能说清楚，不能让等待步骤空等 20 秒还不解释"

    fake_ocr.error = None
    fake_ocr.payload = {"text": "金币", "score": 0.9, "items": []}
    assert ocr.detect(_frame(2))
    assert ocr.last_error is None


# ---------------- 走一遍执行器：OCR 能当「等待」的条件 ----------------


class FakeController:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    def click(self, x: float, y: float) -> None:
        self.calls.append(("click", round(x, 3), round(y, 3)))

    def swipe(self, *args: Any, **kwargs: Any) -> None:
        self.calls.append(("swipe",))

    def key(self, name: str) -> None:
        self.calls.append(("key", name))

    def press(self, name: str) -> None:
        self.calls.append(("press", name))

    def text(self, value: str) -> None:
        self.calls.append(("text", value))

    def touch(self, phase: str, x: float, y: float) -> None:
        self.calls.append(("touch", phase))


def _graph(tmp_path: Path, steps: list[dict[str, Any]]) -> Graph:
    payload = {
        "version": 1,
        "defaults": {"vote": 1, "click_jitter_px": 0},
        "nodes": [],
        "edges": [],
        "recognizers": {"金币": _spec()},
        "flow": {"steps": steps},
    }
    return Graph.from_dict(payload, str(tmp_path), str(tmp_path / "graph.json"))


class Clock:
    """可控时钟：等待超时要确定（同 `test_flow_engine.py` 的做法）。"""

    def __init__(self) -> None:
        self.value = 1000.0

    def now(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


@pytest.fixture()
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    import time

    clk = Clock()
    monkeypatch.setattr(time, "monotonic", clk.now)
    return clk


def test_wait_step_succeeds_with_the_ocr_recognizer(tmp_path: Path, fake_ocr: FakeOcr, clock: Clock) -> None:
    fake_ocr.payload = {
        "text": "金币 1200",
        "score": 0.91,
        "items": [{"text": "金币 1200", "score": 0.91, "rect": [0.3, 0.4, 0.2, 0.06]}],
    }
    graph = _graph(
        tmp_path,
        [
            {"id": "t", "type": "manual", "params": {}},
            {"id": "w", "type": "wait", "params": {"rec": "金币", "stable_frames": 1, "timeout_ms": 5000}},
        ],
    )
    engine = FlowEngine(graph, FakeController())  # type: ignore[arg-type]
    engine.start()
    for index in range(1, 6):
        engine.tick(_frame(index))
        if engine.result != "running":
            break
    assert engine.result == "success"


def test_wait_step_times_out_when_the_text_is_not_there(tmp_path: Path, fake_ocr: FakeOcr, clock: Clock) -> None:
    fake_ocr.payload = {"text": "抽卡", "score": 0.9, "items": []}
    graph = _graph(
        tmp_path,
        [
            {"id": "t", "type": "manual", "params": {}},
            {"id": "w", "type": "wait", "params": {"rec": "金币", "stable_frames": 1, "timeout_ms": 100}},
        ],
    )
    engine = FlowEngine(graph, FakeController())  # type: ignore[arg-type]
    engine.start()
    engine.tick(_frame(1))
    engine.tick(_frame(2))
    clock.advance(1.0)
    engine.tick(_frame(3))

    assert engine.result == "failure"
    finished = next(event for event in reversed(engine.trace.recent_events()) if event["type"] == "flow_finished")
    assert "金币" in str(finished["message"])


def test_wait_failure_mentions_the_ocr_problem(tmp_path: Path, fake_ocr: FakeOcr, clock: Clock) -> None:
    fake_ocr.error = RuntimeError("OCR 模型未就绪")
    graph = _graph(
        tmp_path,
        [
            {"id": "t", "type": "manual", "params": {}},
            {"id": "w", "type": "wait", "params": {"rec": "金币", "stable_frames": 1, "timeout_ms": 100}},
        ],
    )
    engine = FlowEngine(graph, FakeController())  # type: ignore[arg-type]
    engine.start()
    engine.tick(_frame(1))
    engine.tick(_frame(2))
    clock.advance(1.0)
    engine.tick(_frame(3))

    recognizer = graph.recognizers["金币"]
    assert isinstance(recognizer, OcrRecognizer)
    assert re.search("模型未就绪", recognizer.last_error or "")
    assert engine.result == "failure"
    finished = next(event for event in reversed(engine.trace.recent_events()) if event["type"] == "flow_finished")
    assert "模型未就绪" in str(finished["message"])
