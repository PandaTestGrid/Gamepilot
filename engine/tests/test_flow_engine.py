"""步骤链执行器（`flow_engine.py`）：顺序、等待、延时、循环、条件、断点。

几个必须钉住的点：
  - 顺序就是链的顺序（游标只前进，只有循环回跳）；
  - 「等待界面」只认**进入这一步之后**的帧，并且要连续稳定 N 帧 —— 否则等于没等；
  - 素材当前没命中 → **失败**，不许退回坐标（点错地方比不点更糟）；
  - 断点在**执行前**停，恢复后从当前这一步接着来。
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pytest

from gamepilot.core.evidence import RunEvidence
from gamepilot.core.flow_engine import FlowEngine
from gamepilot.core.frame import Detection, Frame
from gamepilot.core.geometry import Rect
from gamepilot.core.graph import Graph


class FakeController:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    def click(self, x: float, y: float) -> None:
        self.calls.append(("click", round(x, 3), round(y, 3)))

    def swipe(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        duration: float = 0.3,
        path: list[tuple[float, float]] | None = None,
    ) -> None:
        self.calls.append(
            ("swipe", round(x1, 3), round(y1, 3), round(x2, 3), round(y2, 3), None if not path else len(path))
        )

    def key(self, name: str) -> None:
        self.calls.append(("key", name))

    def press(self, name: str) -> None:
        self.calls.append(("press", name))

    def text(self, value: str) -> None:
        self.calls.append(("text", value))

    def touch(self, phase: str, x: float, y: float) -> None:
        self.calls.append(("touch", phase, round(x, 3), round(y, 3)))


class Clock:
    """可控时钟：等待/延时的超时判定要确定，不能靠真 sleep。"""

    def __init__(self) -> None:
        self.value = 1000.0

    def now(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


def step(step_id: str, kind: str, **params: Any) -> dict[str, Any]:
    return {"id": step_id, "type": kind, "params": params}


#: 测试里用到的识别器标签（校验要求"引用的识别器必须存在"；颜色识别器不需要模板文件）
_KNOWN = ("主城", "公告弹窗", "开始", "备用")


def _color_spec() -> dict[str, Any]:
    return {"type": "color", "roi": [0.2, 0.2, 0.1, 0.1], "target_bgr": [0, 0, 0], "tolerance": 30, "min_pixels": 10}


class Harness:
    def __init__(
        self,
        steps: list[dict[str, Any]],
        tmp_path: Path,
        hits: dict[str, Detection] | None = None,
        defaults: dict[str, Any] | None = None,
    ) -> None:
        payload = {
            "version": 1,
            "defaults": {
                "click_jitter_px": 0,
                "click_micro_px": 0,
                "delay_jitter_ms": 0,
                "swipe_bezier": False,
                **(defaults or {}),
            },
            "nodes": [],
            "edges": [],
            "recognizers": {label: _color_spec() for label in _KNOWN},
            "flow": {"steps": steps},
        }
        self.graph = Graph.from_dict(payload, str(tmp_path), str(tmp_path / "graph.json"))
        self.controller = FakeController()
        self.engine = FlowEngine(self.graph, self.controller)  # type: ignore[arg-type]  # 鸭子类型的假控制器
        self.hits: dict[str, Detection] = hits or {}

        # 注入识别结果时须写回 engine.detections（执行器读该字段）。
        def _perceive(
            _frame: Frame,
            _search_overrides: dict[str, str] | None = None,
        ) -> dict[str, Detection]:
            self.engine.detections = dict(self.hits)
            return self.engine.detections

        self.engine.perceive = _perceive  # type: ignore[method-assign,assignment]
        self.index = 0
        self.engine.start()

    def tick(self, times: int = 1) -> None:
        for _ in range(times):
            self.index += 1
            self.engine.tick(Frame(image=None, size=(1, 1), index=self.index))  # type: ignore[arg-type]

    def run(self, limit: int = 60) -> None:
        """跑到结束（或到上限）。"""
        for _ in range(limit):
            if self.engine.result != "running":
                return
            self.tick()


@pytest.fixture()
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    clk = Clock()
    # 直接打 stdlib 的 time：flow_engine 引用的就是同一个模块对象
    monkeypatch.setattr(time, "monotonic", clk.now)
    return clk


def hit(label: str) -> dict[str, Detection]:
    return {label: Detection(label, Rect(0.2, 0.2, 0.1, 0.1), score=0.9, state="confirmed")}


def hits(*labels: str) -> dict[str, Detection]:
    merged: dict[str, Detection] = {}
    for label in labels:
        merged.update(hit(label))
    return merged


def test_start_from_step_id_skips_earlier_steps(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("s2", "click", by="坐标", x=0.1, y=0.1),
            step("s3", "key", value="back"),
        ],
        tmp_path,
    )
    h.engine.start(from_step_id="s3")
    h.run()
    assert h.controller.calls == [("press", "back")]
    assert h.engine.result == "success"


def test_runs_steps_in_order(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("s2", "click", by="坐标", x=0.2, y=0.3),
            step("s3", "key", value="back"),
            step("s4", "delay", ms=500),
            step("s5", "text", value="你好"),
        ],
        tmp_path,
    )
    h.tick()  # manual + 点击 + 按键
    assert h.controller.calls == [("click", 0.2, 0.3), ("press", "back")]
    clock.advance(0.6)  # 延时到点
    h.run()
    assert h.controller.calls == [("click", 0.2, 0.3), ("press", "back"), ("text", "你好")]
    assert h.engine.result == "success"


def test_swipe_step_can_disable_bezier_or_follow_global(tmp_path: Path, clock: Clock) -> None:
    linear = Harness(
        [
            step("s1", "manual"),
            step("s2", "swipe", x=0.5, y=0.8, to_x=0.5, to_y=0.2, duration_ms=300, bezier=False),
        ],
        tmp_path,
    )
    linear.run()
    assert linear.controller.calls == [("swipe", 0.5, 0.8, 0.5, 0.2, None)]
    assert linear.engine.result == "success"

    curved = Harness(
        [
            step("s1", "manual"),
            step("s2", "swipe", x=0.2, y=0.5, to_x=0.8, to_y=0.5, duration_ms=200, bezier=True),
        ],
        tmp_path,
    )
    curved.run()
    assert len(curved.controller.calls) == 1
    kind, x1, y1, x2, y2, count = curved.controller.calls[0]
    assert (kind, x1, y1, x2, y2) == ("swipe", 0.2, 0.5, 0.8, 0.5)
    assert isinstance(count, int) and count >= 8


def test_swipe_step_with_path_and_hold_uses_realtime_touch(tmp_path: Path, clock: Clock) -> None:
    """步骤链里的连续滑动：轨迹逐点下发 + 到终点按住，而不是压缩成一次手势。"""
    h = Harness(
        [
            step("s1", "manual"),
            step(
                "s2",
                "swipe",
                x=0.2,
                y=0.8,
                to_x=0.6,
                to_y=0.6,
                duration_ms=100,
                path=[[0.2, 0.8], [0.4, 0.8], [0.6, 0.6]],
                hold_ms=100,
            ),
        ],
        tmp_path,
    )
    h.run()
    phases = [call[1] for call in h.controller.calls]
    assert phases == ["down", "move", "move", "up"]
    assert h.controller.calls[0][2:] == (0.2, 0.8)
    assert h.controller.calls[-1][2:] == (0.6, 0.6)
    assert h.engine.result == "success"


def test_click_with_rect_and_stale_by_coord_uses_random_region(tmp_path: Path, clock: Clock) -> None:
    """by 仍是「坐标」但已框选 rect、且 x/y 被清掉时，应走随机范围而不是 Action 校验失败。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("s2", "click", by="坐标", rect=[0.0, 0.0, 0.5, 0.5]),
        ],
        tmp_path,
    )
    h.run()
    assert h.engine.result == "success"
    assert len(h.controller.calls) == 1
    x, y = h.controller.calls[0][1], h.controller.calls[0][2]
    assert 0.0 <= x <= 0.5
    assert 0.0 <= y <= 0.5


