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
import os
from pathlib import Path
from typing import Any

import pytest

from gamepilot import library
from gamepilot.core.graph import Edge, Graph
from gamepilot.project import Project
from gamepilot.rpc.stdio import RpcServer
from gamepilot.session import DeviceSession


def _server(project_dir: Path) -> tuple[RpcServer, io.StringIO]:
    """构造一个**隔离**的服务端。

    必须把配置目录指到临时目录：`SessionManager.__init__` 会从 `config.json`
    恢复"上次的工作区"，不隔离的话测试会去读开发机上真实的工作区 ——
    那台机器上的图一旦有问题，整个套件就跟着红（反过来也可能改到真实数据）。
    """
    out = io.StringIO()
    keys = ("GAMEPILOT_CONFIG_DIR", "GAMEPILOT_WORKSPACE_DIR", "GAMEPILOT_PROJECT_DIR")
    previous = {key: os.environ.get(key) for key in keys}
    os.environ["GAMEPILOT_CONFIG_DIR"] = str(project_dir / ".config")
    os.environ["GAMEPILOT_WORKSPACE_DIR"] = str(project_dir / ".workspaces")
    os.environ.pop("GAMEPILOT_PROJECT_DIR", None)
    try:
        server = RpcServer(io.StringIO(), out)
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
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


@pytest.mark.parametrize("device_params", [{}, {"deviceId": ""}, {"deviceId": "offline-device"}])
def test_yolo_detail_reads_saved_examples_without_connected_device(
    tmp_path: Path, device_params: dict[str, Any]
) -> None:
    import cv2
    import numpy as np

    server, out = _server(tmp_path)
    templates = tmp_path / "templates"
    templates.mkdir(exist_ok=True)
    image_path = templates / "挑战_ai0.png"
    assert cv2.imwrite(str(image_path), np.zeros((12, 20, 3), dtype=np.uint8))
    graph = server.sessions.project_graph()
    graph.add_recognizer(
        "挑战",
        {
            "type": "yolo",
            "threshold": 0.63,
            "examples": [{"template": "templates/挑战_ai0.png", "rect": [0.1, 0.2, 0.3, 0.4], "label": "挑战"}],
        },
    )
    graph.save()
    before = (tmp_path / "graph.json").read_bytes()
    response = _call(server, out, "recognizer.detail", {"label": "挑战", **device_params})
    assert "error" not in response, response
    detail = response["result"]
    assert detail["threshold"] == 0.63
    assert len(detail["examples"]) == 1
    example = detail["examples"][0]
    assert example["image"].startswith("data:image/jpeg;base64,")
    assert (example["width"], example["height"]) == (20, 12)
    assert example["rect"] == [0.1, 0.2, 0.3, 0.4]
    assert not server.sessions.sessions
    assert (tmp_path / "graph.json").read_bytes() == before


def test_yolo_detail_without_device_preserves_recognizer_validation(tmp_path: Path) -> None:
    server, out = _server(tmp_path)
    missing = _call(server, out, "recognizer.detail", {"label": "missing"})
    assert "识别器不存在" in missing["error"]["message"]
    graph = server.sessions.project_graph()
    graph.add_recognizer("plain", {"type": "color", "roi": [0, 0, 1, 1], "target_bgr": [0, 0, 0]})
    graph.save()
    wrong_type = _call(server, out, "recognizer.detail", {"label": "plain"})
    assert "不是 AI 识别器" in wrong_type["error"]["message"]


def test_graph_node_update_persists_event_at(tmp_path: Path) -> None:
    server, out = _server(tmp_path)
    created = _call(server, out, "graph.node.add", {"name": "晨间签到"})
    node_id = created["result"]["nodeId"]
    updated = _call(
        server,
        out,
        "graph.node.update",
        {"nodeId": node_id, "patch": {"at": "09:30"}},
    )
    assert "error" not in updated, updated
    nodes = _graph_json(tmp_path)["nodes"]
    assert nodes[0]["at"] == "09:30"


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
    from gamepilot.devices.synthetic_test import SyntheticController

    server, out = _server(tmp_path)
    controller = SyntheticController()
    controller.connect()
    session = DeviceSession(
        device_id="synthetic:test-1",
        controller=controller,
        project=Project(root=str(tmp_path)).ensure(),
        emit=lambda method, params: None,
        fps=20.0,
        jpeg_width=320,
    )
    server.sessions.sessions["synthetic:test-1"] = session
    try:
        assert session.graph.nodes == {}

        _call(server, out, "graph.node.add", {"name": "主界面", "nodeId": "main"})

        # 连着的设备（会话）也拿到了这份脚本 —— 不需要它自己再拉一次
        assert list(session.graph.nodes) == ["main"]
        # 会话级读取（老调用方）照样能用
        by_device = _call(server, out, "graph.get", {"deviceId": "synthetic:test-1"})
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


def test_save_refuses_a_graph_whose_edge_points_at_a_deleted_node(tmp_path: Path) -> None:
    """落盘前必须自检：写出去的文件要能被读回来。

    历史上有一条路径（录模板时按 `engine.current` 建"动作目标"边）能写出
    "边的 from 指向已删除节点"的图，而 `save()` 不校验，于是文件安静地坏掉 ——
    应用下次启动恢复工作区时直接读崩，用户看到的是"这个工作流打不开了"。
    """
    graph = Graph.load(str(tmp_path / "graph.json"))
    graph.add_edge(
        Edge.from_dict(
            {
                "id": "e_main_1",
                "when": "",
                "from": "n_2",
                "to": None,
                "action": {"type": "click", "x": 0.5, "y": 0.5},
            }
        )
    )
    with pytest.raises(ValueError, match="from 节点不存在"):
        graph.save()
    # 没有把坏图写到盘上：文件要么不存在，要么还是能读的
    assert not (tmp_path / "graph.json").exists()


def test_startup_survives_a_workflow_whose_graph_is_unreadable(tmp_path: Path) -> None:
    """一个读不回来的 graph.json 不能让引擎起不来。

    真发生过：`library.list_workflows` 对每份图 `Graph.load()` 且不兜错，
    而启动要"恢复上次的工作区"，于是**一个坏工作流把整个应用拖死**（引擎都起不来）。
    现在：照旧列出它、把原因挂在 `error` 上，启动也照常。
    """
    workspace = tmp_path / "workspaces" / "默认"
    broken = workspace / "坏图"
    broken.mkdir(parents=True)
    (broken / "graph.json").write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": [],
                "edges": [{"id": "e1", "from": "n_gone", "to": None, "action": {"type": "click", "x": 0.5, "y": 0.5}}],
            }
        ),
        encoding="utf-8",
    )

    keys = ("GAMEPILOT_CONFIG_DIR", "GAMEPILOT_WORKSPACE_DIR", "GAMEPILOT_PROJECT_DIR")
    previous = {key: os.environ.get(key) for key in keys}
    os.environ["GAMEPILOT_CONFIG_DIR"] = str(tmp_path / "config")
    os.environ["GAMEPILOT_WORKSPACE_DIR"] = str(workspace)
    os.environ.pop("GAMEPILOT_PROJECT_DIR", None)
    try:
        # 起得来（不抛）就是这条测试的全部要求
        server = RpcServer(io.StringIO(), io.StringIO())
        items = library.list_workflows(str(workspace))
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    assert [item["name"] for item in items] == ["坏图"]
    assert items[0]["error"], "坏图要把原因报出来，界面才能提示"
    assert items[0]["nodes"] == 0
    # 恢复到的就是它（行为不变），但引擎活着
    assert server.sessions.project.root.endswith("坏图")
