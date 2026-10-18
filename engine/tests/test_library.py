"""工作流目录层（= 一个目录 = 一张状态图）与 `workflow.*` RPC 的测试。

全部在 `tmp_path` 上跑，**不碰仓库里的 `workspaces/`**：

- library 层：名称校验、列举（跳过无 graph.json 的目录、排序、计数字段、modified）、
  create / duplicate / rename / delete（真删除）的落盘行为；
- RPC 层：`RpcServer` + `io.StringIO`（不拉起子进程）跑通
  `workflow.create → workflow.duplicate → workflow.rename → workflow.delete`，
  断言契约里的返回形状（`{created/root/removed, current, items}`）与"当前工作流"的切换。
"""

from __future__ import annotations

import io
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from gamepilot import config, library, workspace
from gamepilot.core.graph import Graph
from gamepilot.rpc.stdio import RpcServer

# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #


def _write_workflow(
    base: Path,
    name: str,
    *,
    nodes: int = 0,
    edges: int = 0,
    recognizers: int = 0,
    templates: int = 0,
) -> Path:
    """造一个**合法**的工作流目录（graph.json + templates/），用于列举的计数断言。"""
    root = base / name
    (root / "templates").mkdir(parents=True)
    labels = [f"r{index}" for index in range(recognizers)]
    specs = {
        label: {"type": "color", "target_bgr": [10, 20, 30], "tolerance": 30, "min_pixels": 10} for label in labels
    }
    node_list = [
        {"id": f"n{index}", "name": f"界面{index}", "enter": [labels[index % len(labels)]] if labels else []}
        for index in range(nodes)
    ]
    edge_list = [
        {
            "id": f"e{index}",
            "when": labels[index % len(labels)],
            "action": {"type": "click", "target": labels[index % len(labels)]},
        }
        for index in range(edges)
    ]
    graph = Graph.from_dict({"nodes": node_list, "edges": edge_list, "recognizers": specs}, base_dir=str(root))
    graph.save(str(root / library.GRAPH_FILE))
    for index in range(templates):
        (root / "templates" / f"t{index}.png").write_bytes(b"png")
    return root


def _call(server: RpcServer, out: io.StringIO, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """走一次真实 JSON-RPC 往返（handle_line），返回 result。"""
    out.seek(0)
    out.truncate(0)
    server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}))
    frames = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
    assert frames, f"{method} 没有任何响应"
    response = frames[-1]
    assert "error" not in response, response
    result = response["result"]
    assert isinstance(result, dict), f"result 必须是对象: {result!r}"
    return result


def _call_error(
    server: RpcServer, out: io.StringIO, method: str, params: dict[str, Any] | None = None
) -> dict[str, Any]:
    out.seek(0)
    out.truncate(0)
    server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}))
    response = json.loads(out.getvalue().splitlines()[-1])
    assert "error" in response, response
    error = response["error"]
    assert isinstance(error, dict)
    return error


# --------------------------------------------------------------------------- #
# 名称校验
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("name", ["主页", "home", "home-1", "a b", "x_y.z", "A" * library.MAX_NAME_LEN])
def test_validate_name_accepts_legal_names(name: str) -> None:
    assert library.validate_name(name) == name


@pytest.mark.parametrize(
    "name",
    [
        "",
        "a/b",
        "a\\b",
        "a:b",
        "a*b",
        "a?b",
        'a"b',
        "a<b",
        "a>b",
        "a|b",
        ".hidden",
        "trailing.",
        ".",
        "A" * (library.MAX_NAME_LEN + 1),
    ],
)
def test_validate_name_rejects_with_chinese_message(name: str) -> None:
    with pytest.raises(ValueError) as excinfo:
        library.validate_name(name)
    message = str(excinfo.value)
    assert message, "错误信息不能为空"
    assert any("\u4e00" <= char <= "\u9fff" for char in message), f"错误信息要是中文、能直接给用户看: {message}"


def test_validate_name_subject_is_customisable() -> None:
    """规则是同一套，但错误文案要说是"谁"的名字（工作流名 / 别的场景）。"""
    with pytest.raises(ValueError, match="项目名不能包含这些字符"):
        library.validate_name("a/b", "项目名")
    with pytest.raises(ValueError, match="工作流名不能包含这些字符"):
        library.validate_name("a/b")


# --------------------------------------------------------------------------- #
# 列举
# --------------------------------------------------------------------------- #