def test_click_region_mode_without_rect_fails(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("s2", "click", by="随机范围", x=0.5, y=0.5),
        ],
        tmp_path,
    )
    h.run()
    assert h.engine.result == "failure"
    assert h.controller.calls == []
    assert "框选范围" in h.engine.trace.recent_events(5)[-1]["message"]


def test_click_random_region_user_rect_shape(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("s2", "click", by="随机范围", rect=[0.05, 0.31, 0.90, 0.24]),
        ],
        tmp_path,
    )
    h.run()
    assert h.engine.result == "success"
    assert len(h.controller.calls) == 1


def test_click_random_in_norm_rect(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("s2", "click", by="随机范围", rect=[0.1, 0.2, 0.3, 0.4]),
            step("s3", "click", by="随机范围", rect=[0.1, 0.2, 0.3, 0.4]),
        ],
        tmp_path,
    )
    h.run()
    assert len(h.controller.calls) == 2
    for call in h.controller.calls:
        assert call[0] == "click"
        x, y = call[1], call[2]
        assert 0.1 <= x <= 0.4
        assert 0.2 <= y <= 0.6


def test_click_by_recognizer_uses_the_detection_center(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [step("s1", "manual"), step("s2", "click", by="识别器", rec="开始")],
        tmp_path,
        hit("开始"),
    )
    h.run()
    # Rect(0.2, 0.2, 0.1, 0.1) 的中心 = (0.25, 0.25)
    assert h.controller.calls == [("click", 0.25, 0.25)]


def test_step_search_scope_is_read_from_current_step(tmp_path: Path, clock: Clock) -> None:
    """搜索范围属于步骤：当前步骤写了 full 才覆盖，没写就用模板默认。"""
    h = Harness(
        [step("s1", "manual"), step("s2", "click", by="识别器", rec="开始", search="full")],
        tmp_path,
    )
    h.tick()  # manual 走完 → 停在 click（没命中会等）
    assert h.engine._step_search_overrides() == {"开始": "full"}


def test_cond_step_search_scope_covers_all_group_labels(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step(
                "s2",
                "cond",
                groups=[{"all": ["主城", "公告弹窗"]}],
                search="region",
                timeout_ms=5000,
            ),
        ],
        tmp_path,
    )
    h.tick()  # cond 未命中 → 停在条件步骤上等待
    assert h.engine._step_search_overrides() == {"主城": "region", "公告弹窗": "region"}


def test_click_refuses_ambiguous_target_instead_of_guessing(tmp_path: Path, clock: Clock) -> None:
    """全屏搜索到两个同分目标时，点击必须失败 —— 猜一个就是有概率点错。"""
    ambiguous = Detection("开始", Rect(0.2, 0.2, 0.1, 0.1), score=0.9, state="confirmed", ambiguous=True)
    h = Harness(
        [step("s1", "manual"), step("s2", "click", by="识别器", rec="开始")],
        tmp_path,
        {"开始": ambiguous},
    )
    h.run()
    assert h.engine.result == "failure"
    assert h.controller.calls == []
    assert "多个同分候选" in h.engine.trace.recent_events(5)[-1]["message"]


