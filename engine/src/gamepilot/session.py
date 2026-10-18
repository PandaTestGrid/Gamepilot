"""设备会话：一个设备 = 一个截图循环 + 多份工作流执行器。

职责（DESIGN.md §4.6 的运行时部分）：
- **唯一的截图循环**：谁都不许绕过它去点设备（控制器不是线程安全的）；
- 每个 Tab / 工作流目录有自己的执行器，开停互不影响；
- 每帧做识别（不跑状态机时也做，UI 要实时看到分数）；
- 运行态下每帧依次 tick 正在跑的执行器并把事件推出去；
- 帧以 JPEG(base64) 推给前端，附带当帧识别结果与节点状态；
- 录制：从**当前帧**裁剪模板 → 落盘 → 注册识别器 → 写回 graph.json。

线程模型：capture 线程只做"抓帧 → 识别 → 推送"，RPC 线程只做读写，
共享的状态图用锁保护（录制/改阈值时短暂持有）。
"""

from __future__ import annotations

import base64
import contextlib
import json
import logging
import os
import threading
import time
from collections.abc import Callable
from datetime import datetime
from typing import Any

import cv2
import numpy as np

from .core.actions import Action
from .core.conditions import ALWAYS_LABEL
from .core.evidence import RunEvidence
from .core.flow_engine import FlowEngine
from .core.flow_model import validate_flow
from .core.flow_record import action_to_flow_step
from .core.flow_trigger import auto_trigger, next_fire_at
from .core.frame import Frame
from .core.geometry import Rect
from .core.graph import GRAPH_WRITE_LOCK, Edge, Graph, Node, validate_recognizer_label
from .core.recognizer import normalize_search
from .core.state_machine import Engine
from .core.trace import TraceBuffer
from .devices import ORIENTATION_LABELS
from .devices.base import Controller
from .frames import FrameSink
from .library import norm_path
from .project import Project
from .protocol import NOTIFY_DEVICE_FAILED, NOTIFY_DEVICE_RECOVERED

logger = logging.getLogger("gamepilot.session")

# scrcpy 通道的采集循环上限（帧/秒）。
#
# 循环上限必须 ≥ 推流帧率，否则界面要的 30fps 里有近一半拍子是空转的
# （scrcpy 抓帧 ~0.3ms、识别 2~10ms，30fps 的 33ms 预算绰绰有余）。
# adb 截图通道每秒只有 1.8 帧，上限对它没有意义（循环被截图耗时自然卡住）。
SCRCPY_LOOP_FPS = 30.0
# 分段耗时汇总的间隔（秒）：每这么久在日志里报一次"抓帧/识别/推送各花多少"。
TIMING_LOG_SECONDS = 10.0
# time.sleep 的实测偏差补偿。
#
# macOS 上 `time.sleep(0.033)` 实测中位多睡 3.5ms、p95 多睡 5ms：30fps 的 33ms 预算
# 被它吃掉就直接掉到 27fps（15fps 时代那个"只有 13.4fps"也是同一个原因）。
# 这里按实测偏差做 EWMA 补偿；上限 10ms，免得算错时把循环推成不停歇的空转。
SLEEP_BIAS_MAX = 0.010
SLEEP_BIAS_ALPHA = 0.25
# 推帧节流的抖动容差（秒）。
#
# 推帧间隔和循环间隔是同一个数量级时（都要 30fps），差几毫秒就会拍频：
# 一拍推、一拍丢 —— 实测把 30fps 的推流打成 19fps。留一点容差让"刚好差一点点"
# 变成"每拍都推"，而不是隔拍推。
PUSH_TOLERANCE = 0.006

Emit = Callable[[str, dict[str, Any]], None]


def _node_ref(node: Node) -> str:
    """在"被谁用了"这类提示里怎么称呼一个节点。

    重名时**必须带上 id**：编辑过两个都叫「新界面」的节点（只差 id），
    提示里光写『新界面』等于没说，用户根本不知道该去改哪一个。
    """
    name = node.name or node.id
    return f"『{name}』（{node.id}）" if name != node.id else f"『{name}』"


def flow_steps(graph: Graph) -> list[dict[str, Any]]:
    """这份图的步骤链里有几步（没有 flow 段 / 空链都返回空表）。"""
    return list((graph.flow or {}).get("steps") or [])


class WorkflowRunner:
    """一份工作流在某台设备上的独立执行器（Tab / 工作区互不影响）。"""

    def __init__(self, root: str, graph: Graph, engine: Engine | FlowEngine) -> None:
        self.root = root
        self.graph = graph
        self.engine = engine


LEGACY_GRAPH_EDIT_ERROR = (
    "该工作流已启用步骤链（flow.steps），不再支持 graph.node.* / graph.edge.*；"
    "请用 graph.save 更新 flow.steps，或用 record.action 录制。"
)


def reject_legacy_graph_edit(graph: Graph) -> None:
    """步骤链为真源时禁止再改 nodes/edges（避免双轨 graph.json）。"""
    if flow_steps(graph):
        raise ValueError(LEGACY_GRAPH_EDIT_ERROR)


def describe_graph_error(project: Project, error: object) -> str:
    """把"图读不回来"说成用户能照做的中文：哪份工作流、为什么、文件在哪。"""
    name = os.path.basename(project.root.rstrip("/\\")) or "未命名"
    detail = str(error) or error.__class__.__name__
    return f"工作流「{name}」的 graph.json 读不了：{detail}（文件：{project.graph_path}）"


def _load_graph(project: Project) -> Graph:
    """当前工作流的状态图；**没有选择工作流**时给一张"没有落盘位置"的空图（一等状态）。

    `path=""` 很关键：让 `Graph.save()` 明确报「状态图没有保存路径」，
    而不是把 graph.json 写进引擎的 cwd。
    """
    if not project.root:
        return Graph.empty("", path="")
    return Graph.load(project.graph_path)


# 图编辑：纯内存改动；会话路径与项目路径共用，真源为项目 graph.json。


def next_node_id(graph: Graph) -> str:
    """下一个可用的界面 id（`n_1`、`n_2`…）。只增不减，避免与仍存在的 id 冲突导致 upsert 覆盖。"""
    index = len(graph.nodes) + 1
    while f"n_{index}" in graph.nodes:
        index += 1
    return f"n_{index}"


def graph_node_add(graph: Graph, node_id: str | None, name: str | None, enter: list[str] | None) -> dict[str, Any]:
    reject_legacy_graph_edit(graph)
    identifier = node_id or next_node_id(graph)
    node = graph.nodes.get(identifier) or Node(id=identifier, name=name or identifier, enter=[])
    if name:
        node.name = name
    for label in enter or []:
        if label not in graph.recognizers:
            raise ValueError(f"未定义的识别器: {label}")
        if label not in node.enter:
            node.enter.append(label)
    graph.upsert_node(node)
    graph.validate()
    return {"nodeId": node.id, "graph": graph.to_dict()}


