"""状态图属于**项目**，不属于设备：`graph.*` 不带 deviceId 时直接读/写项目里的 `graph.json`。

为什么要有这条契约：
- 没连设备时，画布也得能看到、能编辑当前脚本（以前 `graph.get` 强制要 deviceId，
  没设备就是空画布，还提示"先连接设备"，用户直接反问"我在 A 上录的流程在 B 上不能跑了是么"）；
- 真源只有一份：项目目录里的 `graph.json`。设备会话只是"在哪台机器上跑"，
  所以项目级改动落盘后必须让**所有已连接会话热重载**（各自的当前节点与运行态保留）。
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

from gamepilot.project import Project
from gamepilot.rpc.stdio import RpcServer
from gamepilot.session import DeviceSession


def _server(project_dir: Path) -> tuple[RpcServer, io.StringIO]:
    out = io.StringIO()
    server = RpcServer(io.StringIO(), out)
    server.sessions.use_project(str(project_dir))
    return server, out


def _call(server: RpcServer, out: io.StringIO, method: str, params: dict[str, Any]) -> dict[str, Any]:
    """发一条 RPC，取回响应（stdout 里可能混着通知）。"""
    out.seek(0)
    out.truncate(0)
    server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
    for line in out.getvalue().splitlines():
        message: dict[str, Any] = json.loads(line)
        if message.get("id") == 1:
            return message
    raise AssertionError(f"没有收到 {method} 的响应: {out.getvalue()!r}")


def _graph_json(project_dir: Path) -> dict[str, Any]:
    with open(project_dir / "graph.json", encoding="utf-8") as handle:
        payload: dict[str, Any] = json.load(handle)
    return payload


def test_graph_get_without_device_reads_the_project_script(tmp_path: Path) -> None:
    """**一个设备都没有**也能读到脚本 —— 这正是画布"没设备就空着"的病根。"""
    server, out = _server(tmp_path)

    created = _call(server, out, "graph.node.add", {"name": "主界面"})
    assert "error" not in created, created

    fetched = _call(server, out, "graph.get", {})
    assert "error" not in fetched, fetched
    nodes = fetched["result"]["nodes"]
    assert [node["name"] for node in nodes] == ["主界面"]
    # 真源落盘在项目目录，不是内存里的某个会话副本
    assert [node["name"] for node in _graph_json(tmp_path)["nodes"]] == ["主界面"]


def test_new_node_after_delete_never_overwrites_a_living_one(tmp_path: Path) -> None:
    """删过节点之后再新建，**不能**顶掉还活着的界面（用户看到的"节点换脸"）。

    病根：id 用 `len(nodes) + 1` 现算 —— 4 个节点删掉一个 → 3+1 = `n_4`，而 `n_4` 还在，
    `upsert_node` 按 id 覆盖 → 新建的界面变成了老界面（连同它的连线、界面私有的摆位记忆）。
    """
    server, out = _server(tmp_path)

    for index in range(1, 5):
        created = _call(server, out, "graph.node.add", {"name": f"界面{index}"})
        assert "error" not in created, created
    removed = _call(server, out, "graph.node.remove", {"nodeId": "n_1"})
    assert "error" not in removed, removed

    added = _call(server, out, "graph.node.add", {"name": "界面5"})

    assert "error" not in added, added
    assert added["result"]["nodeId"] == "n_5"
    # 四个界面都在：老的三个原样，新的是新加的那个
    assert [(node["id"], node["name"]) for node in _graph_json(tmp_path)["nodes"]] == [
        ("n_2", "界面2"),
        ("n_3", "界面3"),
        ("n_4", "界面4"),
        ("n_5", "界面5"),
    ]


def test_project_level_edits_land_in_graph_json(tmp_path: Path) -> None:
    server, out = _server(tmp_path)

    _call(server, out, "graph.node.add", {"name": "主界面", "nodeId": "main"})
    added = _call(
        server,
        out,
        "graph.edge.add",
        {"from": "main", "to": None, "condition": {"always": True}},
    )
    assert "error" not in added, added

    saved = _graph_json(tmp_path)
    assert [node["id"] for node in saved["nodes"]] == ["main"]
    assert [edge["id"] for edge in saved["edges"]] == [added["result"]["edgeId"]]


def test_project_level_edit_hot_reloads_connected_sessions(tmp_path: Path) -> None:
    """**在 A 上录的流程，B 上也跑得了**：项目级改动 → 所有会话热重载，读到的就是新脚本。"""
    from gamepilot.devices.mock import MockController

    server, out = _server(tmp_path)
    controller = MockController()
    controller.connect()
    session = DeviceSession(
        device_id="mock:mock-1",
        controller=controller,
        project=Project(root=str(tmp_path)).ensure(),
        emit=lambda method, params: None,
        fps=20.0,
        jpeg_width=320,
    )
    server.sessions.sessions["mock:mock-1"] = session
    try:
        assert session.graph.nodes == {}

        _call(server, out, "graph.node.add", {"name": "主界面", "nodeId": "main"})

        # 连着的设备（会话）也拿到了这份脚本 —— 不需要它自己再拉一次
        assert list(session.graph.nodes) == ["main"]
        # 会话级读取（老调用方）照样能用
        by_device = _call(server, out, "graph.get", {"deviceId": "mock:mock-1"})
        assert [node["id"] for node in by_device["result"]["nodes"]] == ["main"]
    finally:
        session.stop()


def test_graph_get_with_device_but_not_connected_is_a_clear_error(tmp_path: Path) -> None:
    """显式指定设备却没连上：报错要能看懂（前端据此回退到项目级读取）。"""
    server, out = _server(tmp_path)

    reply = _call(server, out, "graph.get", {"deviceId": "android:404"})

    assert "error" in reply
    assert "设备未连接" in json.dumps(reply, ensure_ascii=False)


def test_graph_get_without_any_script_is_an_empty_graph_not_an_error(tmp_path: Path) -> None:
    """还没选脚本时读图：给空图（一等状态），不要在日志里刷红字。"""
    server, out = _server(tmp_path)
    server.sessions.project = Project()  # 回到"什么都没选"

    reply = _call(server, out, "graph.get", {})

    assert "error" not in reply, reply
    assert reply["result"]["nodes"] == []
    assert reply["result"]["edges"] == []