def test_click_supports_double_click_and_long_press_events(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("s2", "click", by="坐标", event="double_click", x=0.4, y=0.6),
            step("s3", "click", by="识别器", event="long_press", rec="开始", duration_ms=100),
        ],
        tmp_path,
        hit("开始"),
    )
    h.run()
    assert h.controller.calls == [
        ("click", 0.4, 0.6),
        ("click", 0.4, 0.6),
        ("click", 0.25, 0.25),
    ]
    assert h.engine.result == "success"


def test_missing_material_fails_instead_of_falling_back_to_coordinates(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [step("s1", "manual"), step("s2", "click", by="识别器", rec="开始", x=0.9, y=0.9)],
        tmp_path,
        {},  # 一个都没命中
    )
    h.tick()
    # 默认等待 20s，未超时前保持 running，不会退回坐标点击
    assert h.engine.result == "running"
    assert h.controller.calls == []
    clock.advance(21.0)
    h.run()
    assert h.engine.result == "failure"
    assert h.controller.calls == []
    assert "没有命中" in h.engine.trace.recent_events(5)[-1]["message"]


def test_click_by_recognizer_waits_up_to_match_timeout_then_clicks_when_hit(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [step("s1", "manual"), step("s2", "click", by="识别器", rec="开始")],
        tmp_path,
        {},
    )
    h.tick()
    assert h.engine.result == "running"
    assert h.controller.calls == []
    clock.advance(5.0)
    h.tick()
    assert h.engine.result == "running"
    # 第 5 秒后画面出现「开始」模板 → 立即点击并完成
    h.hits.update(hit("开始"))
    h.run()
    assert h.engine.result == "success"
    assert h.controller.calls == [("click", 0.25, 0.25)]


def test_global_pre_and_post_action_delays_and_step_interval(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("s2", "click", by="坐标", x=0.2, y=0.3),
            step("s3", "key", value="back"),
        ],
        tmp_path,
        defaults={
            "pre_action_delay_ms": 200,
            "post_action_delay_ms": 300,
            "step_interval_ms": 100,
        },
    )
    h.tick()  # 进入 s2 的动作前延迟 200ms
    assert h.controller.calls == []
    clock.advance(0.25)
    h.tick()  # 动作前延迟结束 → 执行点击 → 进入动作后+间隔延迟 (300+100=400ms)
    assert h.controller.calls == [("click", 0.2, 0.3)]
    assert h.engine.result == "running"
    clock.advance(0.45)
    h.tick()  # s2 动作后延迟结束 → 推进到 s3 的动作前延迟 200ms
    assert h.controller.calls == [("click", 0.2, 0.3)]
    clock.advance(0.25)
    h.tick()  # 执行 s3 按键 → 进入 s3 动作后延迟 400ms
    assert h.controller.calls == [("click", 0.2, 0.3), ("press", "back")]
    clock.advance(0.45)
    h.tick()
    assert h.engine.result == "success"


def test_wait_only_counts_frames_after_entering_the_step(tmp_path: Path, clock: Clock) -> None:
    """进入那一步的这一帧**不算**：不然会立刻判成"已稳定"，等于没等。"""
    h = Harness(
        [step("s1", "manual"), step("s2", "wait", rec="主城", stable_frames=2, timeout_ms=10000)],
        tmp_path,
        hit("主城"),
    )
    h.tick()  # 进入这一帧：不算（要"进入之后的帧"）
    assert h.engine.result == "running"
    h.tick()  # 第 1 个有效帧 → 稳定 1
    assert h.engine.result == "running"
    h.tick()  # 第 2 个有效帧 → 稳定 2 → 过，然后链尾收工
    assert h.engine.result == "success"
    assert h.engine.trace.recent_events(3)[-1]["message"] == "整条链跑完了"


def test_wait_is_reset_when_the_screen_disappears(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [step("s1", "manual"), step("s2", "wait", rec="主城", stable_frames=2, timeout_ms=10000)],
        tmp_path,
        hit("主城"),
    )
    h.tick()  # 进入帧
    h.hits.clear()  # 闪了一下又没了 → 稳定计数归零
    h.tick()
    h.hits.update(hit("主城"))
    h.tick()  # 稳定 1
    assert h.engine.result == "running"  # 重新数
    h.tick()  # 稳定 2 → 过
    assert h.engine.result == "success"


def test_wait_times_out(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [step("s1", "manual"), step("s2", "wait", rec="主城", stable_frames=1, timeout_ms=1000)],
        tmp_path,
        {},
    )
    h.tick()
    clock.advance(2.0)
    h.tick()
    assert h.engine.result == "failure"
    assert "超时" in h.engine.trace.recent_events(3)[-1]["message"]


def test_delay_blocks_until_time_passes(tmp_path: Path, clock: Clock) -> None:
    h = Harness([step("s1", "manual"), step("s2", "delay", ms=1000), step("s3", "key", value="home")], tmp_path)
    h.tick()
    assert h.controller.calls == []  # 还在等
    clock.advance(0.5)
    h.tick()
    assert h.controller.calls == []
    clock.advance(0.6)
    h.tick()
    assert h.controller.calls == [("press", "home")]
    assert h.engine.result == "success"


def test_breakpoint_pauses_before_the_step_and_resume_continues(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [step("s1", "manual"), step("s2", "click", by="坐标", x=0.3, y=0.3), step("s3", "key", value="back")],
        tmp_path,
    )
    h.engine.breakpoints.add("s2")
    h.tick()
    assert h.engine.paused
    assert h.controller.calls == []  # 执行**前**停
    assert h.engine.trace.recent_events(3)[-1]["type"] == "breakpoint_hit"

    h.engine.resume()
    h.run()
    assert h.controller.calls == [("click", 0.3, 0.3), ("press", "back")]
    assert h.engine.result == "success"