def test_list_workflows_skips_trash_and_dirs_without_graph(tmp_path: Path) -> None:
    _write_workflow(tmp_path, "beta", nodes=2, edges=1, recognizers=1, templates=3)
    _write_workflow(tmp_path, "alpha")
    (tmp_path / "no-graph").mkdir()  # 没有 graph.json：不是工作流
    (tmp_path / ".trash" / "old-20240101-000000").mkdir(parents=True)  # 老版本留下的回收站：隐藏目录，不算工作流
    (tmp_path / "graph.json").write_text("{}", encoding="utf-8")  # 工作区根自己的文件更不算
    (tmp_path / "beta" / "templates" / "sub").mkdir()  # templates 只数文件，不数目录

    items = library.list_workflows(str(tmp_path))

    assert [item["name"] for item in items] == ["alpha", "beta"], "按 name 排序"
    assert set(items[0]) == {
        "name",
        "root",
        "nodes",
        "edges",
        "recognizers",
        "templates",
        "modified",
        "trigger",
    }
    assert (items[0]["nodes"], items[0]["edges"], items[0]["recognizers"], items[0]["templates"]) == (0, 0, 0, 0)
    assert (items[1]["nodes"], items[1]["edges"], items[1]["recognizers"], items[1]["templates"]) == (2, 1, 1, 3)
    assert items[1]["root"] == str(tmp_path / "beta")


def test_list_workflows_reports_first_trigger_condition(tmp_path: Path) -> None:
    root = _write_workflow(tmp_path, "beta")
    graph = Graph.load(str(root / library.GRAPH_FILE))
    graph.flow = {"steps": [{"id": "trigger", "type": "schedule", "params": {"at": "09:00"}}]}
    graph.save(str(root / library.GRAPH_FILE))

    item = next(entry for entry in library.list_workflows(str(tmp_path)) if entry["name"] == "beta")

    assert item["trigger"] == {"type": "schedule", "params": {"at": "09:00"}}


def test_list_workflows_on_missing_base_is_empty(tmp_path: Path) -> None:
    assert library.list_workflows(str(tmp_path / "nope")) == []


def test_workflow_modified_is_int_and_counts_graph(tmp_path: Path) -> None:
    """`modified` = max(graph.json mtime, 工作流目录 mtime)，是整数。"""
    root = _write_workflow(tmp_path, "alpha")
    assert isinstance(library.workflow_modified(str(root)), int)
    assert library.workflow_modified(str(root)) > 0


# --------------------------------------------------------------------------- #
# 新建 / 复制 / 改名 / 删除
# --------------------------------------------------------------------------- #


def test_create_workflow_makes_empty_graph_and_templates(tmp_path: Path) -> None:
    root = library.create_workflow(str(tmp_path), "新工作流")

    assert root == str(tmp_path / "新工作流")
    assert (tmp_path / "新工作流" / "templates").is_dir()
    graph = Graph.load(str(tmp_path / "新工作流" / library.GRAPH_FILE))
    assert graph.nodes == {} and graph.edges == [] and graph.specs == {}
    assert graph.flow is not None
    assert graph.flow["steps"][0]["type"] == "schedule"
    assert graph.flow["steps"][0]["params"]["at"] == "09:00"

    listing = library.list_workflows(str(tmp_path))
    assert [item["name"] for item in listing] == ["新工作流"]
    assert listing[0]["templates"] == 0


def test_create_workflow_rejects_bad_name_duplicate_and_missing_base(tmp_path: Path) -> None:
    library.create_workflow(str(tmp_path), "alpha")

    with pytest.raises(ValueError, match="已经有叫"):
        library.create_workflow(str(tmp_path), "alpha")
    with pytest.raises(ValueError, match="不能包含"):
        library.create_workflow(str(tmp_path), "a/b")
    with pytest.raises(ValueError, match="不存在"):
        library.create_workflow(str(tmp_path / "nope"), "alpha")


def test_duplicate_workflow_copies_graph_and_whole_templates_dir(tmp_path: Path) -> None:
    source = _write_workflow(tmp_path, "alpha", nodes=2, edges=1, recognizers=1, templates=1)
    (source / "templates" / "logo.png").write_bytes(b"png-bytes")

    copy = library.duplicate_workflow(str(source), str(tmp_path), "alpha-copy")

    assert copy == str(tmp_path / "alpha-copy")
    assert (tmp_path / "alpha-copy" / library.GRAPH_FILE).read_text(encoding="utf-8") == (
        source / library.GRAPH_FILE
    ).read_text(encoding="utf-8")
    assert sorted(item.name for item in (tmp_path / "alpha-copy" / "templates").iterdir()) == [
        "logo.png",
        "t0.png",
    ]
    assert (tmp_path / "alpha-copy" / "templates" / "logo.png").read_bytes() == b"png-bytes"

    counted = {item["name"]: item for item in library.list_workflows(str(tmp_path))}
    assert (counted["alpha-copy"]["nodes"], counted["alpha-copy"]["templates"]) == (2, 2)

    # 副本是独立的一份：改副本不影响原工作流
    (tmp_path / "alpha-copy" / library.GRAPH_FILE).write_text("{}", encoding="utf-8")
    assert set(Graph.load(str(source / library.GRAPH_FILE)).nodes) == {"n0", "n1"}


