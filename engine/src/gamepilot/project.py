"""工程目录：状态图与模板素材的落盘位置。

一个工程 = 一个目录：

    projects/default/
    ├── graph.json      状态图（唯一的真源）
    └── templates/      识别器模板 PNG

路径优先级：`GAMEPILOT_PROJECT_DIR` 环境变量 → 仓库内 `projects/default`。
"""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_PROJECT_NAME = "default"


@dataclass(frozen=True)
class Project:
    root: str

    @property
    def graph_path(self) -> str:
        return os.path.join(self.root, "graph.json")

    @property
    def templates_dir(self) -> str:
        return os.path.join(self.root, "templates")

    def ensure(self) -> Project:
        os.makedirs(self.templates_dir, exist_ok=True)
        return self


def repo_root() -> str:
    """engine/src/gamepilot/project.py → 仓库根（向上 3 层）。"""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", ".."))


def resolve_project(name: str = DEFAULT_PROJECT_NAME) -> Project:
    root = os.environ.get("GAMEPILOT_PROJECT_DIR") or os.path.join(repo_root(), "projects", name)
    return Project(root=os.path.abspath(root)).ensure()
