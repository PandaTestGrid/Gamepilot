"""步骤链工作流禁止 legacy graph.node / graph.edge RPC。"""

from __future__ import annotations

import pytest

from gamepilot.core.graph import Graph
from gamepilot.session import (
    LEGACY_GRAPH_EDIT_ERROR,
    flow_steps,
    graph_edge_add,
    graph_node_add,
    reject_legacy_graph_edit,
)


def _flow_graph() -> Graph:
    graph = Graph.empty("/tmp/flow-test", path="")
    graph.flow = {"steps": [{"id": "trigger", "type": "schedule", "params": {"at": "09:00"}}]}
    return graph


def test_reject_when_flow_has_steps() -> None:
    graph = _flow_graph()
    assert flow_steps(graph)
    with pytest.raises(ValueError, match="步骤链"):
        reject_legacy_graph_edit(graph)


def test_legacy_node_add_still_works_without_flow() -> None:
    graph = Graph.empty("/tmp/legacy", path="")
    graph.add_recognizer("logo", {"type": "color", "color": [1, 1, 1]})
    result = graph_node_add(graph, None, "主界面", ["logo"])
    assert result["nodeId"].startswith("n_")


def test_flow_graph_blocks_node_add() -> None:
    with pytest.raises(ValueError, match=LEGACY_GRAPH_EDIT_ERROR[:6]):
        graph_node_add(_flow_graph(), None, "x", None)


def test_flow_graph_blocks_edge_add() -> None:
    with pytest.raises(ValueError, match=LEGACY_GRAPH_EDIT_ERROR[:6]):
        graph_edge_add(_flow_graph(), src="a", dst="b")