def test_duplicate_workflow_rejects_bad_source_duplicate_name_and_bad_name(tmp_path: Path) -> None:
    source = _write_workflow(tmp_path, "alpha")
    library.duplicate_workflow(str(source), str(tmp_path), "beta")

    with pytest.raises(ValueError, match="已经有叫「beta」的工作流了"):
        library.duplicate_workflow(str(source), str(tmp_path), "beta")
    with pytest.raises(ValueError, match="工作流目录不存在"):
        library.duplicate_workflow(str(tmp_path / "nope"), str(tmp_path), "gamma")
    with pytest.raises(ValueError, match="不能以"):
        library.duplicate_workflow(str(source), str(tmp_path), ".hidden")


def test_rename_workflow_moves_the_directory(tmp_path: Path) -> None:
    source = _write_workflow(tmp_path, "alpha", nodes=1, recognizers=1)

    renamed = library.rename_workflow(str(source), "beta")

    assert renamed == str(tmp_path / "beta")
    assert not source.exists(), "旧目录必须消失"
    assert set(Graph.load(str(tmp_path / "beta" / library.GRAPH_FILE)).nodes) == {"n0"}
    assert [item["name"] for item in library.list_workflows(str(tmp_path))] == ["beta"]


def test_rename_workflow_rejects_existing_target_and_missing_source(tmp_path: Path) -> None:
    library.create_workflow(str(tmp_path), "alpha")
    library.create_workflow(str(tmp_path), "beta")

    with pytest.raises(ValueError, match="已经有叫"):
        library.rename_workflow(str(tmp_path / "alpha"), "beta")
    with pytest.raises(ValueError, match="不能包含"):
        library.rename_workflow(str(tmp_path / "alpha"), "a:b")
    with pytest.raises(ValueError, match="不存在"):
        library.rename_workflow(str(tmp_path / "nope"), "gamma")

    # 改成同名：幂等，而不是报"已存在"（界面的改名框原样提交时会走到这里）
    assert library.rename_workflow(str(tmp_path / "alpha"), "alpha") == str(tmp_path / "alpha")


def test_remove_dir_deletes_for_real(tmp_path: Path) -> None:
    """删除是真删除：目录连内容一起没了，也不留回收站。"""
    source = _write_workflow(tmp_path, "alpha", nodes=1, recognizers=1, templates=1)

    removed = Path(library.remove_dir(str(source), "工作流目录"))

    assert not source.exists(), "目录真的删掉了"
    assert removed.resolve() == source.resolve()
    assert not (tmp_path / ".trash").exists(), "不再有回收站"
    assert library.list_workflows(str(tmp_path)) == []


def test_remove_dir_rejects_missing_dir(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="不存在"):
        library.remove_dir(str(tmp_path / "nope"), "工作流目录")


# --------------------------------------------------------------------------- #
# RPC 层：workflow.* 全流程（契约 v4 §2.2 / §2.3）
# --------------------------------------------------------------------------- #


@pytest.fixture()
def rpc(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[RpcServer, io.StringIO, Path]]:
    """真实 RpcServer + StringIO（不拉子进程）；工作区、配置目录、当前工作流都在 tmp_path 下。"""
    ws = tmp_path / "workspace"
    monkeypatch.setenv(workspace.WORKSPACE_DIR_ENV, str(ws))
    monkeypatch.setenv(config.CONFIG_DIR_ENV, str(tmp_path / "config"))
    monkeypatch.setenv("GAMEPILOT_PROJECT_DIR", str(tmp_path / "当前工作流"))
    ws.mkdir()
    out = io.StringIO()
    server = RpcServer(io.StringIO(), out)
    yield server, out, ws


