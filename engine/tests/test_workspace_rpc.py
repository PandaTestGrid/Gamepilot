"""`workspace.*` / `workflow.*` / `project.get|set` 的 **RPC 层**测试（契约 v4 §2.1–§2.4）。

跑的是真实 `RpcServer` + `io.StringIO`（不拉子进程）；工作区与配置目录都在 `tmp_path` 下：
**不碰仓库里的 `workspaces/`，也不碰用户真实配置**。

覆盖：工作区 list/add/remove 的形状与幂等、显示名（含再 add 改名）、`trashRoot`/`trashed` 回传、
**接入空文件夹不落任何文件**、工作流层的建·改·删·复制（`name` 必填）、`current` 在各处的落点、
`modified`、树的两层形状、"没有当前工作区 / 没有当前工作流"的一等状态，以及全中文错误文案。
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from gamepilot import config, library, workspace
from gamepilot.devices.mock import MockController
from gamepilot.rpc.stdio import RpcServer
from gamepilot.session import DeviceSession


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
    """走一次必失败的 RPC，返回 error 对象（`-32603` + 中文文案）。"""
    out.seek(0)
    out.truncate(0)
    server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}))
    response = json.loads(out.getvalue().splitlines()[-1])
    assert "error" in response, response
    error = response["error"]
    assert isinstance(error, dict)
    assert error["code"] == -32603, error
    assert any("\u4e00" <= char <= "\u9fff" for char in error["message"]), f"错误要是中文: {error}"
    return error


def _files_under(path: Path) -> list[str]:
    return sorted(str(item.relative_to(path)) for item in path.rglob("*") if item.is_file())


def _workflow_in(base: Path, name: str) -> Path:
    """在（可能还不存在的）工作区根里造一个真工作流。"""
    base.mkdir(parents=True, exist_ok=True)
    return Path(library.create_workflow(str(base), name))


def _workflows(tree: dict[str, Any]) -> list[str]:
    return [item["name"] for item in tree["workflows"]]


@pytest.fixture()
def rpc(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[RpcServer, io.StringIO, Path]]:
    """真实 RpcServer；配置目录隔离，一开始什么工作区都没选。"""
    cfg_dir = tmp_path / "config"
    monkeypatch.setenv(config.CONFIG_DIR_ENV, str(cfg_dir))
    monkeypatch.delenv(config.WORKSPACE_DIR_ENV, raising=False)
    monkeypatch.delenv("GAMEPILOT_PROJECT_DIR", raising=False)
    out = io.StringIO()
    server = RpcServer(io.StringIO(), out)
    yield server, out, cfg_dir


# --------------------------------------------------------------------------- #
# workspace.list / add / remove
# --------------------------------------------------------------------------- #


def test_workspace_list_starts_empty(rpc: tuple[RpcServer, io.StringIO, Path]) -> None:
    """空配置：`active` 为 null、`items` 为空（不自动设成当前），但仍给出推荐目录与回收站。"""
    server, out, cfg_dir = rpc

    listing = _call(server, out, "workspace.list")

    assert set(listing) == {"active", "recommended", "items", "trashRoot"}
    assert listing["active"] is None
    assert listing["items"] == []
    assert listing["recommended"] == workspace.recommended_root()
    assert listing["trashRoot"] == os.path.join(str(cfg_dir), ".trash")
    assert not cfg_dir.exists(), "只读的 list 不该写配置"


def test_workspace_add_empty_dir_writes_nothing_and_uses_the_display_name(
    rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path
) -> None:
    """接入空文件夹：**磁盘一个文件都没有**；列表用界面输的显示名，不是目录名。"""
    server, out, cfg_dir = rpc
    root = tmp_path / "dir-name"

    added = _call(server, out, "workspace.add", {"dir": str(root), "name": "我的工作区"})

    assert set(added) == {"root", "name", "tree", "current", "items", "trashRoot"}
    assert added["root"] == str(root)
    assert added["name"] == "我的工作区"
    assert list(root.iterdir()) == [], "接入一个空文件夹时什么都不建"
    assert _files_under(root) == []
    assert added["tree"] == {"root": str(root), "workflows": []}
    assert added["current"] == "", "没有工作流 → 没有当前工作流（一等状态）"
    assert added["items"] == [{"name": "我的工作区", "root": str(root), "active": True, "exists": True}]
    assert added["trashRoot"] == os.path.join(str(cfg_dir), ".trash")
    assert server.sessions.project.root == ""


def test_workspace_add_second_dir_switches_and_appends(
    rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path
) -> None:
    server, out, _cfg_dir = rpc
    first = tmp_path / "一"
    second = tmp_path / "二"

    _call(server, out, "workspace.add", {"dir": str(first), "name": "第一个"})
    added = _call(server, out, "workspace.add", {"dir": str(second), "name": "第二个"})

    # 顺序 = 登记顺序（新加的追加在末尾），不按"最近使用"重排 —— 用户要求别把文件挪到最上面
    assert [item["name"] for item in added["items"]] == ["第一个", "第二个"]
    assert added["items"][1]["active"] is True
    assert _call(server, out, "workspace.list")["active"] == str(second)
    assert _call(server, out, "workspace.tree")["root"] == str(second)


def test_workspace_add_same_dir_is_idempotent_and_can_rename(
    rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path
) -> None:
    """同目录再 add：不报错、不重复；给名字就改名，**不给名字就保留原来的**。"""
    server, out, _cfg_dir = rpc
    first = tmp_path / "一"
    second = tmp_path / "二"
    _call(server, out, "workspace.add", {"dir": str(first), "name": "第一个"})
    _call(server, out, "workspace.add", {"dir": str(second), "name": "第二个"})

    renamed = _call(server, out, "workspace.add", {"dir": str(first), "name": "改过名字的"})
    assert [item["name"] for item in renamed["items"]] == ["改过名字的", "第二个"], "改名不换位置"
    assert renamed["name"] == "改过名字的" and renamed["root"] == str(first)

    again = _call(server, out, "workspace.add", {"dir": str(second)})
    assert [item["name"] for item in again["items"]] == ["改过名字的", "第二个"], "只切不改名、也不换位置"
    assert again["name"] == "第二个"
    assert len(again["items"]) == 2, "幂等：没有重复条目"
    assert list(first.iterdir()) == [], "接入/切换不往目录里写东西"


def test_workspace_add_uses_basename_when_no_name(rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path) -> None:
    server, out, _cfg_dir = rpc
    root = tmp_path / "my-game-bot"

    added = _call(server, out, "workspace.add", {"dir": str(root)})

    assert added["name"] == "my-game-bot"


def test_workspace_add_picks_the_first_workflow_as_current(
    rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path
) -> None:
    """工作区里已经有工作流 → add 完当前工作流切到第一个（按名字排序）。"""
    root = tmp_path / "现成的"
    _workflow_in(root, "b1")
    _workflow_in(root, "a1")
    server, out, _cfg_dir = rpc

    added = _call(server, out, "workspace.add", {"dir": str(root), "name": "现成的库"})

    assert added["current"] == str(root / "a1")
    assert server.sessions.project.root == added["current"]
    assert _workflows(added["tree"]) == ["a1", "b1"]


def test_workspace_add_rejects_relative_path(rpc: tuple[RpcServer, io.StringIO, Path]) -> None:
    server, out, _cfg_dir = rpc

    error = _call_error(server, out, "workspace.add", {"dir": "相对/路径"})

    assert "必须是绝对路径" in error["message"]
    assert _call(server, out, "workspace.list")["items"] == []


def test_workspace_add_accepts_tilde_path(
    rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    server, out, _cfg_dir = rpc

    added = _call(server, out, "workspace.add", {"dir": "~/我的游戏", "name": "家目录的工作区"})

    assert added["root"] == str(tmp_path / "我的游戏")
    assert os.path.isdir(tmp_path / "我的游戏") and list((tmp_path / "我的游戏").iterdir()) == []


def test_workspace_add_create_false_needs_an_existing_dir(
    rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path
) -> None:
    server, out, _cfg_dir = rpc

    error = _call_error(server, out, "workspace.add", {"dir": str(tmp_path / "没有"), "create": False})

    assert "工作区目录不存在" in error["message"]


def test_workspace_remove_moves_files_to_the_global_trash(
    rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path
) -> None:
    """`deleteFiles` 默认 true：整个目录进全局回收站；当前工作区没了就清空状态。"""
    server, out, cfg_dir = rpc
    root = tmp_path / "我的游戏"
    _call(server, out, "workspace.add", {"dir": str(root), "name": "我的工作区"})
    _call(server, out, "workflow.create", {"name": "斗技"})

    removed = _call(server, out, "workspace.remove", {"dir": str(root)})

    assert set(removed) == {"active", "items", "tree", "current", "trashed", "trashRoot"}
    assert removed["active"] is None
    assert removed["items"] == []
    assert removed["tree"] == {"root": "", "workflows": []}
    assert removed["current"] == ""
    assert removed["trashRoot"] == os.path.join(str(cfg_dir), ".trash")
    trashed = Path(str(removed["trashed"]))
    assert trashed.parent == cfg_dir / ".trash"
    assert re.fullmatch(r"我的游戏-\d{8}-\d{6}", trashed.name)
    assert (trashed / "斗技" / library.GRAPH_FILE).is_file(), "工作流跟着工作区进回收站，能捞回来"
    assert not root.exists()


def test_workspace_remove_without_files_keeps_disk_and_returns_empty_trash(
    rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path
) -> None:
    server, out, _cfg_dir = rpc
    root = tmp_path / "我的游戏"
    _call(server, out, "workspace.add", {"dir": str(root), "name": "我的工作区"})
    _call(server, out, "workflow.create", {"name": "斗技"})

    removed = _call(server, out, "workspace.remove", {"dir": str(root), "deleteFiles": False})

    assert removed["trashed"] == "", "只移出列表：没有回收站路径（空串，前端类型是 string）"
    assert (root / "斗技" / library.GRAPH_FILE).is_file(), "磁盘一个字节不动"
    assert removed["items"] == [] and removed["active"] is None


def test_workspace_remove_switches_to_the_next_existing(
    rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path
) -> None:
    server, out, _cfg_dir = rpc
    keeper = tmp_path / "留下的"
    _workflow_in(keeper, "斗技")
    _call(server, out, "workspace.add", {"dir": str(keeper), "name": "留下的"})
    doomed = tmp_path / "删掉的"
    _call(server, out, "workspace.add", {"dir": str(doomed), "name": "删掉的"})

    removed = _call(server, out, "workspace.remove", {"dir": str(doomed)})

    assert removed["active"] == str(keeper)
    assert removed["current"] == str(keeper / "斗技"), "当前工作流跟着切到新工作区"
    assert server.sessions.project.root == removed["current"]
    assert [item["name"] for item in removed["items"]] == ["留下的"]


def test_workspace_remove_unknown_reports_chinese(rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path) -> None:
    server, out, _cfg_dir = rpc

    error = _call_error(server, out, "workspace.remove", {"dir": str(tmp_path / "没登记过的")})

    assert "没有这个工作区" in error["message"]


def test_workspace_list_marks_missing_directories(rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path) -> None:
    """目录被用户在 Finder 里删了：`exists: false`，但还在列表里。"""
    server, out, _cfg_dir = rpc
    root = tmp_path / "被删掉的"
    _call(server, out, "workspace.add", {"dir": str(root), "name": "被删掉的"})
    shutil.rmtree(root)

    listing = _call(server, out, "workspace.list")

    assert listing["items"] == [{"name": "被删掉的", "root": str(root), "active": True, "exists": False}]


# --------------------------------------------------------------------------- #
# workflow.*
# --------------------------------------------------------------------------- #


def test_workflow_create_requires_a_name(rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path) -> None:
    """`name` 必填：界面会弹输入框让你起名，引擎不许"点一下直接建"。

    （曾经试过"省名字就自动命名成『新会话』"，用户当场否掉：他要的是点 ＋ 之后自己输名字。）
    """
    server, out, _cfg_dir = rpc
    root = tmp_path / "我的游戏"
    _call(server, out, "workspace.add", {"dir": str(root), "name": "我的工作区"})

    assert "缺少参数 name" in _call_error(server, out, "workflow.create", {})["message"]
    assert "缺少参数 name" in _call_error(server, out, "workflow.create", {"name": "   "})["message"]
    assert list(root.iterdir()) == [], "缺名字时一个目录都不该建"


def test_workflow_create_without_a_workspace_reports_chinese(rpc: tuple[RpcServer, io.StringIO, Path]) -> None:
    server, out, _cfg_dir = rpc

    error = _call_error(server, out, "workflow.create", {"name": "斗技"})

    assert "请先选择工作区" in error["message"]


def test_workflow_create_lands_in_the_workspace_root_and_switches(
    rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path
) -> None:
    server, out, _cfg_dir = rpc
    root = tmp_path / "我的游戏"
    _call(server, out, "workspace.add", {"dir": str(root), "name": "我的工作区"})

    created = _call(server, out, "workflow.create", {"name": "斗技"})

    assert set(created) == {"created", "current", "items"}
    assert created["created"] == str(root / "斗技"), "工作流建在工作区根下（不再有项目那一层）"
    assert (root / "斗技" / library.GRAPH_FILE).is_file()
    assert (root / "斗技" / "templates").is_dir()
    assert created["current"] == created["created"], "建完切过去"
    assert server.sessions.project.root == created["created"]
    assert set(created["items"][0]) == {"name", "root", "nodes", "edges", "recognizers", "templates", "modified"}


def test_workflow_items_and_tree_carry_modified(rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path) -> None:
    server, out, _cfg_dir = rpc
    root = tmp_path / "我的游戏"
    _call(server, out, "workspace.add", {"dir": str(root), "name": "我的工作区"})
    created = _call(server, out, "workflow.create", {"name": "斗技"})
    (Path(created["created"]) / "templates" / "logo.png").write_bytes(b"png")

    renamed = _call(server, out, "workflow.rename", {"dir": created["created"], "name": "御魂"})
    items = renamed["items"]
    tree = _call(server, out, "workspace.tree")

    assert set(tree) == {"root", "workflows"}
    assert tree["root"] == str(root)
    assert _workflows(tree) == ["御魂"], "工作流是工作区根的直接子目录"
    assert set(tree["workflows"][0]) == {"name", "root", "nodes", "edges", "recognizers", "templates", "modified"}
    assert isinstance(tree["workflows"][0]["modified"], int) and tree["workflows"][0]["modified"] > 0
    assert items[0]["templates"] == 1
    assert items[0]["modified"] == tree["workflows"][0]["modified"]


def test_workflow_rename_follows_current(rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path) -> None:
    server, out, _cfg_dir = rpc
    root = tmp_path / "我的游戏"
    _call(server, out, "workspace.add", {"dir": str(root), "name": "我的工作区"})
    current = _call(server, out, "workflow.create", {"name": "斗技"})["current"]

    renamed = _call(server, out, "workflow.rename", {"dir": current, "name": "御魂"})

    assert set(renamed) == {"root", "current", "items"}
    assert renamed["root"] == str(root / "御魂")
    assert renamed["current"] == renamed["root"], "动的是当前工作流：跟着改"
    assert server.sessions.project.root == renamed["root"]
    assert not Path(current).exists()
    assert _workflows(_call(server, out, "workspace.tree")) == ["御魂"]


def test_workflow_rename_other_keeps_current(rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path) -> None:
    server, out, _cfg_dir = rpc
    root = tmp_path / "我的游戏"
    _call(server, out, "workspace.add", {"dir": str(root), "name": "我的工作区"})
    _call(server, out, "workflow.create", {"name": "斗技"})
    current = _call(server, out, "workflow.create", {"name": "御魂"})["current"]

    renamed = _call(server, out, "workflow.rename", {"dir": str(root / "斗技"), "name": "斗技改"})

    assert renamed["current"] == current, "改的不是当前工作流：当前不动"
    assert renamed["root"] == str(root / "斗技改")


def test_workflow_duplicate_default_name_and_switch(rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path) -> None:
    server, out, _cfg_dir = rpc
    root = tmp_path / "我的游戏"
    _call(server, out, "workspace.add", {"dir": str(root), "name": "我的工作区"})
    source = Path(_call(server, out, "workflow.create", {"name": "斗技"})["created"])
    (source / "templates" / "logo.png").write_bytes(b"png-bytes")

    first = _call(server, out, "workflow.duplicate", {"dir": str(source)})
    second = _call(server, out, "workflow.duplicate", {"dir": str(source)})

    assert first["created"] == str(root / "斗技-副本")
    assert second["created"] == str(root / "斗技-副本2")
    assert (Path(first["created"]) / "templates" / "logo.png").read_bytes() == b"png-bytes"
    assert second["current"] == second["created"], "复制完切到副本"
    assert second["items"][0]["templates"] == 1


def test_workflow_delete_current_switches_to_the_next(rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path) -> None:
    server, out, _cfg_dir = rpc
    root = tmp_path / "我的游戏"
    _call(server, out, "workspace.add", {"dir": str(root), "name": "我的工作区"})
    keeper = _call(server, out, "workflow.create", {"name": "御魂"})
    doomed = _call(server, out, "workflow.create", {"name": "斗技"})

    deleted = _call(server, out, "workflow.delete", {"dir": doomed["created"]})

    assert set(deleted) == {"trashed", "current", "items"}
    assert Path(str(deleted["trashed"])).parent == root / ".trash"
    assert re.fullmatch(r"斗技-\d{8}-\d{6}", Path(str(deleted["trashed"])).name)
    assert deleted["current"] == keeper["created"], "删当前工作流 → 切到剩下的第一个"
    assert [item["name"] for item in deleted["items"]] == ["御魂"]
    assert not Path(doomed["created"]).exists()


def test_workflow_delete_all_keeps_the_empty_state(rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path) -> None:
    """一个工作流都不剩 → 保持"没有当前工作流"（不自动建任何东西）。"""
    server, out, _cfg_dir = rpc
    root = tmp_path / "我的游戏"
    _call(server, out, "workspace.add", {"dir": str(root), "name": "我的工作区"})
    only = _call(server, out, "workflow.create", {"name": "斗技"})

    deleted = _call(server, out, "workflow.delete", {"dir": only["created"]})

    assert deleted["items"] == []
    assert deleted["current"] == ""
    assert server.sessions.project.root == ""
    assert _call(server, out, "project.get") == {
        "root": "",
        "graphPath": "",
        "nodes": 0,
        "edges": 0,
        "recognizers": 0,
        "templates": 0,
    }
    assert sorted(item.name for item in root.iterdir()) == [".trash"], "只剩回收站，不自动补建任何东西"


def test_workflow_delete_other_keeps_current(rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path) -> None:
    server, out, _cfg_dir = rpc
    root = tmp_path / "我的游戏"
    _call(server, out, "workspace.add", {"dir": str(root), "name": "我的工作区"})
    _call(server, out, "workflow.create", {"name": "御魂"})
    current = _call(server, out, "workflow.create", {"name": "斗技"})["current"]

    deleted = _call(server, out, "workflow.delete", {"dir": str(root / "御魂")})

    assert deleted["current"] == current
    assert [item["name"] for item in deleted["items"]] == ["斗技"]


# --------------------------------------------------------------------------- #
# "没有当前工作流"是一等状态
# --------------------------------------------------------------------------- #


def test_project_get_without_a_workflow_is_empty_not_fake(rpc: tuple[RpcServer, io.StringIO, Path]) -> None:
    server, out, _cfg_dir = rpc

    info = _call(server, out, "project.get")

    assert info == {"root": "", "graphPath": "", "nodes": 0, "edges": 0, "recognizers": 0, "templates": 0}
    assert server.sessions.project.root == ""


def test_template_image_without_a_workflow_reports_chinese(rpc: tuple[RpcServer, io.StringIO, Path]) -> None:
    server, out, _cfg_dir = rpc

    error = _call_error(server, out, "template.image", {"label": "logo"})

    assert "还没有选择工作流" in error["message"]


def test_graph_writes_without_a_workflow_report_chinese(rpc: tuple[RpcServer, io.StringIO, Path]) -> None:
    """写盘类调用在没有当前工作流时要报中文错误，不能往 cwd 里写东西、也不能崩。"""
    server, _out, _cfg_dir = rpc
    manager = server.sessions
    controller = MockController()
    controller.connect()
    session = DeviceSession("mock:test", controller, manager.project, manager.emit)
    try:
        with pytest.raises(ValueError, match="还没有选择工作流"):
            session.save_graph({"nodes": [], "edges": []})
        with pytest.raises(ValueError, match="还没有选择工作流"):
            session.set_threshold("logo", 0.9)
        assert session.graph.path == "", "空状态的状态图没有落盘位置（绝不写 cwd）"
    finally:
        session.stop()


def test_set_project_then_get(rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path) -> None:
    """`project.set` 语义不变（不存在就建），`project.get` 回显。"""
    server, out, _cfg_dir = rpc
    target = tmp_path / "手动选的工作流"

    switched = _call(server, out, "project.set", {"dir": str(target)})
    assert switched["root"] == str(target)
    assert (target / "templates").is_dir()

    assert _call(server, out, "project.get")["root"] == str(target)


# --------------------------------------------------------------------------- #
# 错误文案
# --------------------------------------------------------------------------- #


def test_errors_are_user_facing(rpc: tuple[RpcServer, io.StringIO, Path], tmp_path: Path) -> None:
    server, out, _cfg_dir = rpc
    root = tmp_path / "我的游戏"
    _call(server, out, "workspace.add", {"dir": str(root), "name": "我的工作区"})
    created = _call(server, out, "workflow.create", {"name": "斗技"})

    assert "工作流名不能包含" in _call_error(server, out, "workflow.create", {"name": "坏/名字"})["message"]
    assert "已经有叫「斗技」的工作流了" in _call_error(server, out, "workflow.create", {"name": "斗技"})["message"]
    assert (
        "工作流目录不存在"
        in _call_error(server, out, "workflow.rename", {"dir": str(root / "没有"), "name": "x"})["message"]
    )
    assert "工作流目录不存在" in _call_error(server, out, "workflow.delete", {"dir": str(root / "没有")})["message"]
    assert "工作流目录不存在" in _call_error(server, out, "workflow.delete", {"dir": str(root)})["message"]
    _call(server, out, "workflow.create", {"name": "御魂"})
    assert (
        "已经有叫「御魂」的工作流了"
        in _call_error(server, out, "workflow.rename", {"dir": created["created"], "name": "御魂"})["message"]
    )
    assert "缺少参数 dir" in _call_error(server, out, "workspace.add")["message"]
    assert "缺少参数 dir" in _call_error(server, out, "workspace.remove")["message"]
    assert "缺少参数 dir" in _call_error(server, out, "workflow.delete")["message"]