def test_single_step_runs_one_step_then_pauses_before_the_next(tmp_path: Path, clock: Clock) -> None:
    """单步 = 放行当前这一步，进入下一步之前再停（断点只在执行前停一次，单步要能连续走）。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("s2", "click", by="坐标", x=0.3, y=0.3),
            step("s3", "key", value="back"),
        ],
        tmp_path,
    )
    h.engine.breakpoints.add("s2")
    h.tick()
    assert h.engine.paused
    assert h.controller.calls == []

    h.engine.step()
    h.tick()
    assert h.controller.calls == [("click", 0.3, 0.3)]
    assert h.engine.paused
    assert h.engine.paused_at == "s3"
    assert h.engine.trace.recent_events(2)[-1]["type"] == "breakpoint_hit"

    h.engine.step()
    h.run()
    assert h.controller.calls == [("click", 0.3, 0.3), ("press", "back")]
    assert h.engine.result == "success"


def test_single_step_pauses_again_when_a_loop_reenters_the_same_step(tmp_path: Path, clock: Clock) -> None:
    """循环体只有一个步骤时，游标会回到同一节 —— 用 step_id 比较会永远停不下来。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("lp", "loop", count=2),
            step("body", "key", value="back"),
            step("le", "loopend", back="lp"),
        ],
        tmp_path,
    )
    h.engine.breakpoints.add("body")
    h.tick()
    assert h.engine.paused

    h.engine.step()
    h.tick()
    assert [call[1] for call in h.controller.calls] == ["back"]
    assert h.engine.paused_at == "le"  # 执行完 body，停在 loopend 之前

    h.engine.step()
    h.tick()
    # 循环第二次进入同一节：仍然停（用 step_id 比较的写法会直接冲过去）
    assert h.engine.paused_at == "body"
    assert [call[1] for call in h.controller.calls] == ["back"]


def test_stop_marks_cancelled(tmp_path: Path, clock: Clock) -> None:
    h = Harness([step("s1", "manual"), step("s2", "delay", ms=10000)], tmp_path)
    h.tick()
    h.engine.stop_execution()
    assert h.engine.result == "cancelled"
    h.tick()
    assert h.controller.calls == []


def test_rerun_starts_from_the_top(tmp_path: Path, clock: Clock) -> None:
    h = Harness([step("s1", "manual"), step("s2", "click", by="坐标", x=0.1, y=0.1)], tmp_path)
    h.run()
    assert len(h.controller.calls) == 1
    h.engine.start()  # 再点一次「运行」
    h.run()
    assert len(h.controller.calls) == 2


def test_empty_chain_finishes_immediately(tmp_path: Path, clock: Clock) -> None:
    h = Harness([], tmp_path)
    h.run()
    assert h.engine.result == "success"


def test_call_switches_to_the_named_subflow(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [step("s1", "manual"), step("s2", "call", name="每日任务"), step("s3", "key", value="back")],
        tmp_path,
    )
    called: list[str] = []
    h.engine.on_call = called.append
    h.run()
    assert called == ["每日任务"]
    assert h.engine.result == "success"
    assert h.controller.calls == []  # 切换之后这条链就到头了，后面那步不该再跑
    assert "已切到子流程" in h.engine.trace.recent_events(3)[-1]["message"]


def test_call_without_a_target_fails(tmp_path: Path, clock: Clock) -> None:
    h = Harness([step("s1", "manual"), step("s2", "call", name="")], tmp_path)
    h.engine.on_call = lambda _name: None
    h.run()
    assert h.engine.result == "failure"
    assert "还没选" in h.engine.trace.recent_events(3)[-1]["message"]


def test_call_without_a_runner_fails(tmp_path: Path, clock: Clock) -> None:
    h = Harness([step("s1", "manual"), step("s2", "call", name="别的")], tmp_path)
    h.run()
    assert h.engine.result == "failure"
    assert "不支持" in h.engine.trace.recent_events(3)[-1]["message"]


def test_cond_true_runs_then_region_then_skips_else(tmp_path: Path, clock: Clock) -> None:
    """条件命中：做「条件 → 否则」之间那一支，然后跳过否则那一支，在「条件结束」后汇合。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("c", "cond", rec="公告弹窗"),
            step("then1", "key", value="back"),
            step("e", "else"),
            step("else1", "key", value="home"),
            step("end", "condend", back="c"),
            step("after", "key", value="recents"),
        ],
        tmp_path,
        hit("公告弹窗"),
    )
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["back", "recents"]


def test_cond_false_runs_the_else_region(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("c", "cond", rec="公告弹窗"),
            step("then1", "key", value="back"),
            step("e", "else"),
            step("else1", "key", value="home"),
            step("end", "condend", back="c"),
            step("after", "key", value="recents"),
        ],
        tmp_path,
        {},  # 没命中
    )
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["home", "recents"]


def test_cond_false_without_else_skips_the_whole_block(tmp_path: Path, clock: Clock) -> None:
    """没写「否则」= 没命中就整块跳过（不是像以前那样把链停死）。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("c", "cond", rec="公告弹窗"),
            step("then1", "key", value="back"),
            step("end", "condend", back="c"),
            step("after", "key", value="recents"),
        ],
        tmp_path,
        {},
    )
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["recents"]


def test_cond_waits_before_taking_the_false_exit(tmp_path: Path, clock: Clock) -> None:
    """条件可配置未命中等待；等待窗口内命中后应走成立支。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("c", "cond", rec="公告弹窗", timeout_ms=1500),
            step("then1", "key", value="back"),
            step("end", "condend", back="c"),
            step("after", "key", value="recents"),
        ],
        tmp_path,
        {},
    )
    h.tick()  # 进入条件并开始等待
    assert h.engine.result == "running"
    clock.advance(0.5)
    h.hits.update(hit("公告弹窗"))
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["back", "recents"]


def test_cond_timeout_then_takes_false_exit(tmp_path: Path, clock: Clock) -> None:
    """条件等待超时后才允许进入不成立分支，不能在首帧抢跑。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("c", "cond", rec="公告弹窗", timeout_ms=1000),
            step("then1", "key", value="back"),
            step("end", "condend", back="c"),
            step("after", "key", value="recents"),
        ],
        tmp_path,
        {},
    )
    h.tick()
    assert h.controller.calls == []
    clock.advance(1.1)
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["recents"]


