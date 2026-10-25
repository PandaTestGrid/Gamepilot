"""端到端：把**步骤链**存进 graph.json，再用 `run.start` 让引擎按它跑。

覆盖「脚本栏编排 → 保存 → 运行」这条新路径（和状态机那条 `test_rpc_session` 并列）：
前端存的是 `flow.steps`，引擎必须真的按顺序执行，并把结果通过 `run.stopped` 报回来。

注意这里的工作流**一个界面节点都没有** —— 纯步骤链也得能跑（`_loop` 的门槛不能只看 nodes）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from test_rpc_session import DEVICE_ID, DEVICE_URI, EngineProcess


def step(step_id: str, kind: str, **params: Any) -> dict[str, Any]:
    return {"id": step_id, "type": kind, "params": params}


#: 一个**存在但永远不会命中**的识别器（min_pixels 大到任何一帧都不可能满足）。
#: 校验要求 wait/cond 引用的识别器必须存在，所以不能编一个不存在的标签。
NEVER_HITS = {
    "type": "color",
    "roi": [0.4, 0.4, 0.2, 0.2],
    "target_bgr": [0, 0, 0],
    "tolerance": 1,
    "min_pixels": 999_999,
}


def save_flow(
    engine: EngineProcess,
    steps: list[dict[str, Any]],
    recognizers: dict[str, Any] | None = None,
) -> None:
    """把当前图的 flow 段换掉再存回去（模拟前端「保存修改」）。"""
    current = engine.call("graph.get", {})
    payload = current["graph"] if isinstance(current.get("graph"), dict) else current
    engine.call(
        "graph.save",
        {
            "graph": {
                **payload,
                "recognizers": {**payload.get("recognizers", {}), **(recognizers or {})},
                "flow": {"steps": steps},
            }
        },
    )


def step_order(engine: EngineProcess) -> list[str]:
    return [
        str(message["params"].get("message", ""))
        for message in engine.seen
        if message.get("method") == "engine.event" and message["params"].get("type") == "step_started"
    ]


def test_saved_step_chain_runs_in_order_over_stdio(tmp_path: Path) -> None:
    engine = EngineProcess(str(tmp_path))
    try:
        engine.call("device.connect", {"uri": DEVICE_URI})
        save_flow(
            engine,
            [
                step("s1", "manual"),
                step("s2", "click", by="coord", x=0.3, y=0.4),
                step("s3", "key", value="back"),
            ],
        )

        engine.call("run.start", {"deviceId": DEVICE_ID})
        stopped = engine.wait_for(lambda message: message.get("method") == "run.stopped")
        assert stopped["params"]["result"] == "success", stopped

        assert step_order(engine) == ["第 1 步 · manual", "第 2 步 · click", "第 3 步 · key"]
        status = engine.call("device.status", {"deviceId": DEVICE_ID})
        # 引擎真的把动作发出去了（三个动作，不是"跑完了但什么都没做"）
        assert status["stats"]["actions"] == 2
        assert status["running"] is False
    finally:
        engine.close()


def test_wait_step_times_out_and_reports_failure(tmp_path: Path) -> None:
    """等一个永远不出现的界面 → 明确失败，而且**不会**继续往下点。"""
    engine = EngineProcess(str(tmp_path))
    try:
        engine.call("device.connect", {"uri": DEVICE_URI})
        save_flow(
            engine,
            [
                step("s1", "manual"),
                step("s2", "wait", rec="永不命中", stable_frames=1, timeout_ms=200),
                step("s3", "key", value="back"),
            ],
            {"永不命中": NEVER_HITS},
        )

        engine.call("run.start", {"deviceId": DEVICE_ID})
        stopped = engine.wait_for(lambda message: message.get("method") == "run.stopped")
        assert stopped["params"]["result"] == "failure", stopped

        kinds = [
            str(message["params"].get("type")) for message in engine.seen if message.get("method") == "engine.event"
        ]
        # 等到第 2 步就停了：第 3 步一次都没开始
        assert "step_started" in kinds
        assert kinds.count("step_started") == 2
        status = engine.call("device.status", {"deviceId": DEVICE_ID})
        assert status["stats"]["actions"] == 0
    finally:
        engine.close()


def test_graph_save_rejects_a_chain_that_breaks_the_rules(tmp_path: Path) -> None:
    """坏链在保存时就报错（报错信息要指得出哪一步），别等跑起来才发现。"""
    engine = EngineProcess(str(tmp_path))
    try:
        current = engine.call("graph.get", {})
        payload = current["graph"] if isinstance(current.get("graph"), dict) else current
        bad = {**payload, "flow": {"steps": [step("s1", "click", x=0.5, y=0.5)]}}
        response = engine.send("graph.save", {"graph": bad})
        message = engine.wait_for(lambda item: item.get("id") == response)
        assert "error" in message
        assert "第一步必须是触发器" in message["error"]["message"]
    finally:
        engine.close()


def test_graph_save_rejected_while_flow_is_running(tmp_path: Path) -> None:
    """运行中改图会热重载丢掉步骤指针，保存必须被拒绝。"""
    engine = EngineProcess(str(tmp_path))
    try:
        engine.call("device.connect", {"uri": DEVICE_URI})
        save_flow(engine, [step("s1", "manual"), step("s2", "delay", ms=600_000)])
        engine.call("run.start", {"deviceId": DEVICE_ID})
        engine.wait_for(
            lambda message: (
                message.get("method") == "engine.event"
                and message["params"].get("type") == "step_started"
                and "delay" in str(message["params"].get("message", ""))
            )
        )

        current = engine.call("graph.get", {})
        payload = current["graph"] if isinstance(current.get("graph"), dict) else current
        response = engine.send(
            "graph.save",
            {
                "graph": {
                    **payload,
                    "flow": {"steps": [step("s1", "manual"), step("s2", "delay", ms=1)]},
                }
            },
        )
        message = engine.wait_for(lambda item: item.get("id") == response)
        assert "error" in message
        assert "运行中不能修改流程图" in message["error"]["message"]

        status = engine.call("device.status", {"deviceId": DEVICE_ID})
        assert status["running"] is True
        assert not any(item.get("method") == "run.stopped" for item in engine.seen)
    finally:
        engine.close()


def test_two_devices_can_run_the_same_flow(tmp_path: Path) -> None:
    """同一份脚本可以同时在两台设备上跑；第二台开跑不能再走 graph.save。"""
    engine = EngineProcess(str(tmp_path))
    other_uri = "Synthetic:///?serial=test-2&width=640&height=360"
    other_id = "synthetic:test-2"
    try:
        engine.call("device.connect", {"uri": DEVICE_URI})
        second = engine.call("device.connect", {"uri": other_uri})
        assert second["deviceId"] == other_id
        save_flow(engine, [step("s1", "manual"), step("s2", "delay", ms=600_000)])
        engine.call("run.start", {"deviceId": DEVICE_ID})
        engine.call("run.start", {"deviceId": other_id})
        assert engine.call("device.status", {"deviceId": DEVICE_ID})["running"] is True
        assert engine.call("device.status", {"deviceId": other_id})["running"] is True
    finally:
        engine.close()


def test_switching_project_does_not_stop_a_running_flow(tmp_path: Path) -> None:
    """切工作流目录（project.set）时正在跑的步骤链不能停。"""
    engine = EngineProcess(str(tmp_path))
    try:
        engine.call("device.connect", {"uri": DEVICE_URI})
        save_flow(engine, [step("s1", "manual"), step("s2", "delay", ms=600_000)])
        engine.call("run.start", {"deviceId": DEVICE_ID})
        engine.wait_for(
            lambda message: (
                message.get("method") == "engine.event"
                and message["params"].get("type") == "step_started"
                and "delay" in str(message["params"].get("message", ""))
            )
        )

        other = tmp_path / "other-script"
        engine.call("project.set", {"dir": str(other)})
        status = engine.call("device.status", {"deviceId": DEVICE_ID})
        assert status["running"] is True
        assert not any(message.get("method") == "run.stopped" for message in engine.seen)
    finally:
        engine.close()


def test_condition_branch_over_stdio(tmp_path: Path) -> None:
    """条件不成立 → 只走「否则」那一支，成立那一支一步都不跑；两支在「条件结束」后汇合。"""
    engine = EngineProcess(str(tmp_path))
    try:
        engine.call("device.connect", {"uri": DEVICE_URI})
        save_flow(
            engine,
            [
                step("s1", "manual"),
                step("c", "cond", rec="永不命中"),
                step("t1", "key", value="back"),  # 成立那一支
                step("e", "else"),
                step("f1", "key", value="home"),  # 否则那一支
                step("ce", "condend", back="c"),
                step("after", "key", value="recents"),
            ],
            {"永不命中": NEVER_HITS},
        )
        engine.call("run.start", {"deviceId": DEVICE_ID})
        stopped = engine.wait_for(lambda message: message.get("method") == "run.stopped")
        assert stopped["params"]["result"] == "success", stopped

        started = step_order(engine)
        assert "第 5 步 · key" in started  # 走了「否则」那一支
        assert "第 3 步 · key" not in started  # 成立那一支没跑
        assert "第 7 步 · key" in started  # 汇合之后继续
        status = engine.call("device.status", {"deviceId": DEVICE_ID})
        assert status["stats"]["actions"] == 2  # f1 + after
    finally:
        engine.close()


def test_breakpoint_pauses_then_step_advances_one_step(tmp_path: Path) -> None:
    """端到端：断点停下 → 单步走一步（并再停）→ 继续跑到链尾。"""
    engine = EngineProcess(str(tmp_path))
    try:
        engine.call("device.connect", {"uri": DEVICE_URI})
        save_flow(
            engine,
            [
                step("s1", "manual"),
                step("s2", "click", by="coord", x=0.3, y=0.4),
                step("s3", "key", value="back"),
            ],
        )
        engine.call("run.breakpoint", {"deviceId": DEVICE_ID, "edgeId": "s2", "enabled": True})

        engine.call("run.start", {"deviceId": DEVICE_ID})
        hit = engine.wait_for(
            lambda message: (
                message.get("method") == "engine.event" and message["params"].get("type") == "breakpoint_hit"
            )
        )
        assert hit["params"]["node"] == "s2", hit
        assert step_order(engine) == ["第 1 步 · manual"], "断点命中前只该跑过第 1 步"

        # 单步：放行 s2；执行完、进入 s3 之前再停
        engine.call("run.step", {"deviceId": DEVICE_ID})
        again = engine.wait_for(
            lambda message: (
                message.get("method") == "engine.event"
                and message["params"].get("type") == "breakpoint_hit"
                and message["params"].get("node") == "s3"
            )
        )
        assert again["params"]["node"] == "s3"
        assert step_order(engine) == ["第 1 步 · manual", "第 2 步 · click"]

        engine.call("run.resume", {"deviceId": DEVICE_ID})
        stopped = engine.wait_for(lambda message: message.get("method") == "run.stopped")
        assert stopped["params"]["result"] == "success", stopped
        assert step_order(engine) == [
            "第 1 步 · manual",
            "第 2 步 · click",
            "第 3 步 · key",
        ]
    finally:
        engine.close()


def test_run_records_evidence_over_stdio(tmp_path: Path) -> None:
    """跑完一次，`run.evidence` 要给到每步的记录与截图，`evidence.image` 能取到图。

    这条覆盖 A3 的完整链路：引擎落盘 → RPC 读回 → 前端「运行记录」面板要的数据。
    """
    engine = EngineProcess(str(tmp_path))
    try:
        engine.call("device.connect", {"uri": DEVICE_URI})
        save_flow(
            engine,
            [
                step("s1", "manual"),
                step("s2", "click", by="coord", x=0.3, y=0.4),
            ],
        )

        engine.call("run.start", {"deviceId": DEVICE_ID})
        stopped = engine.wait_for(lambda message: message.get("method") == "run.stopped")
        assert stopped["params"]["result"] == "success", stopped

        bundle = engine.call("run.evidence", {"deviceId": DEVICE_ID})["evidence"]
        assert bundle is not None, "跑完应当留下证据目录"
        assert str(bundle["dir"]).startswith(".runs")
        assert [item["stepId"] for item in bundle["steps"]] == ["s1", "s2"]

        click_record = bundle["steps"][1]
        assert click_record["kind"] == "click"
        assert click_record["params"] == {"by": "coord", "x": 0.3, "y": 0.4}
        assert isinstance(click_record["durationMs"], int)

        shot = next(item["screenshot"] for item in bundle["steps"] if item["screenshot"])
        image = engine.call("evidence.image", {"deviceId": DEVICE_ID, "name": shot})
        assert len(str(image["jpeg"])) > 100

        # 事件流里也带着参数与耗时（控制台/日志用同一份数据）
        started = [
            message["params"]["extra"]
            for message in engine.seen
            if message.get("method") == "engine.event" and message["params"].get("type") == "step_started"
        ]
        assert started[0]["kind"] == "manual"
        assert "params" in started[1]

        timeline = engine.call("timeline.get", {"deviceId": DEVICE_ID, "limit": 10})
        assert timeline["evidence"]["dir"] == bundle["dir"]
    finally:
        engine.close()
