"""会话层的触发器：连上就排期、到点自动开跑（Mock 设备即可，不需要真机）。

不在这里真的等 30 分钟：把 _auto_at 拨到过去，直接问 _maybe_auto_run。
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest

from gamepilot.devices.synthetic_test import SyntheticController
from gamepilot.project import Project
from gamepilot.session import DeviceSession


def _wait(predicate: Any, timeout: float = 3.0, interval: float = 0.05) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


@pytest.fixture()
def session(tmp_path: Path) -> Any:
    events: list[tuple[str, dict[str, Any]]] = []
    controller = SyntheticController()
    controller.connect()
    instance = DeviceSession(
        "synthetic:test-1",
        controller,
        Project(root=str(tmp_path)).ensure(),
        lambda method, params: events.append((method, params)),
        fps=20.0,
    )
    instance.events = events  # type: ignore[attr-defined]
    instance.set_stream_fps(20.0)  # 界面要帧才推；这里要验帧里的 node 字段
    instance.start()
    yield instance
    instance.stop()


def _set_flow(session: DeviceSession, steps: list[dict[str, Any]]) -> None:
    """换一份带步骤链的图（走真实的 save_graph → reload_graph → 重新排期）。"""
    graph = session.graph.to_dict()
    graph["flow"] = {"steps": steps}
    session.save_graph(graph)


def _blocking_flow(trigger: dict[str, Any]) -> list[dict[str, Any]]:
    """触发器后面接一个很长的延时：跑起来后停在链条中间，好断言它在跑。"""
    return [trigger, {"id": "d", "type": "delay", "params": {"ms": 600_000}}]


def test_interval_trigger_arms_then_auto_runs(session: DeviceSession) -> None:
    _set_flow(session, _blocking_flow({"id": "t", "type": "interval", "params": {"every": 30}}))
    assert session._auto_at is not None, "interval 触发器应当排期"
    assert not session.running

    session._auto_at = time.time() - 1  # 拨到过去 = 到点了
    session._maybe_auto_run()

    assert session.running, "到点应当自动开跑"
    assert session._auto_at is not None, "自动触发后应排下一次"
    session.stop_run()
    assert session._auto_at is None, "用户手动停止必须同时取消下一次自动触发，不能自行复活"


def test_manual_trigger_never_auto_runs(session: DeviceSession) -> None:
    _set_flow(session, [{"id": "t", "type": "manual", "params": {}}])
    assert session._auto_at is None
    session._maybe_auto_run()
    assert not session.running  # 手动触发器只在点了运行之后才跑


def test_schedule_trigger_arms(session: DeviceSession) -> None:
    _set_flow(session, [{"id": "t", "type": "schedule", "params": {"at": "06:00"}}])
    assert session._auto_at is not None, "定时开始应当排期"


def _frames(session: DeviceSession) -> list[dict[str, Any]]:
    """推给界面的帧通知（node 字段就是界面拿去做「跑到哪一步」高亮的那个值）。"""
    return [params for method, params in session.events if method == "engine.frame"]  # type: ignore[attr-defined]


def test_running_flow_reports_the_current_step_id_in_frames(session: DeviceSession) -> None:
    """跑起来后，每帧的 node 必须是**当前步骤 id** —— 前端就是靠它高亮「跑到第几步」。"""
    _set_flow(session, _blocking_flow({"id": "t", "type": "manual", "params": {}}))
    # 采集与识别独立，须等新图的帧状态，而不是误读切图前已交付的第一帧。
    assert _wait(lambda: _frames(session) and _frames(session)[-1].get("node") == "t")

    session.start_run()
    # 跑起来就前进到延时那一步，帧里的 node 跟着变成那一步的 id
    assert _wait(lambda: any(f.get("node") == "d" for f in _frames(session))), "帧应当报出当前步骤 id"
    session.stop_run()


def test_switching_workflow_does_not_stop_running_flow(session: DeviceSession, tmp_path: Path) -> None:
    """切到另一份工作流（Tab / 工作区）时，正在跑的步骤链必须继续，不能重建执行器。"""
    _set_flow(session, _blocking_flow({"id": "t", "type": "manual", "params": {}}))
    session.start_run()
    assert _wait(lambda: session.engine.result == "running" and session.engine.current == "d")
    engine_id = id(session.engine)
    cursor = session.engine.cursor

    other = tmp_path / "other-flow"
    other.mkdir()
    (other / "graph.json").write_text(
        json.dumps(
            {
                "version": 1,
                "defaults": {},
                "recognizers": {},
                "nodes": [],
                "edges": [],
                "flow": {"steps": [{"id": "x", "type": "manual", "params": {}}]},
            }
        ),
        encoding="utf-8",
    )
    original = session._root_key(str(tmp_path))
    session.project = Project(root=str(other)).ensure()
    session.reload_graph()

    assert session.running
    assert session._root_busy(original)
    running_engine = session.runners[original].engine
    assert id(running_engine) == engine_id, "切走不能拆掉正在跑的执行器"
    assert running_engine.cursor == cursor
    assert running_engine.current == "d"
    assert session.engine is not running_engine, "当前 Tab 应换到新开的那份图"

    session.stop_run()
    assert session._root_busy(original), "停当前这份（没在跑）不能把另一份一起停掉"
    session.stop_run(original)
    assert not session.running


def test_two_workflows_run_independently(session: DeviceSession, tmp_path: Path) -> None:
    """两份工作流可以同时跑；停其中一份，另一份继续。"""
    _set_flow(session, _blocking_flow({"id": "t", "type": "manual", "params": {}}))
    session.start_run()
    original = session._root_key(session.project.root)
    assert session._root_busy(original)

    other = tmp_path / "other-flow"
    other.mkdir()
    (other / "graph.json").write_text(
        json.dumps(
            {
                "version": 1,
                "defaults": {},
                "recognizers": {},
                "nodes": [],
                "edges": [],
                "flow": {
                    "steps": [
                        {"id": "x", "type": "manual", "params": {}},
                        {"id": "y", "type": "delay", "params": {"ms": 600_000}},
                    ]
                },
            }
        ),
        encoding="utf-8",
    )
    session.project = Project(root=str(other)).ensure()
    session.reload_graph()
    session.start_run()
    other_key = session._root_key(str(other))

    assert session._root_busy(original)
    assert session._root_busy(other_key)

    session.stop_run(original)
    assert not session._root_busy(original)
    assert session._root_busy(other_key)
    assert session.running

    session.stop_run(other_key)
    assert not session.running


def _set_flow_with_defaults(session: DeviceSession, steps: list[dict[str, Any]], **defaults: Any) -> None:
    graph = session.graph.to_dict()
    graph["flow"] = {"steps": steps}
    graph.setdefault("defaults", {}).update(defaults)
    session.save_graph(graph)


def test_run_records_evidence_with_step_screenshots(session: DeviceSession) -> None:
    """跑完一次，界面要能拿到"每步一张图 + 每步参数"（这就是"失败回放"的底座）。"""
    _set_flow(
        session,
        [
            {"id": "t", "type": "manual", "params": {}},
            {"id": "v", "type": "setvar", "params": {"name": "次数", "value": "1"}},
        ],
    )
    session.start_run()
    assert _wait(lambda: not session.running), "两步的链应当很快跑完"

    bundle = session.evidence_bundle()
    assert bundle is not None, "跑完应当留下证据目录"
    assert bundle["dir"].startswith(".runs")
    assert [item["stepId"] for item in bundle["steps"]] == ["t", "v"]
    names = [item["screenshot"] for item in bundle["steps"] if item["screenshot"]]
    assert names, "每步都要有截图（合成本机画面也能截）"
    assert session.evidence_image(names[0]) is not None

    finished = next(event for event in reversed(session.trace.recent_events()) if event["type"] == "flow_finished")
    assert finished["extra"]["result"] == "success"
    assert isinstance(finished["extra"]["durationMs"], int)
    started = next(event for event in session.trace.recent_events() if event["type"] == "step_started")
    assert started["extra"]["kind"] == "manual"


def test_evidence_can_be_switched_off_in_graph_defaults(session: DeviceSession) -> None:
    _set_flow_with_defaults(
        session,
        [{"id": "t", "type": "manual", "params": {}}],
        evidence=False,
    )
    session.start_run()
    assert _wait(lambda: not session.running)
    assert session.evidence_bundle() is None