def test_cond_groups_and_within_group(tmp_path: Path, clock: Clock) -> None:
    """groups：组内且、组间或。"""
    h = Harness(
        [
            step("s1", "manual"),
            step(
                "c",
                "cond",
                groups=[{"all": ["公告弹窗", "主城"]}, {"all": ["备用"]}],
            ),
            step("then1", "key", value="back"),
            step("end", "condend", back="c"),
            step("after", "key", value="recents"),
        ],
        tmp_path,
        hits("公告弹窗", "主城"),
    )
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["back", "recents"]

    h2 = Harness(
        [
            step("s1", "manual"),
            step(
                "c",
                "cond",
                groups=[{"all": ["公告弹窗", "主城"]}, {"all": ["备用"]}],
            ),
            step("then1", "key", value="back"),
            step("end", "condend", back="c"),
            step("after", "key", value="recents"),
        ],
        tmp_path,
        hit("备用"),
    )
    h2.run()
    assert h2.engine.result == "success"
    assert [call[1] for call in h2.controller.calls] == ["back", "recents"]


def test_loop_runs_body_fixed_times(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("lp", "loop", count=3),
            step("d", "key", value="back"),
            step("le", "loopend", back="lp"),
            step("after", "key", value="home"),
        ],
        tmp_path,
    )
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["back", "back", "back", "home"]


def test_loop_events_carry_current_total_progress(tmp_path: Path, clock: Clock) -> None:
    """循环体执行中事件 extra.loops 带「当前次 / 总次数」，给节点头部画 2 / 12。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("lp", "loop", count=3),
            step("wait", "delay", ms=50),
            step("le", "loopend", back="lp"),
        ],
        tmp_path,
    )
    h.tick()
    events = h.engine.trace.recent_events()
    delay_started = next(item for item in events if item["type"] == "step_started" and item["node"] == "wait")
    assert delay_started["extra"]["loops"] == [{"stepId": "lp", "current": 1, "total": 3}]

    clock.advance(0.06)
    h.tick()
    events = h.engine.trace.recent_events()
    repeat = next(item for item in reversed(events) if item["type"] == "loop_repeat")
    assert repeat["extra"]["loops"] == [{"stepId": "lp", "current": 2, "total": 3}]

    h.engine.start(from_step_id="wait")
    started = next(item for item in reversed(h.engine.trace.recent_events()) if item["type"] == "flow_started")
    assert started["extra"]["loops"] == [{"stepId": "lp", "current": 1, "total": 3}]


def test_nested_loop_events_report_each_frame(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("outer", "loop", count=2),
            step("inner", "loop", count=4),
            step("wait", "delay", ms=50),
            step("ile", "loopend", back="inner"),
            step("ole", "loopend", back="outer"),
        ],
        tmp_path,
    )
    h.tick()
    events = h.engine.trace.recent_events()
    delay_started = next(item for item in events if item["type"] == "step_started" and item["node"] == "wait")
    assert delay_started["extra"]["loops"] == [
        {"stepId": "outer", "current": 1, "total": 2},
        {"stepId": "inner", "current": 1, "total": 4},
    ]


def test_loop_with_delay_then_click_does_not_shadow_frame(tmp_path: Path, clock: Clock) -> None:
    """loopend 不得覆盖 tick 的 Frame；否则下一轮 delay/click 读 frame.index 会崩，采集线程整条卡死。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("lp", "loop", count=2),
            step("wait", "delay", ms=10),
            step("tap", "click", by="坐标", x=0.4, y=0.5),
            step("le", "loopend", back="lp"),
        ],
        tmp_path,
    )
    h.tick()
    clock.advance(0.02)
    h.tick()
    clock.advance(0.02)
    h.tick()
    assert h.engine.result == "success"
    assert h.controller.calls == [("click", 0.4, 0.5), ("click", 0.4, 0.5)]


def test_nested_loops_multiply_iterations(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("outer", "loop", count=2),
            step("inner", "loop", count=2),
            step("d", "key", value="back"),
            step("ile", "loopend", back="inner"),
            step("ole", "loopend", back="outer"),
        ],
        tmp_path,
    )
    h.run()
    assert h.engine.result == "success"
    assert len(h.controller.calls) == 4


def test_cond_loop_repeat_else_does_not_need_loopbreak(tmp_path: Path, clock: Clock) -> None:
    """不成立再循环：成立支跑完直接出循环，图里不需要「跳出循环」步骤。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("lp", "loop", count=99),
            step("c", "cond", rec="公告弹窗", _loopRepeat="else"),
            step("yes", "key", value="back"),
            step("ce", "condend", back="c"),
            step("le", "loopend", back="lp"),
            step("after", "key", value="home"),
        ],
        tmp_path,
        hit("公告弹窗"),
    )
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["back", "home"]


def test_cond_repeat_targets_outer_loop_not_just_innermost(tmp_path: Path, clock: Clock) -> None:
    """条件在内层循环里，但接回的是外层循环：要退出外层，不能只弹掉内层。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("outer", "loop", count=3),
            step("inner", "loop", count=3),
            step("body", "key", value="volume_up"),
            step("c", "cond", rec="公告弹窗", _loopRepeat="else", _loopRepeatLoop="outer"),
            step("ce", "condend", back="c"),
            step("ile", "loopend", back="inner"),
            step("ole", "loopend", back="outer"),
            step("after", "key", value="home"),
        ],
        tmp_path,
        hit("公告弹窗"),
    )
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["volume_up", "home"]


