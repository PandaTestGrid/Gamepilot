"""当前工作流（一张状态图）的位置。

层级见 docs/WORKSPACE-CONTRACT.md v4：**工作区（= 用户选的一个文件夹）› 工作流**，
一个工作流 = 一个目录：

    <工作区根>/<工作流名>/
    ├── graph.json      状态图（唯一的真源）
    └── templates/      识别器模板 PNG

`Project` 是**当前工作流**的持有者：RPC 那对 `project.get` / `project.set` 的名字按契约保留
（它们指的是"当前工作流的读取/切换"），跟 v1–v3 的「项目」层级没有关系 —— 那一层已经取消。

**"没有当前工作流"是一等状态**：`Project.root` 为空串时 `graph_path` / `templates_dir`
也是空串，绝不伪造磁盘上不存在的路径（契约 §2.4）。启动时由 `SessionManager` 决定：
`GAMEPILOT_PROJECT_DIR` 优先，否则取当前工作区里第一个工作流。
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from . import library, workspace
from .library import GRAPH_FILE


@dataclass(frozen=True)
class Project:
    """当前工作流目录；`root == ""` 表示**没有选择工作流**（一等状态）。"""

    root: str = ""

    @property
    def selected(self) -> bool:
        return bool(self.root)

    @property
    def graph_path(self) -> str:
        return os.path.join(self.root, GRAPH_FILE) if self.root else ""

    @property
    def templates_dir(self) -> str:
        return os.path.join(self.root, "templates") if self.root else ""

    def ensure(self) -> Project:
        """目录不存在就建出来（只对**显式选定**的工作流目录做；空状态什么都不建）。"""
        if self.root:
            os.makedirs(self.templates_dir, exist_ok=True)
        return self


def repo_root() -> str:
    """engine/src/gamepilot/project.py → 仓库根（向上 3 层），与 `workspace.repo_root` 一致。"""
    return workspace.repo_root()


def resolve_project() -> Project:
    """启动时的当前工作流：`GAMEPILOT_PROJECT_DIR`（逃生口）优先，否则什么都没选。"""
    override = os.environ.get("GAMEPILOT_PROJECT_DIR")
    if not override:
        return Project()
    return Project(root=library.norm_path(override)).ensure()


__all__ = ["Project", "repo_root", "resolve_project"]