def test_workflow_lifecycle_over_rpc(rpc: tuple[RpcServer, io.StringIO, Path]) -> None:
    server, out, ws = rpc
    manager = server.sessions
    before = _call(server, out, "project.get")["root"]

    # workflow.create：名字必填、建在工作区根下、建完切过去
    missing = _call_error(server, out, "workflow.create", {})
    assert "缺少参数 name" in missing["message"]
    created = _call(server, out, "workflow.create", {"name": "斗技"})
    assert created["created"] == str(ws / "斗技"), "工作流是工作区根的直接子目录"
    assert created["current"] == created["created"], "建完切过去"
    assert before != created["current"] and manager.project_info()["root"] == created["created"]
    assert (ws / "斗技" / library.GRAPH_FILE).is_file()
    assert (ws / "斗技" / "templates").is_dir()
    assert set(created["items"][0]) == {
        "name",
        "root",
        "nodes",
        "edges",
        "recognizers",
        "templates",
        "modified",
        "trigger",
    }

    # project.set 切到别处后，workflow.create 仍然建在当前**工作区**根下
    _call(server, out, "project.set", {"dir": str(ws / "斗技")})
    second = _call(server, out, "workflow.create", {"name": "御魂"})
    assert second["created"] == str(ws / "御魂")
    assert [item["name"] for item in second["items"]] == ["御魂", "斗技"], "按 name 排序"

    # workflow.duplicate：连 templates/ 一起复制，并切到副本
    (ws / "斗技" / "templates" / "logo.png").write_bytes(b"png")
    copied = _call(server, out, "workflow.duplicate", {"dir": str(ws / "斗技")})
    assert copied["created"] == str(ws / "斗技-副本")
    assert copied["current"] == copied["created"], "复制完切到副本"
    assert (ws / "斗技-副本" / "templates" / "logo.png").read_bytes() == b"png"
    assert next(item for item in copied["items"] if item["name"] == "斗技-副本")["templates"] == 1

    # workflow.rename 非当前工作流：当前不动
    renamed = _call(server, out, "workflow.rename", {"dir": str(ws / "斗技"), "name": "斗技改"})
    assert renamed["current"] == copied["current"]
    assert (ws / "斗技改").is_dir() and not (ws / "斗技").exists()
    assert [item["name"] for item in renamed["items"]] == ["御魂", "斗技-副本", "斗技改"], "按 name 排序"

    # workflow.rename 当前工作流：跟着改
    renamed = _call(server, out, "workflow.rename", {"dir": copied["current"], "name": "百鬼"})
    assert renamed["current"] == str(ws / "百鬼")
    assert manager.project_info()["root"] == renamed["current"]

    # workflow.delete 当前工作流：**真删除**，并切到剩下的第一个
    deleted = _call(server, out, "workflow.delete", {"dir": renamed["current"]})
    assert deleted["current"] == str(ws / "御魂"), "切到剩下的第一个（按 name 排序）"
    assert [item["name"] for item in deleted["items"]] == ["御魂", "斗技改"]
    assert not (ws / "百鬼").exists(), "目录真的删掉了"
    assert not (ws / ".trash").exists(), "不再有回收站"
    assert Path(str(deleted["removed"])).name == "百鬼"

    # 全删掉：当前工作流变空串（不自动补建任何东西）
    for item in _call(server, out, "workspace.tree")["workflows"]:
        last = _call(server, out, "workflow.delete", {"dir": item["root"]})
    assert last["items"] == [] and last["current"] == ""
    assert _call(server, out, "workspace.tree") == {"root": str(ws), "workflows": []}
    assert _call(server, out, "project.get")["root"] == ""


def test_workflow_errors_are_user_facing(rpc: tuple[RpcServer, io.StringIO, Path]) -> None:
    server, out, ws = rpc
    _call(server, out, "workflow.create", {"name": "斗技"})

    bad_name = _call_error(server, out, "workflow.create", {"name": "坏/名字"})
    assert bad_name["code"] == -32603
    assert "工作流名不能包含" in bad_name["message"]

    duplicate = _call_error(server, out, "workflow.create", {"name": "斗技"})
    assert "已经有叫「斗技」的工作流了" in duplicate["message"]

    missing = _call_error(server, out, "workflow.delete", {"dir": str(ws / "没有这个工作流")})
    assert "工作流目录不存在" in missing["message"]

    # 层错了要报错，不猜、不级联：workflow.delete 不删工作区本身
    wrong_layer = _call_error(server, out, "workflow.delete", {"dir": str(ws)})
    assert "工作流目录不存在" in wrong_layer["message"]
    assert ws.is_dir()

    no_dir = _call_error(server, out, "workflow.delete")
    assert "缺少参数 dir" in no_dir["message"]

    missing_dir = _call_error(server, out, "workflow.rename", {"dir": str(ws / "没有"), "name": "x"})
    assert "工作流目录不存在" in missing_dir["message"]