def test_nested_cond_repeat_does_not_break_outer_loop_early(tmp_path: Path, clock: Clock) -> None:
    """外层条件标了「再循环」时，内层条件的 condend 不能替外层提前结束循环。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("lp", "loop", count=3),
            step("c1", "cond", rec="公告弹窗", _loopRepeat="else", _loopRepeatLoop="lp"),
            step("yes1", "key", value="back"),
            step("c2", "cond", rec="主城"),
            step("yes2", "key", value="volume_down"),
            step("ce2", "condend", back="c2"),
            step("inner_after", "key", value="enter"),
            step("ce1", "condend", back="c1"),
            step("le", "loopend", back="lp"),
            step("after", "key", value="home"),
        ],
        tmp_path,
        hits=hits("公告弹窗", "主城"),
    )
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["back", "volume_down", "enter", "home"]


def test_implicit_loopbreak_outside_loop_does_not_block_run(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("lp", "loop", count=1),
            step("d", "key", value="back"),
            step("le", "loopend", back="lp"),
            step("ghost", "loopbreak", _implicit=True),
            step("after", "key", value="home"),
        ],
        tmp_path,
    )
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["back", "home"]


def test_loopbreak_exits_before_count_exhausted(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("lp", "loop", count=99),
            step("c", "cond", rec="公告弹窗"),
            step("br", "loopbreak"),
            step("ce", "condend", back="c"),
            step("d", "key", value="back"),
            step("le", "loopend", back="lp"),
            step("after", "key", value="home"),
        ],
        tmp_path,
        hit("公告弹窗"),
    )
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["home"]


def test_loop_inside_cond_runs_when_condition_true(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("c", "cond", rec="公告弹窗"),
            step("lp", "loop", count=2),
            step("d", "key", value="back"),
            step("le", "loopend", back="lp"),
            step("ce", "condend", back="c"),
        ],
        tmp_path,
        hit("公告弹窗"),
    )
    h.run()
    assert [call[1] for call in h.controller.calls] == ["back", "back"]


def test_nested_conditions_pick_the_right_region(tmp_path: Path, clock: Clock) -> None:
    """外层命中、内层不命中：内层走它的否则支，外层照常汇合。"""
    steps = [
        step("s1", "manual"),
        step("outer", "cond", rec="公告弹窗"),
        step("inner", "cond", rec="主城"),
        step("ti", "key", value="back"),
        step("ie", "else"),
        step("ei", "key", value="home"),
        step("iend", "condend", back="inner"),
        step("oe", "else"),
        step("eo", "key", value="recents"),
        step("oend", "condend", back="outer"),
        step("after", "key", value="enter"),
    ]
    h = Harness(steps, tmp_path, hit("公告弹窗"))  # 外层命中、内层没命中
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["home", "enter"]


def test_on_error_continue_skips_failed_action(tmp_path: Path, clock: Clock) -> None:
    """启用「出错时 → 继续流程」时，动作失败不终止整条链。"""

    class BoomClick(FakeController):
        def click(self, x: float, y: float) -> None:
            raise ValueError("click failed")

    steps = [
        step("s1", "manual"),
        step(
            "s2",
            "click",
            by="坐标",
            x=0.5,
            y=0.5,
            settings={"onError": {"enabled": True, "mode": "continue"}},
        ),
        step("s3", "key", value="back"),
    ]
    h = Harness(steps, tmp_path)
    boom = BoomClick()
    h.engine.controller = boom  # type: ignore[assignment]
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in boom.calls] == ["back"]


def test_disabled_loop_skips_the_whole_block(tmp_path: Path, clock: Clock) -> None:
    """跳过循环模块 = 循环体不跑，直接走循环后的下一步。"""
    h = Harness(
        [
            step("s1", "manual"),
            {"id": "lp", "type": "loop", "params": {"count": 3}, "disabled": True},
            step("d", "key", value="back"),
            step("le", "loopend", back="lp"),
            step("after", "key", value="home"),
        ],
        tmp_path,
    )
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["home"]


def test_disabled_cond_skips_the_whole_block(tmp_path: Path, clock: Clock) -> None:
    """跳过条件模块 = 成立/不成立两支都不跑。"""
    h = Harness(
        [
            step("s1", "manual"),
            {"id": "c", "type": "cond", "params": {"rec": "公告弹窗"}, "disabled": True},
            step("yes", "key", value="back"),
            step("e", "else"),
            step("no", "key", value="recents"),
            step("ce", "condend", back="c"),
            step("after", "key", value="home"),
        ],
        tmp_path,
        hit("公告弹窗"),
    )
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["home"]


def test_disabled_step_is_skipped(tmp_path: Path, clock: Clock) -> None:
    """停用的步骤不执行，但链照常往下走（像没写过一样）。"""
    h = Harness(
        [
            step("s1", "manual"),
            {"id": "sk", "type": "click", "params": {"by": "坐标", "x": 0.1, "y": 0.1}, "disabled": True},
            step("s3", "key", value="back"),
        ],
        tmp_path,
    )
    h.run()
    assert h.engine.result == "success"
    assert [call[1] for call in h.controller.calls] == ["back"]  # 停用的点击没执行
    messages = [item["message"] for item in h.engine.trace.recent_events(10)]
    assert any("已停用" in message for message in messages)


def test_unconnected_tail_is_never_executed(tmp_path: Path, clock: Clock) -> None:
    """未接入（_pendingLink）的模块在链尾：到它为止，它和它后面挂的都不跑。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("a", "key", value="back"),
            {"id": "tail", "type": "click", "params": {"by": "坐标", "x": 0.5, "y": 0.5, "_pendingLink": True}},
        ],
        tmp_path,
    )
    h.run()
    assert h.engine.result == "success"
    assert [call[0] for call in h.controller.calls] == ["press"]
    messages = [item["message"] for item in h.engine.trace.recent_events(20)]
    assert any("没有连线接入" in message for message in messages)


