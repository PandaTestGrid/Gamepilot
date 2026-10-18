"""「调用工作流」必须在后台跑起来，但不能把当前画布切走。"""

from __future__ import annotations

import json
import time
from pathlib import Path

from gamepilot.core.frame import Frame
from gamepilot.devices.synthetic_test import SyntheticController
from gamepilot.project import Project
from gamepilot.rpc.session import SessionManager
from gamepilot.session import DeviceSession


def _write_flow(root: Path, steps: list[dict]) -> Path:
    (root / "templates").mkdir(parents=True, exist_ok=True)
    (root / "graph.json").write_text(
        json.dumps({"defaults": {"evidence": False}, "recognizers": {}, "flow": {"steps": steps}}, ensure_ascii=False),
        encoding="utf-8",
    )
    return root


def test_call_workflow_starts_target_without_switching_canvas(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    main = _write_flow(
        workspace / "主流程",
        [
            {"id": "trigger", "type": "manual"},
            {"id": "s2", "type": "call", "params": {"name": "组队"}},
        ],
    )
    target = _write_flow(
        workspace / "组队",
        [
            {"id": "trigger", "type": "manual"},
            {"id": "t2", "type": "delay", "params": {"ms": 5000}},
        ],
    )
    events: list[tuple[str, dict]] = []
    manager = SessionManager(lambda method, params: events.append((method, params)))
    manager.project = Project(root=str(main)).ensure()
    controller = SyntheticController()
    session = DeviceSession("synthetic:test-call", controller, manager.project, manager.emit)
    manager.sessions[session.device_id] = session

    session.start_run()  # 先把主流程跑起来
    assert session._root_busy(str(main)) is True
    # 手动把游标放到 call 这一步，模拟引擎已经在执行调用
    session.engine.cursor = 1
    session.engine.current = "s2"

    manager._call_workflow(session, "组队", str(main))

    assert session.project.root == str(main), "调用不能把当前画布切到目标工作流"
    assert session._root_busy(str(main)) is True, "主链只是挂起，不是结束"
    main_runner = session.runners[session._root_key(str(main))]
    assert main_runner.engine.waiting is True, "主链要等子链跑完再继续"
    assert main_runner.engine.cursor == 2, "游标已推进到 call 的下一条"
    assert session._root_busy(str(target)) is True
    target_runner = session.runners[session._root_key(str(target))]
    assert target_runner.engine.result == "running"
    assert [step["id"] for step in target_runner.engine.steps] == ["trigger", "t2"]
    assert [m for m, _ in events if m == "run.started"][-1] == "run.started"


def test_call_step_from_engine_starts_target(tmp_path: Path) -> None:
    """从引擎 tick 里走 call 动作（真实回调路径），目标工作流必须真的开跑。"""
    workspace = tmp_path / "workspace"
    main = _write_flow(
        workspace / "主流程",
        [
            {"id": "trigger", "type": "manual"},
            {"id": "s2", "type": "call", "params": {"name": "组队"}},
        ],
    )
    target = _write_flow(
        workspace / "组队",
        [
            {"id": "trigger", "type": "manual"},
            {"id": "t2", "type": "delay", "params": {"ms": 5000}},
        ],
    )
    manager = SessionManager(lambda _method, _params: None)
    manager.project = Project(root=str(main)).ensure()
    controller = SyntheticController()
    session = DeviceSession("synthetic:test-call-tick", controller, manager.project, manager.emit)
    manager.sessions[session.device_id] = session
    session.on_call_script = lambda name: manager._call_workflow(session, name)

    session.start_run()
    image = controller.screenshot()
    for index in range(5):
        session.engine.tick(Frame(image=image, size=controller.resolution, index=index + 1))
        if session._root_busy(str(target)):
            break

    assert session.project.root == str(main), "调用不能把当前画布切到目标工作流"
    assert session._root_busy(str(main)) is True, "主链只是挂起，不是结束"
    main_runner = session.runners[session._root_key(str(main))]
    assert main_runner.engine.waiting is True
    assert session._root_busy(str(target)) is True
    target_runner = session.runners[session._root_key(str(target))]
    assert target_runner.engine.result == "running"


def test_call_workflow_resumes_caller_after_target_finishes(tmp_path: Path) -> None:
    """A 调用 B：B 跑完后 A 从 call 的下一条继续，而不是整条 A 断开。"""
    workspace = tmp_path / "workspace"
    main = _write_flow(
        workspace / "主流程",
        [
            {"id": "trigger", "type": "manual"},
            {"id": "s2", "type": "call", "params": {"name": "组队"}},
            {"id": "s3", "type": "delay", "params": {"ms": 0}},
        ],
    )
    target = _write_flow(
        workspace / "组队",
        [
            {"id": "trigger", "type": "manual"},
            {"id": "t2", "type": "delay", "params": {"ms": 0}},
        ],
    )
    manager = SessionManager(lambda _method, _params: None)
    manager.project = Project(root=str(main)).ensure()
    controller = SyntheticController()
    session = DeviceSession("synthetic:test-call-resume", controller, manager.project, manager.emit)
    manager.sessions[session.device_id] = session
    session.on_call_script = lambda name: manager._call_workflow(
        session, name, session._ticking_root or session.project.root
    )

    session.start()
    try:
        session.start_run()
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline and session.engine.result == "running":
            time.sleep(0.02)
        assert session.engine.result == "success", "子链跑完后主链应继续并正常结束"
        assert session._root_busy(str(target)) is False
        assert session._root_busy(str(main)) is False
        assert session.subflow_parent == {}
    finally:
        session.stop()


def test_nested_call_resumes_each_parent(tmp_path: Path) -> None:
    """A→B→C：C 完后回 B，B 完后回 A；caller root 必须取正在 tick 的 runner。"""
    workspace = tmp_path / "workspace"
    main = _write_flow(
        workspace / "主流程",
        [
            {"id": "trigger", "type": "manual"},
            {"id": "s2", "type": "call", "params": {"name": "中级"}},
            {"id": "s3", "type": "delay", "params": {"ms": 0}},
        ],
    )
    middle = _write_flow(
        workspace / "中级",
        [
            {"id": "trigger", "type": "manual"},
            {"id": "m2", "type": "call", "params": {"name": "底层"}},
            {"id": "m3", "type": "delay", "params": {"ms": 0}},
        ],
    )
    leaf = _write_flow(
        workspace / "底层",
        [
            {"id": "trigger", "type": "manual"},
            {"id": "t2", "type": "delay", "params": {"ms": 0}},
        ],
    )
    manager = SessionManager(lambda _method, _params: None)
    manager.project = Project(root=str(main)).ensure()
    controller = SyntheticController()
    session = DeviceSession("synthetic:test-call-nested", controller, manager.project, manager.emit)
    manager.sessions[session.device_id] = session
    session.on_call_script = lambda name: manager._call_workflow(
        session, name, session._ticking_root or session.project.root
    )

    session.start()
    try:
        session.start_run()
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline and session.engine.result == "running":
            time.sleep(0.02)
        assert session.engine.result == "success"
        assert session._root_busy(str(leaf)) is False
        assert session._root_busy(str(middle)) is False
        assert session.subflow_parent == {}
    finally:
        session.stop()


def test_failed_target_stops_caller_with_reason(tmp_path: Path) -> None:
    """B 失败时 A 不能继续跑，A 以 failure 结束并带上 B 的原因。"""
    workspace = tmp_path / "workspace"
    main = _write_flow(
        workspace / "主流程",
        [
            {"id": "trigger", "type": "manual"},
            {"id": "s2", "type": "call", "params": {"name": "会失败"}},
            {"id": "s3", "type": "delay", "params": {"ms": 0}},
        ],
    )
    target = _write_flow(
        workspace / "会失败",
        [
            {"id": "trigger", "type": "manual"},
            {"id": "t2", "type": "cond", "params": {"rec": "永远不存在的模板"}},
        ],
    )
    manager = SessionManager(lambda _method, _params: None)
    manager.project = Project(root=str(main)).ensure()
    controller = SyntheticController()
    session = DeviceSession("synthetic:test-call-fail", controller, manager.project, manager.emit)
    manager.sessions[session.device_id] = session
    session.on_call_script = lambda name: manager._call_workflow(
        session, name, session._ticking_root or session.project.root
    )

    session.start()
    try:
        session.start_run()
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline and session.engine.result == "running":
            time.sleep(0.02)
        assert session.engine.result == "failure"
        assert session._root_busy(str(target)) is False
        assert session.subflow_parent == {}
    finally:
        session.stop()
