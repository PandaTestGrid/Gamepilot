"""Shared session value types, limits and workflow loading helpers."""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from ..core.flow_engine import FlowEngine
from ..core.graph import Graph
from ..core.state_machine import Engine
from ..project import Project

# Preview history is bounded by both frame count and total JPEG bytes.
FRAME_HISTORY = 30
FRAME_HISTORY_BYTES = 512 * 1024 * 1024

# Capture must run at least as fast as the requested scrcpy preview rate.
SCRCPY_LOOP_FPS = 30.0
TIMING_LOG_SECONDS = 10.0

# EWMA compensates timer oversleep; the cap prevents runaway busy capture.
SLEEP_BIAS_MAX = 0.010
SLEEP_BIAS_ALPHA = 0.25

# Avoid alternating push/drop when capture and stream rates nearly coincide.
PUSH_TOLERANCE = 0.006

Emit = Callable[[str, dict[str, Any]], None]

LEGACY_GRAPH_EDIT_ERROR = (
    "该工作流已启用步骤链（flow.steps），不再支持 graph.node.* / graph.edge.*；"
    "请用 graph.save 更新 flow.steps，或用 record.action 录制。"
)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def flow_steps(graph: Graph) -> list[dict[str, Any]]:
    """这份图的步骤链里有几步（没有 flow 段 / 空链都返回空表）。"""
    return list((graph.flow or {}).get("steps") or [])


class WorkflowRunner:
    """一份工作流在某台设备上的独立执行器（Tab / 工作区互不影响）。"""

    def __init__(self, root: str, graph: Graph, engine: Engine | FlowEngine) -> None:
        self.root = root
        self.graph = graph
        self.engine = engine
        self.inflight = False
        self.cancelled = False
        self.last_index = 0


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