def test_start_from_an_unconnected_module_runs_it(tmp_path: Path, clock: Clock) -> None:
    """「从本模块开始运行」对未接入的模块也要能跑（调试用）。"""
    h = Harness(
        [
            step("s1", "manual"),
            {"id": "x", "type": "key", "params": {"value": "home", "_pendingLink": True}},
        ],
        tmp_path,
    )
    h.engine.start(from_step_id="x")
    h.run()
    assert [call[1] for call in h.controller.calls] == ["home"]


def test_start_from_unconnected_loop_body_does_not_repeat(tmp_path: Path, clock: Clock) -> None:
    """断开循环连线后，从循环体内的点击开跑只执行一次，不能被 loopend 拉回去循环。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("lp", "loop", count=120),
            {"id": "tap", "type": "click", "params": {"by": "坐标", "x": 0.4, "y": 0.5, "_pendingLink": True}},
            step("le", "loopend", back="lp"),
            step("after", "key", value="home"),
        ],
        tmp_path,
    )
    h.engine.start(from_step_id="tap")
    h.run()
    assert h.engine.result == "success"
    assert h.controller.calls == [("click", 0.4, 0.5)]


def test_start_from_connected_loop_body_still_repeats(tmp_path: Path, clock: Clock) -> None:
    """仍接在循环里的模块：从它开跑要按剩余次数循环。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("lp", "loop", count=3),
            step("tap", "click", by="坐标", x=0.4, y=0.5),
            step("le", "loopend", back="lp"),
        ],
        tmp_path,
    )
    h.engine.start(from_step_id="tap")
    h.run()
    assert h.engine.result == "success"
    assert h.controller.calls == [("click", 0.4, 0.5), ("click", 0.4, 0.5), ("click", 0.4, 0.5)]


