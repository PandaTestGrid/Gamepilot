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
