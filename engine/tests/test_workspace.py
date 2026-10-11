"""工作区层的**文件系统 + 列表状态**测试（契约 v4 §1 / §2.1 / §2.3）。

覆盖：

- 工作区可以有多个：`Workspaces` 的 add / remove / 最近使用排序 / 幂等 / 显示名 / 配置持久化；
- **接入一个空文件夹时什么都不建**（磁盘上一个文件都没有，"＋工作流"是用户的事）；
- 工作流层：`library` 的建 / 改名 / 复制 / 删（进工作区 `.trash/`）、`modified` 字段、名字校验；
- "没有当前工作区 / 没有当前工作流"是一等状态（空串，不伪造路径）。

全部在 `tmp_path` 上跑（配置目录也隔离），**不碰仓库里的 `workspaces/`，也不碰用户真实配置**。
"""

from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

import pytest

from gamepilot import config, library, workspace
from gamepilot.core.graph import Graph


def _workflow(base: Path, name: str) -> Path:
    """在工作区根里造一个真工作流（graph.json + templates/）。"""
    base.mkdir(parents=True, exist_ok=True)
    return Path(library.create_workflow(str(base), name))


def _files_under(path: Path) -> list[str]:
    return sorted(str(item.relative_to(path)) for item in path.rglob("*") if item.is_file())


def _register(base: Path, name: str | None = None) -> Path:
    workspace.Workspaces().add(str(base), name=name)
    return base


@pytest.fixture()
def cfg_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """配置目录 → tmp_path/config；不进逃生口模式（要真的读写 config.json）。"""
    root = tmp_path / "config"
    monkeypatch.setenv(config.CONFIG_DIR_ENV, str(root))
    monkeypatch.delenv(config.WORKSPACE_DIR_ENV, raising=False)
    return root


@pytest.fixture()
def ws(tmp_path: Path, cfg_dir: Path) -> Path:
    """当前工作区：走真实的 add 流程（**不建任何目录内容**）。"""
    return _register(tmp_path / "工作区")


# --------------------------------------------------------------------------- #
# 路径与常量
# --------------------------------------------------------------------------- #


def test_layout_constants_and_paths(tmp_path: Path) -> None:
    assert workspace.WORKSPACE_NAME == "默认"
    assert workspace.WORKSPACE_ROOT == "workspaces"
    assert workspace.TRASH_DIR == ".trash"
    assert workspace.WORKSPACE_DIR_ENV == "GAMEPILOT_WORKSPACE_DIR"
    assert workspace.recommended_root() == os.path.join(workspace.repo_root(), "workspaces", "默认")

    assert workspace.workspace_root(str(tmp_path)) == str(tmp_path)
    assert workspace.trash_root(str(tmp_path)) == str(tmp_path / ".trash")
    assert workspace.global_trash_root() == os.path.join(config.config_dir(), ".trash")
    assert library.GRAPH_FILE == "graph.json"