def test_step_scope_switches_mid_tick_and_clicks_target_outside_roi(tmp_path: Path, clock: Clock) -> None:
    """同一拍里从 manual 走到 click：click 写 search=full，目标在 roi 外也要能立刻点到。"""
    width, height = 400, 200
    template_w, template_h = 80, 30
    recorded = (40, 60)  # 录制时目标在左上角
    moved = (200, 60)  # 实际跑到右边

    yy, xx = np.mgrid[0:template_h, 0:template_w]
    mask = ((xx // 4 + yy // 4) % 2 == 0)[:, :, None]
    target = np.where(mask, np.array([230, 230, 230], np.uint8), np.array([40, 40, 40], np.uint8))
    cv2.imwrite(str(tmp_path / "btn.png"), target)

    image = np.full((height, width, 3), 24, np.uint8)
    image[moved[1] : moved[1] + template_h, moved[0] : moved[0] + template_w] = target

    roi = [recorded[0] / width, recorded[1] / height, template_w / width, template_h / height]
    graph = Graph.from_dict(
        {
            "version": 1,
            "defaults": {"click_jitter_px": 0, "click_micro_px": 0},
            "nodes": [],
            "edges": [],
            "recognizers": {
                "btn": {"type": "template", "template": "btn.png", "threshold": 0.9, "roi": roi},
            },
            "flow": {
                "steps": [
                    {"id": "t", "type": "manual", "params": {}},
                    {"id": "s", "type": "click", "params": {"by": "识别器", "rec": "btn", "search": "full"}},
                ]
            },
        },
        str(tmp_path),
        str(tmp_path / "graph.json"),
    )
    controller = FakeController()
    engine = FlowEngine(graph, controller)  # type: ignore[arg-type]  # 鸭子类型的假控制器
    engine.start()

    frame = Frame(image=image, size=(width, height), index=1)
    engine.tick(frame)

    assert controller.calls == [
        ("click", round((moved[0] + template_w / 2) / width, 3), round((moved[1] + template_h / 2) / height, 3))
    ]


def test_setvar_writes_literal_and_accumulates_with_expression(tmp_path: Path, clock: Clock) -> None:
    """「赋值」是把 `value` 求值后写进运行期变量：字面量、`$变量 + 1` 都要能算。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("init", "setvar", name="次数", value="0"),
            step("lp", "loop", count=3),
            step("inc", "setvar", name="次数", value="$次数 + 1"),
            step("le", "loopend", back="lp"),
        ],
        tmp_path,
    )
    h.run()

    assert h.engine.result == "success"
    assert h.engine.variables.get("次数") == 3
    assert any(call == "action_executed" for call in (event["type"] for event in h.engine.trace.recent_events()))


def test_setvar_accepts_ref_objects_and_creates_undefined_variable(tmp_path: Path, clock: Clock) -> None:
    """`{"$expr":…}` / `{"$var":…}` 等价写法；没定义的变量按值类型自动建。"""
    h = Harness(
        [
            step("s1", "manual"),
            step("a", "setvar", name="名字", value="阿黄"),
            step("b", "setvar", name="称呼", value={"$var": "名字"}),
            step("c", "setvar", name="等级", value={"$expr": "1 + 2"}),
        ],
        tmp_path,
    )
    h.run()

    assert h.engine.result == "success"
    assert h.engine.variables.get("称呼") == "阿黄"
    assert h.engine.variables.get("等级") == 3


def test_setvar_without_name_fails_the_chain(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [
            step("s1", "manual"),
            step("bad", "setvar", name="  ", value="1"),
            step("after", "key", value="back"),
        ],
        tmp_path,
    )
    h.run()

    assert h.engine.result == "failure"
    finished = next(e for e in reversed(h.engine.trace.recent_events()) if e["type"] == "flow_finished")
    assert "赋值" in str(finished["message"])
    assert h.controller.calls == []


def test_evidence_records_steps_params_and_durations(tmp_path: Path, clock: Clock) -> None:
    """挂上证据目录后：每步都有记录，事件里能看到参数与耗时（排查靠它）。"""
    h = Harness([step("s1", "manual"), step("s2", "setvar", name="次数", value="1")], tmp_path)
    evidence = RunEvidence(tmp_path, stamp="20261018-210000")
    h.engine.attach_evidence(evidence)
    h.engine.start()
    h.run()
    closed = h.engine.close_evidence()

    assert closed is evidence
    bundle = evidence.to_dict()
    assert [item["stepId"] for item in bundle["steps"]] == ["s1", "s2"]
    assert bundle["dir"] == str(Path(".runs") / "20261018-210000")
    events = evidence.dir.joinpath("trace.jsonl").read_text(encoding="utf-8").splitlines()
    assert any('"type": "step_started"' in line for line in events)
    started = next(e for e in h.engine.trace.recent_events() if e["type"] == "step_started")
    assert started["extra"]["index"] == 1
    assert "params" in started["extra"]
    finished = next(e for e in h.engine.trace.recent_events() if e["type"] == "step_finished")
    assert isinstance(finished["extra"]["durationMs"], int)
    assert h.engine.evidence is None


def test_evidence_keeps_the_failure_step_and_reason(tmp_path: Path, clock: Clock) -> None:
    h = Harness(
        [step("s1", "manual"), step("s2", "click", by="随机范围", x=0.5, y=0.5)],
        tmp_path,
    )
    evidence = RunEvidence(tmp_path, stamp="20261018-210001")
    h.engine.attach_evidence(evidence)
    h.engine.start()
    h.run()
    h.engine.close_evidence()

    bundle = evidence.to_dict()
    failed = bundle["steps"][-1]
    assert failed["stepId"] == "s2"
    assert failed["kind"] == "click"
    assert "框选范围" in failed["message"]
    assert h.engine.result == "failure"


def test_wait_timeout_message_includes_best_score(tmp_path: Path, clock: Clock) -> None:
    """等待超时的失败原因要能自解释：当帧最高分 vs 阈值，不用再去翻识别器设置。"""
    h = Harness(
        [step("t", "manual"), step("w", "wait", rec="主城", stable_frames=1, timeout_ms=1000)],
        tmp_path,
        hits={"主城": Detection("主城", Rect(0.2, 0.2, 0.1, 0.1), score=0.61, state="pending")},
    )
    h.tick()
    clock.advance(2.0)
    h.tick()

    assert h.engine.result == "failure"
    finished = next(e for e in reversed(h.engine.trace.recent_events()) if e["type"] == "flow_finished")
    assert "0.61" in finished["message"]
    # 颜色识别器没有 threshold 字段：退化成"未达命中条件"，模板识别器才报"< 阈值"
    assert "未达命中条件" in finished["message"]


def test_retry_interval_ms_waits_before_the_retry(tmp_path: Path, clock: Clock) -> None:
    """`retry_interval_ms` 以前没有消费方：设了它必须真的等够时间才重试，不然就是空转的滑块。"""

    class FlakyClick(FakeController):
        def click(self, x: float, y: float) -> None:
            self.calls.append(("click", round(x, 3), round(y, 3)))
            if len(self.calls) == 1:
                raise ValueError("first click fails")

    steps = [
        step("s1", "manual"),
        step("s2", "click", by="坐标", x=0.5, y=0.5),
        step("s3", "key", value="back"),
    ]
    h = Harness(
        steps,
        tmp_path,
        defaults={"on_step_error": "retry", "step_retries": 1, "retry_interval_ms": 2000},
    )
    flaky = FlakyClick()
    h.engine.controller = flaky  # type: ignore[assignment]

    h.tick()
    assert h.engine.result == "running"
    assert flaky.calls == [("click", 0.5, 0.5)]  # 只失败一次，还没到重试时间

    h.tick()
    assert flaky.calls == [("click", 0.5, 0.5)]  # 同一拍内也不许立刻重试

    clock.advance(2.0)
    h.run()
    assert h.engine.result == "success"
    assert flaky.calls == [("click", 0.5, 0.5), ("click", 0.5, 0.5), ("press", "back")]


def test_end_step_stops_the_chain_instead_of_walking_the_step_after_the_block(tmp_path: Path, clock: Clock) -> None:
    """「结束」= 这一支到此为止（Python 的 return）：块后第一步不能再跑。

    没有它时，条件块后面的步骤是所有分支尾巴的公共后续，于是"这一支做完就结束"表达不出来。
    """
    chain = [
        step("s1", "manual"),
        step("s2", "cond", rec="主城"),
        step("s3", "click", by="坐标", x=0.1, y=0.1),
        step("s4", "end"),
        step("s5", "else"),
        step("s6", "click", by="坐标", x=0.2, y=0.2),
        step("s7", "condend", back="s2"),
        step("s8", "click", by="坐标", x=0.3, y=0.3),
    ]

    hit_case = Harness(chain, tmp_path, hits=hits("主城"))
    hit_case.run()
    assert hit_case.controller.calls == [("click", 0.1, 0.1)]
    assert hit_case.engine.result == "success"

    miss_case = Harness(chain, tmp_path)
    miss_case.run()
    assert miss_case.controller.calls == [("click", 0.2, 0.2), ("click", 0.3, 0.3)]
    assert miss_case.engine.result == "success"
