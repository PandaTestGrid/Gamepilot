"""Graph-only editing operations shared by sessions and disconnected RPCs."""

from __future__ import annotations

import contextlib
import os
from typing import Any

from ..core.conditions import ALWAYS_LABEL
from ..core.graph import Edge, Graph, Node, validate_recognizer_label
from .models import (
    LEGACY_GRAPH_EDIT_ERROR,
    flow_steps,
)


def _node_ref(node: Node) -> str:
    """在"被谁用了"这类提示里怎么称呼一个节点。

    重名时**必须带上 id**：编辑过两个都叫「新界面」的节点（只差 id），
    提示里光写『新界面』等于没说，用户根本不知道该去改哪一个。
    """
    name = node.name or node.id
    return f"『{name}』（{node.id}）" if name != node.id else f"『{name}』"


def reject_legacy_graph_edit(graph: Graph) -> None:
    """步骤链为真源时禁止再改 nodes/edges（避免双轨 graph.json）。"""
    if flow_steps(graph):
        raise ValueError(LEGACY_GRAPH_EDIT_ERROR)


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