def graph_node_update(graph: Graph, node_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    reject_legacy_graph_edit(graph)
    node = graph.nodes.get(node_id)
    if node is None:
        raise ValueError(f"没有这个节点: {node_id}")
    if isinstance(patch.get("name"), str):
        node.name = str(patch["name"])
    if "enter" in patch:
        enter = [str(item) for item in patch["enter"] or []]
        for label in enter:
            if label not in graph.recognizers:
                raise ValueError(f"未定义的识别器: {label}")
        node.enter = enter
    if patch.get("timeout_ms") is not None:
        node.timeout_ms = int(patch["timeout_ms"])
    if "at" in patch:
        node.at = str(patch.get("at") or "")
    graph.upsert_node(node)
    graph.validate()
    return {"nodeId": node.id, "graph": graph.to_dict()}


def graph_node_remove(graph: Graph, node_id: str) -> dict[str, Any]:
    reject_legacy_graph_edit(graph)
    if node_id not in graph.nodes:
        raise ValueError(f"没有这个节点: {node_id}")
    del graph.nodes[node_id]
    # 引用了这个节点的边一并删掉（否则图就不合法了）
    graph.edges = [edge for edge in graph.edges if edge.src != node_id and edge.dst != node_id]
    return {"removed": node_id, "graph": graph.to_dict()}


def graph_edge_add(
    graph: Graph,
    *,
    src: str | None,
    dst: str | None,
    when: str | None = None,
    action: dict[str, Any] | None = None,
    condition: dict[str, Any] | None = None,
) -> dict[str, Any]:
    reject_legacy_graph_edit(graph)
    label = when or ""
    if not label and src and src in graph.nodes and graph.nodes[src].enter:
        label = graph.nodes[src].enter[0]
    edge_id = f"e_{label or 'new'}_{len(graph.edges) + 1}"
    while any(edge.id == edge_id for edge in graph.edges):
        edge_id = f"{edge_id}_x"
    default_action = action or ({"type": "click", "target": label} if label else {"type": "wait", "seconds": 0.5})
    edge = Edge.from_dict(
        {
            "id": edge_id,
            "when": label or ALWAYS_LABEL,
            "from": src,
            "to": dst,
            "cooldown_ms": 600,
            "condition": condition or ({"all_of": [label]} if label else {"always": True}),
            "action": default_action,
        }
    )
    graph.add_edge(edge)
    graph.validate()
    return {"edgeId": edge_id, "graph": graph.to_dict()}


def graph_rename_recognizer(graph: Graph, old: str, new: str) -> dict[str, Any]:
    label = validate_recognizer_label(new)
    refs = graph.rename_recognizer(old, label)
    return {"from": old, "to": label, "refs": refs, "graph": graph.to_dict()}


def graph_remove_recognizer(graph: Graph, label: str, *, project_root: str = "") -> dict[str, Any]:
    if label not in graph.recognizers:
        raise ValueError(f"没有这个识别器: {label}")
    users: list[str] = []
    for node in graph.nodes.values():
        if label in node.enter:
            users.append(f"界面{_node_ref(node)}的进入条件")
    for edge in graph.edges:
        if label in edge.condition.labels or label == edge.when:
            users.append(f"边 {edge.id} 的判断条件")
        if label in (edge.action.get("target"), edge.action.get("to_target")):
            users.append(f"边 {edge.id} 的动作目标")
    for step in flow_steps(graph):
        params = step.get("params") or {}
        if params.get("rec") == label:
            users.append(f"模块 {step.get('id')}（{step.get('type')}）")
    if users:
        raise RuntimeError(f"『{label}』还在被使用，先改掉再删：{'；'.join(sorted(set(users))[:4])}")
    spec = dict(graph.specs.get(label) or {})
    graph.specs.pop(label, None)
    graph.recognizers.pop(label, None)
    if project_root:
        for relative in {str(spec.get("template") or ""), f"templates/{label}.png"} - {""}:
            with contextlib.suppress(OSError):
                os.remove(os.path.join(project_root, relative))
    return {"removed": label, "graph": graph.to_dict()}


class DeviceSession:
    def __init__(
        self,
        device_id: str,
        controller: Controller,
        project: Project,
        emit: Emit,
        *,
        fps: float = 8.0,
        jpeg_width: int = 720,
        jpeg_quality: int = 65,
    ) -> None:
        self.device_id = device_id
        self.controller = controller
        self.project = project
        self.emit = emit
        # scrcpy 通道能到 ~28fps，帧率上限跟着提上去；adb 截图通道每秒只有 1.8 帧，
        # 上限设多少都无所谓（循环自然被截图耗时卡住）
        if getattr(controller, "channel", "") == "scrcpy":
            fps = max(fps, SCRCPY_LOOP_FPS)
        self.fps_limit = max(1.0, fps)
        self.jpeg_width = jpeg_width
        self.jpeg_quality = jpeg_quality

        self.trace = TraceBuffer()
        # 图读不回来（文件被写坏/手改坏）时**不阻断建会话**：拿一张同路径的空图顶上，
        # 把原因记在 graph_error 上；界面显示"这份读不了"，而不是连设备都连不上。
        self.graph_error: str | None = None
        try:
            self.graph = _load_graph(project)
        except Exception as error:
            self.graph = Graph.empty(project.root, path=project.graph_path or None)
            self.graph_error = describe_graph_error(project, error)
            logger.error("状态图读取失败: %s", self.graph_error)
        self.engine = self._make_engine(self.graph)
        self.runners: dict[str, WorkflowRunner] = {}
        # 子工作流 → 调用它的父工作流 root。只对 FlowEngine 的“调用后继续”语义生效。
        self.subflow_parent: dict[str, str] = {}
        # 当前正在 tick 的 runner root：调用动作发生在哪个引擎里，就以它为父链
        # （不能拿 project.root：调用不跳画布后 project 一直是 A，嵌套调用会认错）。
        self._ticking_root = ""
        # 每份工作流最近一次运行的证据目录（跑完也留着：界面要看截图与每一步的参数）
        self.evidence: dict[str, RunEvidence] = {}
        self.lock = threading.RLock()
        self.running = False  # 是否有任一份工作流在跑
        # 「每隔一段 / 定时开始」触发器：下一次该跑的时刻（墙钟秒；None = 不排期）
        self._auto_at: float | None = None
        self.started = False  # 截图循环是否在跑
        self.index = 0
        self.fps = 0.0
        self.capture_ms = 0.0
        self.last_frame: np.ndarray | None = None
        # 连续截图失败才标记不可用；恢复一帧后清掉，不让状态卡在「失败」。
        self.capture_error: str | None = None
        self._last_emit_at: float | None = None
        self._input_seq = 0  # 手动控制事件的序号（事件栏按 seq 排序）
        self._touch_from: tuple[float, float] | None = None
        # 录制的上一条动作边：下次录新界面时自动把 to 接上
        # 「运行子工作流」的回调（由 SessionManager 注入：切工作流目录要全局一致）
        self.on_call_script: Callable[[str], None] | None = None
        self._pending_edge_id: str | None = None
        # 最近一次录制涉及的节点：刚录完模板马上点一下时，靠它定位这一步属于哪个界面
        self._last_node_id: str | None = None
        self._last_node_at = 0.0
        # 推给界面的帧率（0 = 暂停推帧）。识别/状态机不受影响，仍按 fps_limit 跑，
        # 这样"界面不看这台设备"时不会白烧 CPU 与带宽（多设备时尤其明显）
        # 默认 0：界面明确要了才推。连接瞬间就按 15fps 推帧会把控制通道（同一根
        # stdout）灌满，RPC 响应排在几万行帧后面 —— 表现就是"卡在 connecting、一帧都收不到"
        self.stream_fps = 0.0
        # 帧走独立 socket（见 frames.py）：不占控制通道，宿主也不做 base64
        self.frames = FrameSink.from_env()
        self._last_push_at = 0.0
        self._last_seq: int | None = None
        self._last_jpeg: bytes | None = None
        # 分段计时：每 TIMING_LOG_SECONDS 汇总成一行日志，回答"帧率/延迟花在哪"
        self._stage_ms: dict[str, float] = {"capture": 0.0, "perceive": 0.0, "push": 0.0}
        self._stage_frames = 0
        self._stage_since = time.perf_counter()
        # sleep 的实测偏差（秒，EWMA）：用于把"多睡掉的那几毫秒"从间隔里扣回来
        self._sleep_bias = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self.started:
            return
        self._stop.clear()
        if self.frames is not None:
            self.frames.start()  # 帧通道：JPEG 走独立 socket，不占控制通道
        self._thread = threading.Thread(target=self._loop, name=f"capture-{self.device_id}", daemon=True)
        self._thread.start()
        self.started = True
        self._arm_auto_trigger()  # 连上就算第一次（interval/schedule 才有）
        logger.info("会话启动: %s", self.device_id)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
        self._thread = None
        if self.frames is not None:
            self.frames.close()
        self.started = False
        with self.lock:
            self.running = False
            for runner in list(self.runners.values()):
                if isinstance(runner.engine, FlowEngine):
                    runner.engine.stop_execution()
            self.runners.clear()
            self.subflow_parent.clear()
        try:
            self.controller.close()
        except Exception as exc:  # pragma: no cover - 关闭失败不影响退出
            logger.warning("关闭设备失败: %s", exc)

    def _loop(self) -> None:
        interval = 1.0 / self.fps_limit
        failures = 0
        last_channel = getattr(self.controller, "channel", "")
        while not self._stop.is_set():
            started = time.perf_counter()
            try:
                image = self.controller.screenshot()
            except Exception as exc:
                if self._stop.is_set():
                    break  # 用户已断开；迟到的截图异常不能再把设备标成 failed
                failures += 1
                message = f"截图失败: {exc}"
                if failures >= 3 and message != self.capture_error:
                    self.capture_error = message
                    self.emit(
                        NOTIFY_DEVICE_FAILED,
                        {
                            "deviceId": self.device_id,
                            "error": message,
                            "channel": getattr(self.controller, "channel", "unknown"),
                            "linkNote": getattr(self.controller, "link_note", ""),
                        },
                    )
                self._stop.wait(0.5)
                continue

            if self._stop.is_set():
                break  # 截图完成时会话已停，不能把旧帧或恢复通知再推给前端
            failures = 0
            channel = getattr(self.controller, "channel", "")
            if self.capture_error is not None or channel != last_channel:
                self.capture_error = None
                self.emit(
                    NOTIFY_DEVICE_RECOVERED,
                    {
                        "deviceId": self.device_id,
                        "channel": channel,
                        "linkNote": getattr(self.controller, "link_note", ""),
                    },
                )
            last_channel = channel

            self.capture_ms = (time.perf_counter() - started) * 1000
            self.index += 1
            frame = Frame(image=image, size=self.controller.resolution, index=self.index)
            finished_runs: list[tuple[str, str]] = []
            with self.lock:
                self.last_frame = image.copy()
                busy = [runner for runner in self.runners.values() if self._runner_tickable(runner)]
            # 点击 / 长按 / 滑动会在设备上阻塞几百毫秒到数秒。锁只保护会话状态，
            # 不能罩住这段 I/O —— 否则触控 RPC、停跑、状态查询都会跟着卡死界面。
            work_started = time.perf_counter()
            viewed_ticked = False
            if busy:
                for runner in busy:
                    self._ticking_root = runner.root
                    try:
                        events = runner.engine.tick(frame)
                    finally:
                        self._ticking_root = ""
                    for event in events:
                        logger.debug("event %s %s", event.type, event.message)
                    if runner.engine is self.engine:
                        viewed_ticked = True
                    with self.lock:
                        if isinstance(runner.engine, FlowEngine) and runner.engine.result != "running":
                            finished_runs.append((runner.root, str(runner.engine.result)))
            if not viewed_ticked:
                self.engine.perceive(frame)
                if not busy:
                    self.trace.add_frame(
                        frame.index,
                        self.engine.current,
                        [item.to_dict() for item in self.engine.detections.values()],
                    )
            # 识别（含状态机 tick）的耗时：这一段直接加在画面延迟上，因为帧是
            # "先识别、后编码推送"的，快慢都体现在用户看到的画面上
            self._stage_ms["perceive"] += (time.perf_counter() - work_started) * 1000

            index = 0
            while index < len(finished_runs):
                root, result = finished_runs[index]
                index += 1
                finished_runs.extend(self._complete_run(root, result))
                if self._same_root(root, self.project.root):
                    self._arm_auto_trigger()

            self._maybe_auto_run()  # 到点就自己开跑（只有 interval / schedule 会排期）

            detections = [item.to_dict() for item in self.engine.detections.values()]
            if self._should_push():
                push_started = time.perf_counter()
                self._emit_frame(frame, detections)
                self._stage_ms["push"] += (time.perf_counter() - push_started) * 1000

            elapsed = time.perf_counter() - started
            # fps 是"实际交付节奏"（两次推帧的间隔），不是 1/截图耗时：
            # scrcpy 通道截图只要 0.3ms，按后者算会得出 1300fps 这种假数字
            now = time.perf_counter()
            period = now - self._last_emit_at if self._last_emit_at else elapsed
            self.fps = 1.0 / period if period > 0 else 0.0
            self._last_emit_at = now
            self._stage_ms["capture"] += self.capture_ms
            self._stage_frames += 1
            self._flush_timing()
            # 扣掉实测偏差再睡：不补偿的话中位多睡 3.5ms，30fps 直接掉到 27fps。
            # 偏差按"本拍总耗时（含这觉）vs 目标间隔"学（EWMA）；
            # 一定要在睡完之后量，睡之前量的只是干活时间，永远小于间隔，学不到东西。
            remaining = interval - (time.perf_counter() - started) - self._sleep_bias
            if remaining > 0.0:
                self._stop.wait(remaining)
                cycle = time.perf_counter() - started
                self._sleep_bias = min(
                    SLEEP_BIAS_MAX,
                    max(0.0, self._sleep_bias + (cycle - interval) * SLEEP_BIAS_ALPHA),
                )

    def _flush_timing(self) -> None:
        """每 TIMING_LOG_SECONDS 报一次分段耗时：帧率/延迟到底花在哪。

        只统计到「编码推送」结束；剩下的就是 time.sleep 的余量。
        帧周期明显大于（抓帧 + 识别 + 推送）说明循环有余量、瓶颈在下游（传输/前端）；
        反过来则说明该降识别频率或减识别器。
        """
        now = time.perf_counter()
        span = now - self._stage_since
        frames = self._stage_frames
        if span < TIMING_LOG_SECONDS or frames <= 0:
            return
        stage = self._stage_ms
        logger.info(
            "循环 %.1ffps（%d 帧 / %.1fs）：抓帧 %.2fms · 识别 %.2fms · 编码推送 %.2fms · 帧周期 %.1fms · 睡眠补偿 %.1fms",
            frames / span,
            frames,
            span,
            stage["capture"] / frames,
            stage["perceive"] / frames,
            stage["push"] / frames,
            span * 1000.0 / frames,
            self._sleep_bias * 1000.0,
        )
        self._stage_ms = {key: 0.0 for key in stage}
        self._stage_frames = 0
        self._stage_since = now

    def _complete_run(self, root: str, result: str) -> list[tuple[str, str]]:
        """一份 runner 结束：收证据、通知前端；若它是子链，恢复/终止父链。

        返回**同一拍里还要继续处理**的父链结束项（子链失败时父链也跟着失败），
        让 `_loop` 不用等下一帧才发 `run.stopped`。
        """
        extra: list[tuple[str, str]] = []
        with self.lock:
            finished = self.runners.pop(root, None)
            if finished is not None:
                self._collect_evidence(root, finished.engine)
            parent_root = self.subflow_parent.pop(root, None)
            if parent_root:
                parent = self.runners.get(parent_root)
                if parent is not None and isinstance(parent.engine, FlowEngine) and parent.engine.waiting:
                    if result == "success":
                        parent.engine.resume_from_subflow()
                    else:
                        parent.engine.fail_from_subflow(f"子工作流「{root}」执行失败，当前链停止")
                        extra.append((parent_root, str(parent.engine.result)))
            self.running = self._any_running()
        self.emit(
            "run.stopped",
            {"deviceId": self.device_id, "result": result, "workflowRoot": root},
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
            for child, owner in list(self.subflow_parent.items()):
                if owner == parent and child not in found:
                    found.append(child)
                    stack.append(child)
        return found

    def _drop_runner(self, root: str, result: str) -> None:
        """强制移除一份 runner 并通知前端（停止时用；不处理父子恢复）。"""
        with self.lock:
            runner = self.runners.pop(root, None)
            if runner is None:
                return
            if isinstance(runner.engine, FlowEngine):
                runner.engine.stop_execution()
            runner.engine.pending = None
            self._collect_evidence(root, runner.engine)
            self.running = self._any_running()
        self.emit(
            "run.stopped",
            {"deviceId": self.device_id, "result": result, "workflowRoot": root},
        )

    def _should_push(self) -> bool:
        """这一拍要不要推给界面（stream_fps = 0 表示界面没显示这台设备）。"""
        if self.stream_fps <= 0:
            return False
        gap = 1.0 / self.stream_fps
        now = time.perf_counter()
        if now - self._last_push_at < gap - min(PUSH_TOLERANCE, gap * 0.2):
            return False
        self._last_push_at = now
        return True

    def set_stream_fps(self, fps: float) -> None:
        self.stream_fps = max(0.0, float(fps))
        logger.info("推流帧率: %.1f fps (设备 %s)", self.stream_fps, self.device_id)

    def _emit_frame(self, frame: Frame, detections: list[dict[str, Any]]) -> None:
        # 画面没变（scrcpy 静止时会重复同一帧）就复用上次的 JPEG，省掉一次编码
        seq = getattr(self.controller, "_frame_seq", None)
        if seq is not None and seq == self._last_seq and self._last_jpeg is not None:
            jpeg_bytes = self._last_jpeg
        else:
            jpeg_bytes = self._encode_jpeg(frame.image)
            self._last_seq = seq
            self._last_jpeg = jpeg_bytes

        # 帧走独立 socket（原始字节）；没连上时退回 base64 塞在通知里（单测 / 通道失败）
        send_raw = self.frames is not None and self.frames.connected
        if send_raw:
            assert self.frames is not None
            self.frames.submit(self.device_id, jpeg_bytes)

        payload = {
            "deviceId": self.device_id,
            "index": frame.index,
            "ts": round(frame.ts, 3),
            "resolution": list(frame.size),
            "node": self.engine.current,
            "pending": self.engine.pending.edge.id if self.engine.pending else None,
            "tick": self.engine.stats["ticks"],
            "fps": round(self.fps, 1),
            "captureMs": round(self.capture_ms, 1),
            "detections": detections,
            **({} if send_raw else {"jpeg": base64.b64encode(jpeg_bytes).decode("ascii")}),
        }
        self.emit("engine.frame", payload)

    def _encode_jpeg(self, image: np.ndarray) -> bytes:
        """编码成 JPEG 原始字节（缩到 jpeg_width）。返回空 bytes 表示编码失败。"""
        height, width = image.shape[:2]
        if width > self.jpeg_width:
            scale = self.jpeg_width / float(width)
            image = cv2.resize(image, (self.jpeg_width, max(1, int(height * scale))), interpolation=cv2.INTER_AREA)
        ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality])
        return buffer.tobytes() if ok else b""

    def _on_engine_event(self, event: Any, *, workflow_root: str = "") -> None:
        payload = {"deviceId": self.device_id, **event.to_dict()}
        if workflow_root:
            payload["workflowRoot"] = workflow_root
        self.emit("engine.event", payload)

    def touch(self, phase: str, x: float, y: float) -> None:
        """实时触控（画面栏拖动时逐事件转发）。

        move 不写事件（拖动一次会来上百个），只在 down/up 留痕。
        """
        if phase not in ("down", "move", "up"):
            # 在会话层统一校验：各控制器行为保持一致
            raise ValueError(f"phase 必须是 down/move/up，收到: {phase}")
        with self.lock:
            controller = self.controller
        if hasattr(controller, "touch"):
            controller.touch(phase, x, y)
        elif phase == "up":
            controller.click(x, y)
        else:
            return
        if phase == "down":
            self._touch_from = (x, y)
            self._input_seq += 1
            self.emit(
                "engine.event",
                {
                    "deviceId": self.device_id,
                    "seq": self._input_seq,
                    "ts": time.time(),
                    "type": "manual_input",
                    "node": self.engine.current,
                    "edge": None,
                    "message": f"手动触控 按下 ({x:.3f}, {y:.3f})",
                },
            )
        elif phase == "up":
            start = getattr(self, "_touch_from", None)
            detail = (
                f"({x:.3f}, {y:.3f})" if start is None else f"({start[0]:.3f}, {start[1]:.3f}) → ({x:.3f}, {y:.3f})"
            )
            self._input_seq += 1
            self.emit(
                "engine.event",
                {
                    "deviceId": self.device_id,
                    "seq": self._input_seq,
                    "ts": time.time(),
                    "type": "manual_input",
                    "node": self.engine.current,
                    "edge": None,
                    "message": f"手动触控 {detail}",
                },
            )

    def tap(self, x: float, y: float) -> None:
        """归一化坐标轻触。"""
        started = time.perf_counter()
        with self.lock:
            controller = self.controller
        controller.click(x, y)
        self._emit_input("手动点击", f"({x:.3f}, {y:.3f})", started)

    def swipe(self, x1: float, y1: float, x2: float, y2: float, duration: float) -> None:
        """归一化坐标滑动。"""
        started = time.perf_counter()
        with self.lock:
            controller = self.controller
        controller.swipe(x1, y1, x2, y2, duration=duration)
        self._emit_input("手动滑动", f"({x1:.2f}, {y1:.2f}) → ({x2:.2f}, {y2:.2f}) {duration * 1000:.0f}ms", started)

    def press(self, name: str) -> None:
        """功能键（back/home/recents/power/volume_*）。"""
        started = time.perf_counter()
        with self.lock:
            controller = self.controller
        if hasattr(controller, "press"):
            controller.press(name)
        else:
            controller.key(name)
        self._emit_input("手动按键", name, started)

    def _emit_input(self, title: str, detail: str, started: float) -> None:
        cost_ms = (time.perf_counter() - started) * 1000
        with self.lock:
            self._input_seq += 1
        self.emit(
            "engine.event",
            {
                "deviceId": self.device_id,
                "seq": self._input_seq,
                "ts": time.time(),
                "type": "manual_input",
                "node": self.engine.current,
                "edge": None,
                "message": f"{title} {detail}（{cost_ms:.1f}ms）",
            },
        )

    def _arm_auto_trigger(self) -> None:
        """给「每隔一段 / 定时开始」算出下一次该跑的时刻（手动触发器不排期）。"""
        trigger = auto_trigger(flow_steps(self.graph))
        if trigger is None:
            self._auto_at = None
            return
        when = next_fire_at(str(trigger.get("type")), dict(trigger.get("params") or {}), datetime.now())
        self._auto_at = when.timestamp() if when is not None else None
        if when is not None:
            logger.info("自动触发已就绪: %s → %s", trigger.get("type"), when.strftime("%m-%d %H:%M"))

    def _maybe_auto_run(self) -> None:
        """到点了就自动开跑（只有 interval / schedule 会排期）。"""
        if self._auto_at is None or self._root_busy(self.project.root) or self._stop.is_set():
            return
        if time.time() < self._auto_at:
            return
        self._auto_at = None
        try:
            self.start_run()
        except Exception as exc:
            logger.warning("自动触发开跑失败: %s", exc)
        self._arm_auto_trigger()  # 排下一次

    def start_run(self, from_step_id: str | None = None, workflow_root: str | None = None) -> None:
        root = self._root_key(workflow_root or self.project.root)
        if not root:
            raise RuntimeError("还没有选择工作流")
        runner = self._ensure_runner(root)
        with self.lock:
            self._attach_evidence(runner)
            runner.engine.reset_variables()
            if isinstance(runner.engine, FlowEngine):
                if not runner.engine.steps:
                    raise RuntimeError("步骤链还是空的：先从左侧拖一个触发器/模块进来")
                if runner.graph.flow is not None:
                    runner.graph.flow = validate_flow(runner.graph.flow, set(runner.graph.recognizers), strict=True)
                runner.engine.start(from_step_id=from_step_id)
            elif not runner.graph.nodes:
                raise RuntimeError("状态图还没有节点：先在画面上框选录制一个界面")
            self.running = True
        self.emit("run.started", {"deviceId": self.device_id, "workflowRoot": root})

    def stop_run(self, workflow_root: str | None = None) -> None:
        root = self._root_key(workflow_root or self.project.root)
        if self.runners.get(root) is None:
            return
        with self.lock:
            children = self._subflow_descendants(root)
            for child in children:
                self.subflow_parent.pop(child, None)
            parent_root = self.subflow_parent.pop(root, None)
        # 先停最深的子链，避免子链还在往已经停掉的父链回调
        for child in reversed(children):
            self._drop_runner(child, "cancelled")
        if parent_root:
            parent = self.runners.get(parent_root)
            if parent is not None and isinstance(parent.engine, FlowEngine) and parent.engine.waiting:
                parent.engine.fail_from_subflow("子工作流已停止")
                self._drop_runner(parent_root, "failure")
        self._drop_runner(root, "cancelled")

    def _make_engine(
        self, graph: Graph, start_node: str | None = None, workflow_root: str | None = None
    ) -> Engine | FlowEngine:
        """选执行器：**有步骤链就跑链，否则跑状态机**（两套并存，互不转换）。

        `start_node` 只有状态机用（热重载时要回到原来那个界面）；步骤链的位置在
        `graph.flow.steps` 里，不靠它。
        """
        raw = workflow_root if workflow_root is not None else (graph.base_dir or self.project.root or "")
        root = self._root_key(raw)

        def on_event(event: Any) -> None:
            self._on_engine_event(event, workflow_root=root)

        if flow_steps(graph):
            return FlowEngine(graph, self.controller, trace=self.trace, on_event=on_event, on_call=self._on_call_script)
        return Engine(
            graph,
            self.controller,
            trace=self.trace,
            on_event=on_event,
            on_call=self._on_call_script,
            start_node=start_node,
        )

    def _require_workflow(self) -> None:
        """写盘类操作的前置检查：没有选择工作流时报中文错误（契约 §2.4），不崩、不写到 cwd。"""
        if not self.project.root:
            raise ValueError("还没有选择工作流")

    def record_action(self, action: dict[str, Any], *, to: str | None = None) -> dict[str, Any]:
        self._require_workflow()
        if self._root_busy(self.project.root):
            raise ValueError("运行中不能修改流程图，请先停止")
        """把手动操作录成工作流里的一步。

        - 有 `flow.steps`：追加到链尾（步骤链真源，Automa 式画布会立刻看到）。
        - 否则：仍写 nodes/edges 状态图（兼容旧工作流 / 测试）。
        """
        with self.lock:
            parsed = Action.parse(action)
            if flow_steps(self.graph):
                return self._record_flow_action(parsed)
            # 这一步挂在哪个界面上？按"能录就录"的顺序找：
            #   ① 当前帧能确认在哪个界面（最准）
            #   ② 本会话内最近录过的界面（刚录完模板就点一下的常见场景）
            #   ③ 工作流里最后一个界面（应用重启后 _last_node_id 会丢，但 graph.json 还在）
            #   ④ 一个都没有 → 自动用当前画面建一个界面，别让用户卡在"录不了"
            # 刚录过模板（2 分钟内）时，用户下一步的意图就是"在这个界面上做"，
            # 优先用它：否则自动建的界面（模板就取自当前画面，必然匹配）会把归属抢走
            recent_node = self._last_node_id if self._last_node_id and time.time() - self._last_node_at < 120 else None
            source = recent_node or self.engine.locate() or self._latest_node_id()
            created_for_recording = None
            if source is None:
                source, created_for_recording = self._auto_create_node_for_recording()
            if created_for_recording:
                self.emit(
                    "engine.event",
                    {
                        "deviceId": self.device_id,
                        "seq": self._input_seq,
                        "ts": time.time(),
                        "type": "node_auto_created",
                        "node": created_for_recording,
                        "message": f"工作流里还没有界面，已用当前画面自动建了「{created_for_recording}」",
                    },
                )
            when = ""
            if source and source in self.graph.nodes:
                enter = self.graph.nodes[source].enter
                if enter:
                    when = enter[0]
            condition = {"all_of": [when]} if when else {"always": True}
            edge_id = f"e_rec_{len(self.graph.edges) + 1}"
            while any(edge.id == edge_id for edge in self.graph.edges):
                edge_id = f"{edge_id}_x"
            edge = Edge.from_dict(
                {
                    "id": edge_id,
                    "when": when or ALWAYS_LABEL,
                    "from": source,
                    "to": to,
                    # 一步只做一次：进入节点后 600ms 内不重复（避免 14fps 下连点）
                    "cooldown_ms": 600,
                    "condition": condition,
                    "action": parsed.to_dict(),
                }
            )
            self.graph.add_edge(edge)
            self.graph.validate()
            self.graph.save()
            self.reload_graph()
            self._pending_edge_id = edge_id
            self.emit(
                "engine.event",
                {
                    "deviceId": self.device_id,
                    "seq": self._input_seq,
                    "ts": time.time(),
                    "type": "action_recorded",
                    "node": source,
                    "edge": edge_id,
                    "message": f"录制步骤 {edge_id}: {parsed.describe()}",
                },
            )
            return {"edgeId": edge_id, "graph": self.graph.to_dict()}

    def _record_flow_action(self, parsed: Action) -> dict[str, Any]:
        step = action_to_flow_step(parsed)
        steps = list(flow_steps(self.graph))
        steps.append(step)
        self.graph.flow = validate_flow({"steps": steps}, set(self.graph.recognizers), strict=False)
        self.graph.validate()
        self.graph.save()
        self.reload_graph()
        step_id = str(step["id"])
        self.emit(
            "engine.event",
            {
                "deviceId": self.device_id,
                "seq": self._input_seq,
                "ts": time.time(),
                "type": "action_recorded",
                "node": step_id,
                "edge": None,
                "message": f"录制模块 {step_id}: {parsed.describe()}",
            },
        )
        return {"stepId": step_id, "edgeId": step_id, "graph": self.graph.to_dict()}

    def _latest_node_id(self) -> str | None:
        """工作流里最后一个界面（dict 保序，所以就是最后加进去的那个）。"""
        return next(reversed(self.graph.nodes), None) if self.graph.nodes else None

    def _auto_create_node_for_recording(self) -> tuple[str, str | None]:
        """当前画面还没对应界面时，自动建一个（顺手用画面中部做模板，好让状态机能认出它）。"""
        if self.last_frame is None:
            raise RuntimeError("还没有可用画面：先连接设备、等到画面出来，再开「录操作」")
        # id 分配走同一个 helper：这里的 index 还要拿来起名字（`界面3`），所以自己算一遍序号
        node_id = next_node_id(self.graph)
        index = int(node_id.removeprefix("n_"))
        name = f"界面{index}"

        # 用画面中部 60% 当模板：避开状态栏时钟/通知这类一直在变的地方
        height, width = self.last_frame.shape[:2]
        crop = self.last_frame[int(height * 0.2) : int(height * 0.8), int(width * 0.2) : int(width * 0.8)]
        label = f"{node_id}_screen"
        filename = f"{label}.png"
        cv2.imwrite(f"{self.project.templates_dir}/{filename}", crop)
        self.graph.add_recognizer(
            label,
            {
                "type": "template",
                "template": f"templates/{filename}",
                "threshold": 0.8,
                "roi": [0.2, 0.2, 0.6, 0.6],
            },
        )
        self.graph.upsert_node(Node(id=node_id, name=name, enter=[label]))
        self._last_node_id = node_id
        self._last_node_at = time.time()
        return node_id, name

    def graph_node_add(self, node_id: str | None, name: str | None, enter: list[str] | None) -> dict[str, Any]:
        self._require_workflow()
        with self.lock:
            result = graph_node_add(self.graph, node_id, name, enter)
            self.graph.save()
            self.reload_graph()
            return result

    def graph_node_update(self, node_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        self._require_workflow()
        with self.lock:
            result = graph_node_update(self.graph, node_id, patch)
            self.graph.save()
            self.reload_graph()
            return result

    def graph_node_remove(self, node_id: str) -> dict[str, Any]:
        self._require_workflow()
        with self.lock:
            result = graph_node_remove(self.graph, node_id)
            self.graph.save()
            self.reload_graph()
            return result

    def graph_edge_add(
        self,
        *,
        src: str | None,
        dst: str | None,
        when: str | None = None,
        action: dict[str, Any] | None = None,
        condition: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self._require_workflow()
        with self.lock:
            result = graph_edge_add(self.graph, src=src, dst=dst, when=when, action=action, condition=condition)
            self.graph.save()
            self.reload_graph()
            return result

    def _finish_record(
        self,
        *,
        label: str,
        spec: dict[str, Any],
        mode: str,
        search_mode: str,
        filename: str,
        rect: Rect,
        as_enter: bool,
        as_action_target: bool,
        node_id: str | None,
        node_name: str | None,
        allocate_node_id: bool,
    ) -> dict[str, Any]:
        """录制收尾（模板/颜色/OCR 共用）：注册识别器 + 建界面/边 + 落盘 + 热重载。"""
        self.graph.add_recognizer(label, spec)

        created_node = None
        # 步骤链工作流（含空 steps）：只落识别器 + 素材，不再建 nodes/edges
        if self.graph.flow is not None:
            self.graph.save()
            self.reload_graph()
            return {
                "label": label,
                "mode": mode,
                "search": search_mode,
                "template": f"templates/{filename}",
                "rect": rect.clamp().to_list(),
                "nodeId": None,
                "graph": self.graph.to_dict(),
            }

        if as_enter:
            if allocate_node_id:
                # "新建界面"：id 由引擎分配，绝不复用还活着的界面（见 record_template）
                node_id = next_node_id(self.graph)
            if node_id:
                node = self.graph.nodes.get(node_id) or Node(id=node_id, name=node_name or node_id, enter=[])
                if label not in node.enter:
                    node.enter.append(label)
                self.graph.upsert_node(node)
                created_node = node.id
                self._last_node_id = node.id
                self._last_node_at = time.time()
        # 录制流程自动接链：上一步录的动作边 → 指向这个新界面
        if created_node and self._pending_edge_id:
            for item in self.graph.edges:
                if item.id == self._pending_edge_id and not item.dst:
                    item.dst = created_node
            self._pending_edge_id = None
        # 建"动作目标"边：源必须是**图里现存的**节点。
        # `engine.current` 可能是一个已经被删掉的界面 —— 删节点不会让引擎游标回退，
        # 拿它当 from 会写出一条"from 指向不存在节点"的边，那份 graph.json 下次读就崩
        # （用户看到的是"这个工作流打不开了"）。
        source = self.engine.current
        if as_action_target and source and source in self.graph.nodes and created_node and created_node != source:
            self.graph.add_edge(
                Edge(
                    id=f"e_{label}",
                    when=label,
                    src=source,
                    dst=created_node,
                    action={"type": "click", "target": label},
                )
            )
        self.graph.save()
        self.reload_graph()
        return {
            "label": label,
            "mode": mode,  # template | color | ocr
            "search": search_mode,  # region | full（color 永远是 region）
            "template": f"templates/{filename}",
            "rect": rect.clamp().to_list(),
            # 这次挂到哪个界面上了（可能是引擎刚分配的）：界面拿它去选中/提示，
            # 不用自己猜"我传的 id 生效了没"
            "nodeId": created_node,
            "graph": self.graph.to_dict(),
        }

    def record_template(
        self,
        rect: Rect,
        label: str,
        threshold: float = 0.82,
        *,
        as_enter: bool = True,
        as_action_target: bool = True,
        node_id: str | None = None,
        node_name: str | None = None,
        allocate_node_id: bool = False,
        search: str = "region",
    ) -> dict[str, Any]:
        """从当前帧裁剪模板 → 落盘 → 注册识别器（并按需建节点/边）。

        `search`：`region`（默认）只在框选区域里找；`full` 是「这个目标可能出现在屏幕任意位置」，
        整帧搜索（命中后 rect 是它**当前**位置，所以点击仍然准）。
        纯色区域会降级成颜色识别器 —— 颜色识别不支持整帧搜索，`search` 对它无效。

        `allocate_node_id`：「这是**新**界面，id 由引擎分配」。
        界面上的 `nodeId` 是本地序号（`node_1`、`node_2`…），应用一重启就从 1 重新数，
        传下来必然撞上**上一次会话**建的界面 —— 引擎按 id 取到那个老节点，于是"我新录的界面"
        变成了老界面（用户看到的"换脸"）。所以"新建"这条路只能让引擎分配。
        """
        self._require_workflow()
        search_mode = normalize_search(search)
        if self._root_busy(self.project.root):
            raise ValueError("运行中不能修改流程图，请先停止")
        with self.lock, GRAPH_WRITE_LOCK:
            self.graph = _load_graph(self.project)
            if self.last_frame is None:
                raise RuntimeError("还没有可用画面，请先连接设备并等待首帧")
            x, y, w, h = rect.clamp().to_pixels(self.last_frame.shape[1::-1])
            crop = self.last_frame[y : y + h, x : x + w]
            if crop.size == 0:
                raise RuntimeError("框选区域为空")

            filename = f"{label}.png"
            # 每次录制都把裁下来的那一块存成素材（按识别器名），`templates/` 就是"录过什么"的台账；
            # 纯色区域虽然会降级成颜色识别器（用不上这张图），也照样留着 ——
            # 它是那次录制的实物证据，删除识别器时一起清掉（见 remove_recognizer）
            cv2.imwrite(f"{self.project.templates_dir}/{filename}", crop)

            # 纯色区域用模板匹配没有判别力（NCC 退化），自动改用颜色识别器
            std = float(crop.std())
            if std < 2.0:
                mean = crop.reshape(-1, 3).mean(axis=0)
                spec: dict[str, Any] = {
                    "type": "color",
                    "target_bgr": [round(float(value)) for value in mean],
                    "tolerance": 30,
                    "min_pixels": max(20, int(0.3 * crop.shape[0] * crop.shape[1])),
                    "roi": rect.clamp().to_list(),
                }
                mode = "color"
                # 颜色识别不支持整帧搜索：保持原区域，不写 search
                search_mode = "region"
            else:
                spec = {
                    "type": "template",
                    "template": f"templates/{filename}",
                    "threshold": round(float(threshold), 4),
                    "roi": rect.clamp().to_list(),
                    # 录制时的像素尺寸：换分辨率（同一台设备改了投屏尺寸、或换台机器）时，
                    # 识别器按这个比例自动缩放模板，不用重新录
                    "recorded_size": [int(self.last_frame.shape[1]), int(self.last_frame.shape[0])],
                }
                if search_mode == "full":
                    # roi 保留（切回 region 时要用），搜索时由 search 决定是否忽略它
                    spec["search"] = "full"
                mode = "template"
            return self._finish_record(
                label=label,
                spec=spec,
                mode=mode,
                search_mode=search_mode,
                filename=filename,
                rect=rect,
                as_enter=as_enter,
                as_action_target=as_action_target,
                node_id=node_id,
                node_name=node_name,
                allocate_node_id=allocate_node_id,
            )

    def record_ocr(
        self,
        rect: Rect,
        label: str,
        text: str,
        *,
        mode: str = "contains",
        threshold: float = 0.6,
        as_enter: bool = True,
        as_action_target: bool = True,
        node_id: str | None = None,
        node_name: str | None = None,
        allocate_node_id: bool = False,
        search: str = "region",
    ) -> dict[str, Any]:
        """框一块区域 + 填要认的字 → 注册 OCR 识别器（不再只录一张图）。

        和 `record_template` 的区别：模板匹配问"这块区域长得像不像我录的那张图"，OCR 问
        "这块区域里的字是不是/包含我写的这段"。所以 OCR 不需要模板文件 —— 但**照样存一张
        截图**进 `templates/`，作为"这段识别对应屏幕哪块"的实物证据（删识别器时一起清）。

        `mode`：`contains`（默认，包含就算）/ `equals`（完全相等）/ `regex`（正则，高级用法）；
        `threshold` 是 OCR 置信度下限（默认 0.6，比模板的 0.82 低 —— 识别模型自带噪声）。
        """
        self._require_workflow()
        search_mode = normalize_search(search)
        if self._root_busy(self.project.root):
            raise ValueError("运行中不能修改流程图，请先停止")
        if not str(text).strip():
            raise ValueError("OCR 识别器要填写「要识别的文字」")
        with self.lock, GRAPH_WRITE_LOCK:
            self.graph = _load_graph(self.project)
            if self.last_frame is None:
                raise RuntimeError("还没有可用画面，请先连接设备并等待首帧")
            x, y, w, h = rect.clamp().to_pixels(self.last_frame.shape[1::-1])
            crop = self.last_frame[y : y + h, x : x + w]
            if crop.size == 0:
                raise RuntimeError("框选区域为空")

            filename = f"{label}.png"
            cv2.imwrite(f"{self.project.templates_dir}/{filename}", crop)
            spec: dict[str, Any] = {
                "type": "ocr",
                "text": str(text),
                "mode": mode,
                "threshold": round(float(threshold), 4),
                "roi": rect.clamp().to_list(),
                # 证据截图登记成 template：界面取缩略图（`template.image`）和删识别器清文件
                # 都走同一条路。OCR 匹配不看这张图，它只负责回答"这段字对应屏幕哪块"。
                "template": f"templates/{filename}",
            }
            if search_mode == "full":
                spec["search"] = "full"
            return self._finish_record(
                label=label,
                spec=spec,
                mode="ocr",
                search_mode=search_mode,
                filename=filename,
                rect=rect,
                as_enter=as_enter,
                as_action_target=as_action_target,
                node_id=node_id,
                node_name=node_name,
                allocate_node_id=allocate_node_id,
            )

    def rename_recognizer(self, old: str, new: str) -> dict[str, Any]:
        self._require_workflow()
        """给识别器改名（级联所有引用），落盘 → 热重载。

        和 `remove_recognizer` 相反：改名是**可以**在还被引用时做的 ——
        因为引用会一起改（见 `Graph.rename_recognizer`）。
        改完必须 `save()` + `reload_graph()`：不重载的话，引擎里跑的还是旧标签的识别器，
        画面上的分数会一直挂在旧名字上。
        """
        with self.lock, GRAPH_WRITE_LOCK:
            self.graph = _load_graph(self.project)
            result = graph_rename_recognizer(self.graph, old, new)
            self.graph.save()
            self.reload_graph()
            return result

    def remove_recognizer(self, label: str) -> dict[str, Any]:
        self._require_workflow()
        """删掉一个模板/识别器。

        被别处引用时**拒绝删除**并说清被谁用了 —— 直接删会让工作流变成"引用了不存在的东西"，
        跑起来才发现（比删不掉更糟）。
        """
        with self.lock, GRAPH_WRITE_LOCK:
            self.graph = _load_graph(self.project)
            result = graph_remove_recognizer(self.graph, label, project_root=self.project.root)
            self.graph.save()
            self.reload_graph()
            return result

    def set_threshold(self, label: str, threshold: float) -> dict[str, Any]:
        self._require_workflow()
        with self.lock, GRAPH_WRITE_LOCK:
            self.graph = _load_graph(self.project)
            self.graph.set_threshold(label, threshold)
            self.graph.save()
            self.reload_graph()
            return {"label": label, "threshold": threshold}

    def set_recognizer_search(self, label: str, search: str) -> dict[str, Any]:
        """切换模板的搜索范围（region / full），落盘并热重载。

        和改阈值一样允许在运行中调整：搜索范围只影响"在哪找"，不改图结构。
        """
        self._require_workflow()
        with self.lock, GRAPH_WRITE_LOCK:
            self.graph = _load_graph(self.project)
            result = self.graph.set_recognizer_search(label, search)
            self.graph.save()
            self.reload_graph()
            return result

    def save_graph(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_workflow()
        if self._root_busy(self.project.root):
            raise ValueError("运行中不能修改流程图，请先停止")
        with self.lock, GRAPH_WRITE_LOCK:
            graph = Graph.from_dict(payload, base_dir=self.project.root, path=self.project.graph_path)
            graph.save()
            self.reload_graph()
            return graph.to_dict()

    def _on_call_script(self, script: str) -> None:
        """「运行子工作流」：切到那份工作流继续跑（由 SessionManager 统一处理，保证多设备一致）。"""
        if self.on_call_script is None:
            raise RuntimeError("当前环境不支持运行子工作流")
        self.on_call_script(script)

    def _root_key(self, root: str | None) -> str:
        value = (root or "").strip()
        return norm_path(value) if value else ""

    def _same_root(self, left: str | None, right: str | None) -> bool:
        a = self._root_key(left)
        b = self._root_key(right)
        return bool(a) and a == b

    def _runner_busy(self, runner: WorkflowRunner) -> bool:
        if isinstance(runner.engine, FlowEngine):
            return runner.engine.result == "running"
        return True

    def _any_running(self) -> bool:
        return any(self._runner_busy(runner) for runner in self.runners.values())

    def _root_busy(self, root: str | None) -> bool:
        runner = self.runners.get(self._root_key(root))
        return runner is not None and self._runner_busy(runner)

    def _ensure_runner(self, root: str) -> WorkflowRunner:
        existing = self.runners.get(root)
        if existing is not None:
            stale = (
                self._same_root(root, self.project.root)
                and existing.engine is not self.engine
                and not self._runner_busy(existing)
            )
            if not stale:
                return existing
            self.runners.pop(root, None)
        if self._same_root(root, self.project.root):
            runner = WorkflowRunner(root, self.graph, self.engine)
        else:
            graph = _load_graph(Project(root=root))
            runner = WorkflowRunner(root, graph, self._make_engine(graph, workflow_root=root))
        self.runners[root] = runner
        return runner

    def reload_graph(self) -> None:
        """换界面当前这份工作流的图；其它 Tab 正在跑的执行器原样保留。

        切回一份正在跑的工作流时，把画布接到那份执行器上（继续高亮当前步）。
        文件读不回来时**保留现有图继续跑**，只把原因记下来并上报。
        """
        viewed = self._root_key(self.project.root)
        existing = self.runners.get(viewed) if viewed else None
        if existing is not None and self._runner_busy(existing):
            self.graph = existing.graph
            self.engine = existing.engine
            self.graph_error = None
            logger.info("切回运行中的工作流（设备 %s）", self.device_id)
            return
        if existing is not None:
            self.runners.pop(viewed, None)
        current = self.engine.current
        try:
            graph = _load_graph(self.project)
        except Exception as error:
            self.graph_error = describe_graph_error(self.project, error)
            logger.error("状态图读取失败: %s", self.graph_error)
            self.emit(
                "engine.event",
                {
                    "deviceId": self.device_id,
                    "seq": self._input_seq,
                    "ts": time.time(),
                    "type": "graph_error",
                    "message": self.graph_error,
                },
            )
            return
        self.graph_error = None
        self.graph = graph
        self.engine = self._make_engine(self.graph, start_node=current, workflow_root=viewed)
        self.engine.reset_variables()
        self._arm_auto_trigger()

    def status(self) -> dict[str, Any]:
        with self.lock:
            orientation = getattr(self.controller, "orientation", None)
            orientation_code = orientation if isinstance(orientation, int) else None
            return {
                "deviceId": self.device_id,
                "uri": getattr(self.controller, "options", {}),
                "resolution": list(self.controller.resolution) if self.started else None,
                "running": self.running,
                "workflowRoot": self.graph.base_dir or "",
                "runningWorkflows": [runner.root for runner in self.runners.values() if self._runner_busy(runner)],
                "index": self.index,
                "fps": round(self.fps, 1),
                "captureMs": round(self.capture_ms, 1),
                "channel": getattr(self.controller, "channel", "unknown"),
                "streamFps": round(self.stream_fps, 1),
                # iOS 会变：界面方向（横屏坐标变换靠它，排错时一眼能看到）
                "variables": self.engine.variables.snapshot(),
                # 断点调试：暂停态与断点列表（界面/命令行都能看）
                "paused": self.engine.paused,
                "pausedAt": self.engine.paused_at,
                "breakpoints": sorted(self.engine.breakpoints),
                "orientation": orientation_code,
                "orientationName": ORIENTATION_LABELS.get(orientation_code, None) if orientation_code else None,
                "linkNote": getattr(self.controller, "link_note", ""),
                "linkFps": round(float(getattr(self.controller, "link_fps", 0.0)), 1),
                "node": self.engine.current,
                "pending": self.engine.pending.edge.id if self.engine.pending else None,
                "tick": self.engine.stats["ticks"],
                "stats": dict(self.engine.stats),
                "graph": json.loads(json.dumps(self.graph.to_dict())),
            }

    def timeline(self, limit: int = 60) -> dict[str, Any]:
        return {
            "frames": self.trace.recent_frames(limit),
            "events": self.trace.recent_events(limit),
            "evidence": self.evidence_bundle(),
        }

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
            engine.attach_evidence(RunEvidence(runner.root))
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
        previous = self.evidence.get(root)
        if previous is not None and previous is not evidence:
            previous.close()
        self.evidence[root] = evidence

    def evidence_bundle(self, workflow_root: str | None = None) -> dict[str, Any] | None:
        """最近一次运行的证据：目录 + 每一步的截图名（`None` = 还没跑过带证据的运行）。"""
        root = self._root_key(workflow_root or self.project.root)
        evidence = self.evidence.get(root)
        return evidence.to_dict() if evidence is not None else None

    def evidence_image(self, name: str, workflow_root: str | None = None) -> bytes | None:
        root = self._root_key(workflow_root or self.project.root)
        evidence = self.evidence.get(root)
        return evidence.image_bytes(name) if evidence is not None else None