def test_normalize_dir_accepts_absolute_and_tilde_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`workspace.add` 只接受绝对路径或 `~` 开头 —— 相对路径歧义，直接中文报错。"""
    monkeypatch.setenv("HOME", str(tmp_path))

    assert workspace.normalize_dir(str(tmp_path / "a")) == str(tmp_path / "a")
    assert workspace.normalize_dir("~/文档/我的工作区") == str(tmp_path / "文档" / "我的工作区")
    with pytest.raises(ValueError, match="必须是绝对路径"):
        workspace.normalize_dir("相对路径")
    with pytest.raises(ValueError, match="缺少工作区路径"):
        workspace.normalize_dir("   ")


def test_normalize_dir_resolves_symlinks(tmp_path: Path) -> None:
    """回给前端的路径要和它自己的 `Path.resolve()` 一致（macOS 上 /var → /private/var）。"""
    link = tmp_path / "link"
    link.symlink_to(tmp_path)
    assert workspace.normalize_dir(str(link / "子目录")) == str(tmp_path / "子目录")


def test_no_current_workspace_is_an_empty_state(cfg_dir: Path) -> None:
    """什么都没选时：树是空串根 + 空工作流列表，不伪造路径、不建目录。"""
    assert workspace.active_root() == ""
    assert workspace.workspace_root() == ""
    assert workspace.list_workflows() == []
    assert workspace.tree() == {"root": "", "workflows": []}
    assert workspace.first_workflow() is None
    assert not cfg_dir.exists(), "什么都没选时不该写配置、也不该建目录"


# --------------------------------------------------------------------------- #
# 自动命名 / 工作流摘要
# --------------------------------------------------------------------------- #


def test_auto_name_numbered_takes_first_gap() -> None:
    assert workspace.auto_name([], "工作流") == "工作流1"
    assert workspace.auto_name(["工作流1"], "工作流") == "工作流2"
    assert workspace.auto_name(["工作流1", "工作流3"], "工作流") == "工作流2"
    assert workspace.auto_name([], "斗技-副本", plain_first=True) == "斗技-副本"
    assert workspace.auto_name(["斗技-副本"], "斗技-副本", plain_first=True) == "斗技-副本2"
    assert workspace.auto_name(["斗技-副本", "斗技-副本2"], "斗技-副本", plain_first=True) == "斗技-副本3"


def test_list_workflows_is_the_direct_children_with_graph(ws: Path) -> None:
    """工作流 = 含 `graph.json` 的**直接子目录**；隐藏目录/没有图的目录都不算。"""
    beta = _workflow(ws, "beta")
    _workflow(ws, "alpha")
    (ws / ".隐藏").mkdir()
    (ws / ".trash" / "old-20240101-000000").mkdir(parents=True)
    (ws / "没有图的目录").mkdir()
    (ws / "graph.json").write_text("{}", encoding="utf-8")  # 工作区根自己的文件更不算
    (beta / "templates" / "t1.png").write_bytes(b"png")
    (beta / "templates" / "sub").mkdir()  # templates 只数文件，不数目录

    items = workspace.list_workflows()

    assert [item["name"] for item in items] == ["alpha", "beta"], "按 name 排序"
    assert set(items[0]) == {"name", "root", "nodes", "edges", "recognizers", "templates", "modified"}
    assert items[0]["root"] == str(ws / "alpha")
    assert (items[0]["nodes"], items[0]["edges"], items[0]["recognizers"], items[0]["templates"]) == (0, 0, 0, 0)
    assert items[1]["templates"] == 1
    assert isinstance(items[1]["modified"], int) and items[1]["modified"] > 0
    assert workspace.tree() == {"root": str(ws), "workflows": items}
    assert workspace.first_workflow() == str(ws / "alpha")


def test_workflow_modified_tracks_the_newest_change(ws: Path) -> None:
    """`modified` = max(graph.json mtime, 工作流目录 mtime) 的 epoch 秒整数。"""
    root = _workflow(ws, "斗技")
    stamp = int(os.path.getmtime(root / library.GRAPH_FILE))

    assert library.workflow_modified(str(root)) >= stamp
    future = stamp + 500
    os.utime(root / library.GRAPH_FILE, (future, future))
    assert library.workflow_modified(str(root)) == future
    assert workspace.list_workflows()[0]["modified"] == future


def test_list_workflows_on_missing_workspace_is_empty(tmp_path: Path) -> None:
    assert library.list_workflows(str(tmp_path / "没有这个工作区")) == []
    assert workspace.list_workflows(str(tmp_path / "没有这个工作区")) == []


# --------------------------------------------------------------------------- #
# 工作区列表（Workspaces）：add / remove / 显示名 / 持久化
# --------------------------------------------------------------------------- #


def test_add_empty_dir_creates_nothing_at_all(tmp_path: Path, cfg_dir: Path) -> None:
    """接入一个空文件夹：**磁盘上一个文件都没有**（不建默认项目、不建 .trash、不建工作流）。"""
    root = tmp_path / "我的游戏"

    added = workspace.Workspaces().add(str(root), name="我的工作区")

    assert added == str(root)
    assert list(root.iterdir()) == [], "连一个目录都不该建"
    assert _files_under(root) == [], "一个文件都没有"
    assert workspace.tree() == {"root": str(root), "workflows": []}
    assert workspace.first_workflow() is None


def test_add_uses_basename_when_name_is_omitted(tmp_path: Path, cfg_dir: Path) -> None:
    store = workspace.Workspaces()
    root = tmp_path / "my-game-bot"

    store.add(str(root))

    assert store.items() == [{"name": "my-game-bot", "root": str(root), "active": True, "exists": True}]
    assert store.name_of(str(root)) == "my-game-bot"


def test_add_existing_dir_touches_nothing(tmp_path: Path, cfg_dir: Path) -> None:
    root = tmp_path / "现成的"
    _workflow(root, "斗技")

    workspace.Workspaces().add(str(root), name="现成的库")

    assert [item.name for item in root.iterdir()] == ["斗技"], "已有内容一个都不动"
    assert (root / "斗技" / library.GRAPH_FILE).is_file()


def test_add_is_idempotent_and_updates_the_display_name(tmp_path: Path, cfg_dir: Path) -> None:
    """同目录再 add：**原位不动**（不挪到最前）+ 设为当前；**给名字就改名，不给就保留**。"""
    first = tmp_path / "一"
    second = tmp_path / "二"
    store = workspace.Workspaces()
    store.add(str(first), name="第一个")
    store.add(str(second), name="第二个")
    assert [item["name"] for item in store.items()] == ["第一个", "第二个"], "新加的追加在末尾"

    store.add(str(first), name="改过名字的")
    assert [item["name"] for item in store.items()] == ["改过名字的", "第二个"], "切换不改顺序，只改名"
    assert store.items()[0]["active"] is True, "切过去的那个才是当前"

    store.add(str(first))
    assert store.name_of(str(first)) == "改过名字的", "不传名字 = 只切不改名"
    assert len(store.items()) == 2, "幂等：没有重复条目"
    assert list(first.iterdir()) == [], "接入/切换不往目录里写东西"


def test_display_name_can_differ_from_the_directory_name(tmp_path: Path, cfg_dir: Path) -> None:
    root = tmp_path / "dir-name"
    store = workspace.Workspaces()
    store.add(str(root), name="界面上显示的名字")

    assert store.items()[0]["name"] == "界面上显示的名字"
    assert store.items()[0]["root"] == str(root), "目录名不改"
    assert root.name == "dir-name"


def test_add_with_create_false_requires_an_existing_dir(tmp_path: Path, cfg_dir: Path) -> None:
    store = workspace.Workspaces()
    missing = tmp_path / "不存在"

    with pytest.raises(ValueError, match="工作区目录不存在"):
        store.add(str(missing), create=False)
    assert not missing.exists()

    assert store.add(str(missing), create=True) == str(missing)
    assert list(missing.iterdir()) == [], "建出来就是空的"


def test_items_shape_name_active_exists(tmp_path: Path, cfg_dir: Path) -> None:
    store = workspace.Workspaces()
    root = tmp_path / "my-game-bot"
    store.add(str(root), name="我的工作区")
    gone = tmp_path / "被删掉的"
    store.add(str(gone), name="被删掉的")
    shutil.rmtree(gone)

    items = store.items()

    assert set(items[0]) == {"name", "root", "active", "exists"}
    # 顺序 = 登记顺序（后加的在后面），当前那个是刚 add 的「被删掉的」
    assert items[0] == {"name": "我的工作区", "root": str(root), "active": False, "exists": True}
    assert items[1] == {"name": "被删掉的", "root": str(gone), "active": True, "exists": False}


def test_list_is_persisted_in_config_json(tmp_path: Path, cfg_dir: Path) -> None:
    """列表、当前工作区、**显示名**都真的写进 config.json（重启还记得）。"""
    first = tmp_path / "一"
    second = tmp_path / "二"
    store = workspace.Workspaces()
    store.add(str(first), name="第一个")
    store.add(str(second), name="第二个")

    with open(config.config_path(), encoding="utf-8") as handle:
        saved = json.load(handle)
    assert saved == {
        "active": str(second),
        "workspaces": [str(first), str(second)],
        "names": {str(first): "第一个", str(second): "第二个"},
    }
    # 换一个 store 实例（相当于重启进程）：读到的还是同一份
    restarted = workspace.Workspaces()
    assert [item["root"] for item in restarted.items()] == [str(first), str(second)]
    assert [item["name"] for item in restarted.items()] == ["第一个", "第二个"]
    assert restarted.active == str(second)


def test_remove_moves_the_workspace_to_the_global_trash(tmp_path: Path, cfg_dir: Path) -> None:
    """删整个工作区 → 全局回收站（可恢复，不是真删除）。"""
    root = tmp_path / "我的游戏"
    _workflow(root, "斗技")
    store = workspace.Workspaces()
    store.add(str(root), name="我的工作区")

    removal = store.remove(str(root))

    assert removal.was_active is True
    assert removal.trashed is not None
    trashed = Path(removal.trashed)
    assert trashed.parent == cfg_dir / ".trash"
    assert re.fullmatch(r"我的游戏-\d{8}-\d{6}", trashed.name), trashed.name
    assert (trashed / "斗技" / library.GRAPH_FILE).is_file(), "内容原样保留，能捞回来"
    assert not root.exists()
    assert store.items() == []
    assert store.active is None
    assert workspace.tree() == {"root": "", "workflows": []}


def test_remove_without_deleting_files_keeps_everything(tmp_path: Path, cfg_dir: Path) -> None:
    root = tmp_path / "我的游戏"
    _workflow(root, "斗技")
    store = workspace.Workspaces()
    store.add(str(root))

    removal = store.remove(str(root), delete_files=False)

    assert removal.trashed is None
    assert removal.was_active is True
    assert (root / "斗技" / library.GRAPH_FILE).is_file(), "磁盘一个字节不动"
    assert store.items() == []


def test_remove_unknown_workspace_reports_chinese(tmp_path: Path, cfg_dir: Path) -> None:
    store = workspace.Workspaces()
    store.add(str(tmp_path / "一"))

    with pytest.raises(ValueError, match="没有这个工作区"):
        store.remove(str(tmp_path / "没登记过的"))


def test_remove_switches_to_the_next_existing_workspace(tmp_path: Path, cfg_dir: Path) -> None:
    """移掉当前工作区 → 列表里下一个还存在的顶上；一个都不存在就没有当前工作区。"""
    first = _register(tmp_path / "一")
    second = _register(tmp_path / "二")
    store = workspace.Workspaces()
    store.add(str(second))  # 当前 = 二

    store.remove(str(second))

    assert store.active is None, "config 里当前工作区没了"
    assert store.next_existing() == str(first), "RPC 层拿它切过去"
    assert workspace.Workspaces().active is None


def test_activate_keeps_the_display_name(tmp_path: Path, cfg_dir: Path) -> None:
    store = workspace.Workspaces()
    root = tmp_path / "一"
    store.add(str(root), name="我的工作区")
    store.add(str(tmp_path / "二"))
    store.activate(str(root))

    assert store.active == str(root)
    assert store.name_of(str(root)) == "我的工作区", "切回来不该把名字洗掉"


# --------------------------------------------------------------------------- #
# 工作流层：建 / 改名 / 复制 / 删
# --------------------------------------------------------------------------- #


def test_create_workflow_makes_graph_and_templates(ws: Path) -> None:
    root = Path(library.create_workflow(str(ws), "斗技"))

    assert root == ws / "斗技"
    assert (root / library.GRAPH_FILE).is_file()
    assert (root / "templates").is_dir()
    assert library.list_workflows(str(ws))[0]["name"] == "斗技"


def test_create_workflow_rejects_bad_names_duplicates_and_missing_workspace(ws: Path) -> None:
    library.create_workflow(str(ws), "斗技")

    with pytest.raises(ValueError, match="已经有叫「斗技」的工作流了"):
        library.create_workflow(str(ws), "斗技")
    with pytest.raises(ValueError, match="工作流名不能包含这些字符"):
        library.create_workflow(str(ws), "坏/名字")
    with pytest.raises(ValueError, match=r"工作流名不能以 \. 开头或结尾"):
        library.create_workflow(str(ws), ".hidden")
    with pytest.raises(ValueError, match="工作流名不能为空"):
        library.create_workflow(str(ws), "")
    with pytest.raises(ValueError, match="工作区目录不存在"):
        library.create_workflow(str(ws / "没有"), "斗技")


def test_duplicate_workflow_copies_graph_and_templates(ws: Path) -> None:
    source = _workflow(ws, "斗技")
    (source / "templates" / "logo.png").write_bytes(b"png-bytes")

    copy = Path(library.duplicate_workflow(str(source), str(ws), "斗技-副本"))

    assert copy == ws / "斗技-副本"
    assert (copy / library.GRAPH_FILE).read_text(encoding="utf-8") == (source / library.GRAPH_FILE).read_text(
        encoding="utf-8"
    )
    assert sorted(item.name for item in (copy / "templates").iterdir()) == ["logo.png"]
    (copy / library.GRAPH_FILE).write_text("{}", encoding="utf-8")
    assert Graph.load(str(source / library.GRAPH_FILE)).nodes == {}


def test_rename_workflow_moves_the_directory(ws: Path) -> None:
    source = _workflow(ws, "斗技")

    renamed = library.rename_workflow(str(source), "御魂")

    assert renamed == str(ws / "御魂")
    assert not source.exists()
    assert (ws / "御魂" / library.GRAPH_FILE).is_file()
    assert library.rename_workflow(str(ws / "御魂"), "御魂") == str(ws / "御魂"), "原样同名是幂等的"


def test_rename_workflow_rejects_existing_target_and_missing_source(ws: Path) -> None:
    _workflow(ws, "斗技")
    _workflow(ws, "御魂")

    with pytest.raises(ValueError, match="已经有叫「御魂」的工作流了"):
        library.rename_workflow(str(ws / "斗技"), "御魂")
    with pytest.raises(ValueError, match="工作流目录不存在"):
        library.rename_workflow(str(ws / "没有"), "随便")


def test_delete_workflow_uses_the_workspace_trash(ws: Path) -> None:
    root = _workflow(ws, "斗技")

    trashed = Path(workspace.delete_workflow(str(root)))

    assert not root.exists()
    assert trashed.parent == ws / ".trash"
    assert re.fullmatch(r"斗技-\d{8}-\d{6}", trashed.name), trashed.name
    assert (trashed / library.GRAPH_FILE).is_file(), "内容原样保留，用户能捞回来"
    assert library.list_workflows(str(ws)) == []


def test_delete_workflow_refuses_non_workflow_dirs(ws: Path) -> None:
    """传工作区根本身 / 没有 graph.json 的目录 / 不存在的路径都要中文报错，不动磁盘。"""
    (ws / "空目录").mkdir()
    _workflow(ws, "斗技")

    for target in (str(ws), str(ws / "空目录"), str(ws / "没有这个工作流")):
        with pytest.raises(ValueError, match="工作流目录不存在"):
            workspace.delete_workflow(target)
    assert (ws / "斗技").is_dir()


def test_trash_into_puts_the_dir_in_the_given_trash(tmp_path: Path) -> None:
    """`trash_into` 由调用方决定回收站在哪；同一秒删两个同名目录不互相覆盖。"""
    base = tmp_path / "工作区"
    first = _workflow(base, "斗技")
    second = _workflow(base, "斗技2")
    trash = tmp_path / "别处" / library.TRASH_DIR

    one = library.trash_into(str(first), str(trash), "工作流目录")
    two = library.trash_into(str(second), str(trash), "工作流目录")

    assert Path(one).parent == trash and Path(two).parent == trash
    assert Path(one).is_dir() and Path(two).is_dir() and one != two
    with pytest.raises(ValueError, match="不存在"):
        library.trash_into(str(tmp_path / "没有"), str(trash), "工作流目录")
