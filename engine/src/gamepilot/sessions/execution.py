"""ExecutionService: extracted session responsibility; shared state belongs to DeviceSession."""

from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from ..core.evidence import RunEvidence
from ..core.flow_engine import FlowEngine
from ..core.flow_model import validate_flow
from ..core.flow_trigger import auto_trigger, next_fire_at
from ..core.frame import Frame
from ..core.graph import Graph
from ..core.state_machine import Engine
from ..library import norm_path
from ..project import Project

if TYPE_CHECKING:
    from .device import DeviceSession

from .models import WorkflowRunner, _load_graph, describe_graph_error, flow_steps

logger = logging.getLogger("gamepilot.session")


class ExecutionService:
    def __init__(self, session: DeviceSession) -> None:
        self.session = session

    def _execution_loop(self) -> None:
        """单设备唯一执行 owner；慢识别/动作只覆盖待处理帧，不阻塞采集。"""
        consumed = 0
        while not self.session._stop.is_set():
            with self.session._frame_ready:
                while not self.session._stop.is_set() and (
                    self.session._latest_frame is None or self.session._latest_frame.index <= consumed
                ):
                    self.session._frame_ready.wait()
                if self.session._stop.is_set():
                    return
                frame = self.session._latest_frame
            assert frame is not None
            self.session._execution_dropped += max(0, frame.index - consumed - 1)
            consumed = frame.index
            started = time.perf_counter()
            try:
                with self.session._execution_lock:
                    self.session._execute_frame(frame)
            except Exception:
                logger.exception("执行线程处理帧失败（投屏继续）: %s", self.session.device_id)
            self.session._execution_ms = (time.perf_counter() - started) * 1000
            self.session._execution_frames += 1
            self.session._execution_index = frame.index

    def _execute_frame(self, frame: Frame) -> None:
        with self.session.lock:
            busy = [runner for runner in self.session.runners.values() if self.session._runner_tickable(runner)]
            viewed = self.session.engine
        viewed_ticked = False
        viewed_frame = frame
        for runner in busy:
            with self.session.lock:
                if (
                    self.session._stop.is_set()
                    or runner.cancelled
                    or self.session.runners.get(runner.root) is not runner
                ):
                    continue
                runner.inflight = True
            # 其它工作流的动作也不能让下一份工作流复用动作前的旧截图。
            latest = self.session._latest_frame
            work_frame = latest if latest is not None and latest.index > frame.index else frame
            self.session._ticking_root = runner.root
            self.session._ticking_engine = runner.engine
            try:
                if work_frame.index <= runner.last_index:
                    continue
                if not self.session._manual_touch:
                    runner.last_index = work_frame.index
                    if runner.engine is viewed:
                        viewed_frame = work_frame
                    if isinstance(runner.engine, FlowEngine):
                        if not runner.cancelled and not self.session._stop.is_set():
                            runner.engine.tick(work_frame)
                    else:
                        with self.session._input_lock:
                            if (
                                not self.session._manual_touch
                                and not runner.cancelled
                                and not self.session._stop.is_set()
                            ):
                                runner.engine.tick(work_frame)
                    viewed_ticked |= runner.engine is viewed
            except Exception as error:
                logger.exception("工作流执行异常: %s", runner.root)
                if isinstance(runner.engine, FlowEngine):
                    runner.engine.fail_from_subflow(f"执行异常：{error}")
                else:
                    runner.cancelled = True
            finally:
                self.session._ticking_root = ""
                self.session._ticking_engine = None
                with self.session.lock:
                    runner.inflight = False
                    retired = runner.cancelled or self.session.runners.get(runner.root) is not runner
                if retired:
                    with self.session._lifecycle_lock:
                        self.session._collect_evidence(runner.root, runner.engine)
            if retired:
                continue
            if isinstance(runner.engine, FlowEngine) and runner.engine.result != "running":
                with self.session._lifecycle_lock:
                    finished = [(runner.root, str(runner.engine.result))]
                    while finished:
                        root, result = finished.pop(0)
                        # Stop can retire this runner between the state snapshot above
                        # and acquiring the lifecycle lock. A stale completion must not
                        # rearm a workflow that the user has explicitly stopped.
                        expected = runner if root == runner.root else self.session.runners.get(root)
                        if expected is None or self.session.runners.get(root) is not expected:
                            continue
                        finished.extend(self.session._complete_run(root, result, expected=expected))
                        if self.session._same_root(root, self.session.project.root):
                            self.session._arm_auto_trigger()
        if not self.session._stop.is_set() and self.session.engine is viewed:
            if not viewed_ticked:
                viewed.perceive(frame)
                if not busy:
                    self.session.trace.add_frame(
                        frame.index, viewed.current, [d.to_dict() for d in viewed.detections.values()]
                    )
            if self.session.engine is viewed:
                self.session._view_snapshot = (
                    viewed,
                    viewed_frame.index,
                    viewed_frame.ts,
                    [d.to_dict() for d in viewed.detections.values()],
                )
                pending = viewed.pending
                self.session._view_state = (
                    viewed,
                    viewed.current,
                    pending.edge.id if pending else None,
                    viewed.stats["ticks"],
                )
        self.session._maybe_auto_run()

    def _complete_run(self, root: str, result: str, *, expected: WorkflowRunner | None = None) -> list[tuple[str, str]]:
        with self.session._lifecycle_lock:
            return self.session._finish_run(root, result, expected=expected)

    def _finish_run(self, root: str, result: str, *, expected: WorkflowRunner | None = None) -> list[tuple[str, str]]:
        """一份 runner 结束：收证据、通知前端；若它是子链，恢复/终止父链。

        返回**同一拍里还要继续处理**的父链结束项（子链失败时父链也跟着失败），
        让 `_loop` 不用等下一帧才发 `run.stopped`。
        """
        extra: list[tuple[str, str]] = []
        with self.session.lock:
            if expected is not None and self.session.runners.get(root) is not expected:
                return []
            finished = self.session.runners.pop(root, None)
            if finished is None:
                return []
            parent_root = self.session.subflow_parent.pop(root, None)
            if parent_root:
                parent = self.session.runners.get(parent_root)
                if parent is not None and isinstance(parent.engine, FlowEngine) and parent.engine.waiting:
                    if result == "success":
                        parent.engine.resume_from_subflow()
                    else:
                        parent.engine.fail_from_subflow(f"子工作流「{root}」执行失败，当前链停止")
                        extra.append((parent_root, str(parent.engine.result)))
            # Publish the handle before announcing the stopped state. Closing can
            # drain background JPEG work and must remain outside the state lock.
            if isinstance(finished.engine, FlowEngine) and finished.engine.evidence is not None:
                self.session.evidence[root] = finished.engine.evidence
            self.session.running = self.session._any_running()
            self.session._run_revision += 1
            run_revision = self.session._run_revision
        self.session._collect_evidence(root, finished.engine)
        if not self.session._stop.is_set():
            self.session.emit(
                "run.stopped",
                {
                    "deviceId": self.session.device_id,
                    "result": result,
                    "workflowRoot": root,
                    "runRevision": run_revision,
                },
            )
        return extra

    def _runner_tickable(self, runner: WorkflowRunner) -> bool:
        """这一拍该不该 tick：FlowEngine 挂起等子链时不 tick；状态机一直 tick。"""
        if isinstance(runner.engine, FlowEngine):
            return runner.engine.result == "running" and not runner.engine.waiting
        return True

    def _subflow_descendants(self, root: str) -> list[str]:
        """找出所有直接/间接子链（深度优先，父在前）。"""
        found: list[str] = []
        stack = [root]
        while stack:
            parent = stack.pop()
            for child, owner in list(self.session.subflow_parent.items()):
                if owner == parent and child not in found:
                    found.append(child)
                    stack.append(child)
        return found

    def _drop_runner(self, root: str, result: str) -> None:
        """强制移除一份 runner 并通知前端（停止时用；不处理父子恢复）。"""
        with self.session.lock:
            runner = self.session.runners.pop(root, None)
            if runner is None:
                return
            runner.cancelled = True
            if isinstance(runner.engine, FlowEngine):
                runner.engine.request_stop()
            # 正在 tick 的执行器只能由 worker 收尾，不能并发关闭证据/重置状态。
            inflight = runner.inflight
            if runner.engine is self.session.engine:
                self.session.engine = self.session._make_engine(self.session.graph, workflow_root=root)
                self.session._view_snapshot = None
            self.session.running = self.session._any_running()
            self.session._run_revision += 1
            run_revision = self.session._run_revision
        if not inflight:
            if isinstance(runner.engine, FlowEngine):
                runner.engine.stop_execution()
            self.session._collect_evidence(root, runner.engine)
        self.session.emit(
            "run.stopped",
            {"deviceId": self.session.device_id, "result": result, "workflowRoot": root, "runRevision": run_revision},
        )

    def _on_engine_event(self, event: Any, *, workflow_root: str = "") -> None:
        if self.session._stop.is_set():
            return
        # 已接收停止的旧执行器不能再往刚重启的同 root 界面写迟到状态。
        runner = self.session.runners.get(workflow_root)
        if self.session._ticking_root == workflow_root and (
            runner is None or runner.cancelled or runner.engine is not self.session._ticking_engine
        ):
            return
        payload = {"deviceId": self.session.device_id, **event.to_dict()}
        if workflow_root:
            payload["workflowRoot"] = workflow_root
        self.session.emit("engine.event", payload)

    def _arm_auto_trigger(self) -> None:
        """给「每隔一段 / 定时开始」算出下一次该跑的时刻（手动触发器不排期）。"""
        trigger = auto_trigger(flow_steps(self.session.graph))
        if trigger is None:
            self.session._auto_at = None
            return
        when = next_fire_at(str(trigger.get("type")), dict(trigger.get("params") or {}), datetime.now())
        self.session._auto_at = when.timestamp() if when is not None else None
        if when is not None:
            logger.info("自动触发已就绪: %s → %s", trigger.get("type"), when.strftime("%m-%d %H:%M"))

    def _maybe_auto_run(self) -> None:
        """到点了就自动开跑（只有 interval / schedule 会排期）。"""
        with self.session._lifecycle_lock:
            due = self.session._auto_at
            if due is None or self.session._root_busy(self.session.project.root) or self.session._stop.is_set():
                return
            if time.time() < due:
                return
            self.session._auto_at = None
            try:
                self.session.start_run()
            except Exception as exc:
                logger.warning("自动触发开跑失败: %s", exc)
            self.session._arm_auto_trigger()  # 排下一次

    def start_run(self, from_step_id: str | None = None, workflow_root: str | None = None) -> None:
        with self.session._lifecycle_lock:
            self.session._start_run(from_step_id, workflow_root)

    def _start_run(self, from_step_id: str | None, workflow_root: str | None) -> None:
        root = self.session._root_key(workflow_root or self.session.project.root)
        if not root:
            raise RuntimeError("还没有选择工作流")
        if self.session._stop.is_set():
            raise RuntimeError("会话已关闭，不能开始运行")
        with self.session.lock:
            if self.session._root_busy(root):
                raise RuntimeError("这份工作流已在运行，请先停止")
            previous = self.session.runners.get(root)
            if previous is not None and not self.session._runner_busy(previous):
                self.session.runners.pop(root, None)
                if previous.engine is self.session.engine:
                    self.session.engine = self.session._make_engine(self.session.graph, workflow_root=root)
            if (
                self.session._same_root(root, self.session.project.root)
                and isinstance(self.session.engine, FlowEngine)
                and self.session.engine.result not in ("idle", "running")
            ):
                self.session.engine = self.session._make_engine(self.session.graph, workflow_root=root)
            runner = self.session._ensure_runner(root)
        self.session._attach_evidence(runner)
        with self.session.lock:
            if self.session._stop.is_set() or runner.cancelled or self.session.runners.get(root) is not runner:
                self.session._collect_evidence(root, runner.engine)
                raise RuntimeError("会话已关闭，不能开始运行")
            runner.engine.reset_variables()
            if isinstance(runner.engine, FlowEngine):
                if not runner.engine.steps:
                    raise RuntimeError("步骤链还是空的：先从左侧拖一个触发器/模块进来")
                if runner.graph.flow is not None:
                    runner.graph.flow = validate_flow(runner.graph.flow, set(runner.graph.recognizers), strict=True)
                runner.engine.start(from_step_id=from_step_id)
            elif not runner.graph.nodes:
                raise RuntimeError("状态图还没有节点：先在画面上框选录制一个界面")
            self.session.running = True
            self.session._run_revision += 1
            run_revision = self.session._run_revision
        self.session.emit(
            "run.started", {"deviceId": self.session.device_id, "workflowRoot": root, "runRevision": run_revision}
        )

    def stop_run(self, workflow_root: str | None = None) -> None:
        # Cancellation must precede lifecycle serialization: starting/finalizing a
        # run can hold that lock while doing evidence I/O or emitting a notification.
        # Waiting for it before signalling lets an active loop keep injecting input.
        root = self.session._root_key(workflow_root or self.session.project.root)
        if self.session._same_root(root, self.session.project.root):
            self.session._auto_at = None
        for key in [root, *self.session._subflow_descendants(root)]:
            runner = self.session.runners.get(key)
            if runner is not None and isinstance(runner.engine, FlowEngine):
                runner.engine.request_stop()
        with self.session._lifecycle_lock:
            self.session._stop_run(workflow_root)

    def _stop_run(self, workflow_root: str | None) -> None:
        root = self.session._root_key(workflow_root or self.session.project.root)
        # Reapply under the lifecycle lock: completion may have rearmed while the
        # cancellation signal above was waiting for the previous lifecycle operation.
        if self.session._same_root(root, self.session.project.root):
            self.session._auto_at = None
        if self.session.runners.get(root) is None:
            return
        # 先发协作停止信号，再等待会话锁/证据收尾，不能让快速循环继续发送点击。
        for key in [root, *self.session._subflow_descendants(root)]:
            runner = self.session.runners.get(key)
            if runner is not None and isinstance(runner.engine, FlowEngine):
                runner.engine.request_stop()
        with self.session.lock:
            children = self.session._subflow_descendants(root)
            for child in children:
                self.session.subflow_parent.pop(child, None)
            parent_root = self.session.subflow_parent.pop(root, None)
        # 先停最深的子链，避免子链还在往已经停掉的父链回调
        for child in reversed(children):
            self.session._drop_runner(child, "cancelled")
        if parent_root:
            parent = self.session.runners.get(parent_root)
            if parent is not None and isinstance(parent.engine, FlowEngine) and parent.engine.waiting:
                parent.engine.fail_from_subflow("子工作流已停止")
                self.session._drop_runner(parent_root, "failure")
        self.session._drop_runner(root, "cancelled")

    def _make_engine(
        self, graph: Graph, start_node: str | None = None, workflow_root: str | None = None
    ) -> Engine | FlowEngine:
        """选执行器：**有步骤链就跑链，否则跑状态机**（两套并存，互不转换）。

        `start_node` 只有状态机用（热重载时要回到原来那个界面）；步骤链的位置在
        `graph.flow.steps` 里，不靠它。
        """
        raw = workflow_root if workflow_root is not None else (graph.base_dir or self.session.project.root or "")
        root = self.session._root_key(raw)

        def on_event(event: Any) -> None:
            self.session._on_engine_event(event, workflow_root=root)

        if flow_steps(graph):
            return FlowEngine(
                graph,
                self.session.controller,
                trace=self.session.trace,
                on_event=on_event,
                on_call=self.session._on_call_script,
                input_guard=self.session._automatic_input,
            )
        return Engine(
            graph,
            self.session.controller,
            trace=self.session.trace,
            on_event=on_event,
            on_call=self.session._on_call_script,
            start_node=start_node,
        )

    def _on_call_script(self, script: str) -> None:
        """「运行子工作流」：切到那份工作流继续跑（由 SessionManager 统一处理，保证多设备一致）。"""
        if self.session.on_call_script is None:
            raise RuntimeError("当前环境不支持运行子工作流")
        self.session.on_call_script(script)

    def _root_key(self, root: str | None) -> str:
        value = (root or "").strip()
        return norm_path(value) if value else ""

    def _same_root(self, left: str | None, right: str | None) -> bool:
        a = self.session._root_key(left)
        b = self.session._root_key(right)
        return bool(a) and a == b

    def _runner_busy(self, runner: WorkflowRunner) -> bool:
        if runner.inflight:
            return True
        if isinstance(runner.engine, FlowEngine):
            return runner.engine.result == "running"
        return True

    def _any_running(self) -> bool:
        return any(self.session._runner_busy(runner) for runner in self.session.runners.values())

    def _root_busy(self, root: str | None) -> bool:
        runner = self.session.runners.get(self.session._root_key(root))
        return runner is not None and self.session._runner_busy(runner)

    def _ensure_runner(self, root: str) -> WorkflowRunner:
        existing = self.session.runners.get(root)
        if existing is not None:
            stale = (
                self.session._same_root(root, self.session.project.root)
                and existing.engine is not self.session.engine
                and not self.session._runner_busy(existing)
            )
            if not stale:
                return existing
            self.session.runners.pop(root, None)
        if self.session._same_root(root, self.session.project.root):
            runner = WorkflowRunner(root, self.session.graph, self.session.engine)
        else:
            graph = _load_graph(Project(root=root))
            runner = WorkflowRunner(root, graph, self.session._make_engine(graph, workflow_root=root))
        self.session.runners[root] = runner
        return runner

    def reload_graph(self) -> None:
        """换界面当前这份工作流的图；其它 Tab 正在跑的执行器原样保留。

        切回一份正在跑的工作流时，把画布接到那份执行器上（继续高亮当前步）。
        文件读不回来时**保留现有图继续跑**，只把原因记下来并上报。
        """
        viewed = self.session._root_key(self.session.project.root)
        existing = self.session.runners.get(viewed) if viewed else None
        if existing is not None and self.session._runner_busy(existing):
            self.session.graph = existing.graph
            self.session.engine = existing.engine
            self.session.graph_error = None
            logger.info("切回运行中的工作流（设备 %s）", self.session.device_id)
            return
        if existing is not None:
            self.session.runners.pop(viewed, None)
        current = self.session.engine.current
        try:
            graph = _load_graph(self.session.project)
        except Exception as error:
            self.session.graph_error = describe_graph_error(self.session.project, error)
            logger.error("状态图读取失败: %s", self.session.graph_error)
            self.session.emit(
                "engine.event",
                {
                    "deviceId": self.session.device_id,
                    "seq": self.session._input_seq,
                    "ts": time.time(),
                    "type": "graph_error",
                    "message": self.session.graph_error,
                },
            )
            return
        self.session.graph_error = None
        self.session.graph = graph
        self.session.engine = self.session._make_engine(self.session.graph, start_node=current, workflow_root=viewed)
        self.session.engine.reset_variables()
        self.session._arm_auto_trigger()

    def _attach_evidence(self, runner: WorkflowRunner) -> None:
        """开跑前把证据目录挂到执行器上（`defaults.evidence = false` 可关掉）。

        为什么挂在执行器而不是会话上：截图要在"这一步正在跑"的那一拍取，
        会话只知道帧，不知道走到第几步。
        """
        engine = runner.engine
        if not isinstance(engine, FlowEngine):
            return
        if engine.graph.default("evidence", True) is False:
            engine.attach_evidence(None)
            return
        try:
            # 同秒停止并重启不能共享 trace/截图目录。
            stamp = f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
            engine.attach_evidence(RunEvidence(runner.root, stamp=stamp))
        except OSError as error:
            logger.warning("证据目录建不起来（这次运行没有截图）: %s", error)
            engine.attach_evidence(None)

    def _collect_evidence(self, root: str, engine: Any) -> None:
        """跑完把证据目录收下来（保留句柄：界面还要按文件名取图）。"""
        if not isinstance(engine, FlowEngine):
            return
        evidence = engine.close_evidence()
        if evidence is None:
            return
        previous = self.session.evidence.get(root)
        if previous is not None and previous is not evidence:
            previous.close()
        self.session.evidence[root] = evidence

    def evidence_bundle(self, workflow_root: str | None = None) -> dict[str, Any] | None:
        """最近一次运行的证据：目录 + 每一步的截图名（`None` = 还没跑过带证据的运行）。"""
        root = self.session._root_key(workflow_root or self.session.project.root)
        with self.session.lock:
            evidence = self.session.evidence.get(root)
            runner = self.session.runners.get(root)
            completed = runner is None or not self.session._runner_busy(runner)
        if evidence is not None and completed:
            # Legacy callers query as soon as running becomes false. Await the
            # same bounded drain as completion, never while holding state locks.
            evidence.close()
        return evidence.to_dict() if evidence is not None else None

    def evidence_image(self, name: str, workflow_root: str | None = None) -> bytes | None:
        root = self.session._root_key(workflow_root or self.session.project.root)
        evidence = self.session.evidence.get(root)
        return evidence.image_bytes(name) if evidence is not None else None
