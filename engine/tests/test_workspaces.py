"""工作区：默认一个、可新建、同名不覆盖、名字可用于找库根。"""

import json
import os
from pathlib import Path

import pytest

from gamepilot import workspaces


def test_default_workspace_is_projects(tmp_path: Path) -> None:
    """没注册表时也要有一个「默认」工作区，指向 projects/（老脚本原地不动）。"""
    items = workspaces.list_workspaces(str(tmp_path))
    assert [item.name for item in items] == [workspaces.DEFAULT_WORKSPACE]
    assert items[0].root == str(tmp_path / workspaces.DEFAULT_ROOT)


def test_create_workspace_registers_and_makes_dir(tmp_path: Path) -> None:
    made = workspaces.create_workspace("我的工作区", str(tmp_path))
    assert os.path.isdir(made.root) and made.root.endswith("workspaces/我的工作区")
    with open(tmp_path / workspaces.REGISTRY_NAME, encoding="utf-8") as handle:
        saved = json.load(handle)
    assert saved["items"][-1]["name"] == "我的工作区"
    # 默认项还在，且能按名字找到
    assert workspaces.resolve_workspace("我的工作区", str(tmp_path)).root == made.root
    assert workspaces.resolve_workspace(None, str(tmp_path)).name == workspaces.DEFAULT_WORKSPACE


def test_create_workspace_rejects_duplicates_and_bad_names(tmp_path: Path) -> None:
    workspaces.create_workspace("甲", str(tmp_path))
    with pytest.raises(ValueError, match="已经有叫"):
        workspaces.create_workspace("甲", str(tmp_path))
    with pytest.raises(ValueError, match="不合法"):
        workspaces.create_workspace("  ", str(tmp_path))
    with pytest.raises(ValueError, match="没有这个工作区"):
        workspaces.resolve_workspace("不存在", str(tmp_path))


def test_tree_legacy_flat_layout(tmp_path: Path) -> None:
    """老布局（库根下直接是脚本）→ 项目「默认」> 工作区「默认」> 任务，不要求搬文件。"""
    from gamepilot.library import create_script

    base = tmp_path / workspaces.DEFAULT_ROOT
    base.mkdir(parents=True, exist_ok=True)
    create_script(str(base), "阴阳师")

    projects = workspaces.tree(str(tmp_path))
    assert [item["name"] for item in projects] == [workspaces.DEFAULT_WORKSPACE]
    buckets = projects[0]["workspaces"]
    assert [item["name"] for item in buckets] == [workspaces.DEFAULT_WORKSPACE]
    assert [task["name"] for task in buckets[0]["tasks"]] == ["阴阳师"]


def test_tree_three_levels(tmp_path: Path) -> None:
    """新布局：项目 > 工作区 > 任务（任务 = 一张状态图）。"""
    from gamepilot.library import create_script

    base = tmp_path / workspaces.DEFAULT_ROOT
    ws = base / "阴阳师"  # 注册表条目=项目根，它下面第一层就是工作区
    ws.mkdir(parents=True, exist_ok=True)
    create_script(str(ws), "斗技")
    create_script(str(ws), "百鬼")

    buckets = workspaces.tree(str(tmp_path))[0]["workspaces"]
    assert [item["name"] for item in buckets] == ["阴阳师"], "中间那层目录就是工作区"
    assert [task["name"] for task in buckets[0]["tasks"]] == ["斗技", "百鬼"]


def test_make_workspace_dir(tmp_path: Path) -> None:
    """在项目下建工作区目录：不写 graph.json（免得被当成任务），同名报错。"""
    project = tmp_path / "游戏自动化"
    project.mkdir()
    made = workspaces.make_workspace_dir(str(project), "阴阳师")
    assert os.path.isdir(made)
    assert not os.path.isfile(os.path.join(made, "graph.json")), "工作区本身不该是任务"
    with pytest.raises(ValueError, match="已经有叫"):
        workspaces.make_workspace_dir(str(project), "阴阳师")
    with pytest.raises(ValueError, match="项目目录不存在"):
        workspaces.make_workspace_dir(str(tmp_path / "不存在"), "x")


def test_migrate_legacy_moves_graph_into_task_dir(tmp_path: Path) -> None:
    """老布局迁移：`<ws>/{graph.json,templates}` → `<ws>/<任务>/{graph.json,templates}`，并先备份。"""
    import shutil

    from gamepilot.library import create_script

    base = tmp_path / workspaces.DEFAULT_ROOT
    base.mkdir(parents=True, exist_ok=True)
    script = create_script(str(base), "阴阳师")
    (tmp_path / "shot.png").write_bytes(b"x")
    shutil.copy(tmp_path / "shot.png", os.path.join(script, "templates", "t.png"))

    moved = workspaces.migrate_legacy(str(base))
    assert len(moved) == 1
    task_root = moved[0]["root"]
    assert task_root.endswith("阴阳师/默认任务")
    assert os.path.isfile(os.path.join(task_root, "graph.json"))
    assert os.path.isfile(os.path.join(task_root, "templates", "t.png")), "模板要跟着走"
    assert os.path.isdir(moved[0]["backup"]), "迁移前必须先备份，可回退"

    # 迁移后树里：工作区=阴阳师，任务=默认任务
    buckets = workspaces.tree(str(tmp_path))[0]["workspaces"]
    assert [item["name"] for item in buckets] == ["阴阳师"]
    assert [task["name"] for task in buckets[0]["tasks"]] == ["默认任务"]
    # 再迁一次要报错（幂等保护）
    with pytest.raises(ValueError, match="没有需要迁移"):
        workspaces.migrate_legacy(str(base))
