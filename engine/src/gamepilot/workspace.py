"""工作区层：工作区（= 项目，用户选的文件夹，可以有多个）› 工作流。

契约 docs/WORKSPACE-CONTRACT.md v4 §1：

    <用户选的文件夹>/                 ← 工作区根（任意绝对路径，支持 `~`）
    ├── 斗技/                         ← 工作流 = 一张状态图（graph.json + templates/）
    └── 御魂/

- 工作区可以有多个：当前工作区 + 最近使用列表 + 显示名持久化在 `config.json`（见 `config` 模块）；
- **接入一个空文件夹时什么都不建**（完全空着，等用户「＋工作流」）；
- "没有当前工作区 / 没有当前工作流"是一等状态 —— 工作区根用空串表示，绝不伪造磁盘上不存在的路径，
  也绝不偷偷建目录；
- 删除一律是**真删除**（工作流；以及 `delete_files: true` 的整个工作区），删了就没了 ——
  不可恢复，所以界面必须二次确认。

本模块是**纯文件系统 + 列表状态逻辑**，不认识 RPC、不碰 stdout。
"""

from __future__ import annotations

import os
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from . import config, library

WORKSPACE_NAME = "默认"
WORKSPACE_ROOT = "workspaces"
WORKSPACE_DIR_ENV = config.WORKSPACE_DIR_ENV


def repo_root() -> str:
    """engine/src/gamepilot/workspace.py → 仓库根（向上三层）。"""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", ".."))


def recommended_root() -> str:
    """面板底部「默认工作区」用的推荐目录。

    开发态走 `<仓库根>/workspaces/默认`；
    PyInstaller 冻结态（安装包）下 `__file__` 在临时解压目录 `_MEIxxxxxx` 里，
    向上三层会落到 `AppData\\Local\\workspaces\\默认`，因此冻结态改用用户配置目录下的 `workspaces/默认`。
    """
    import sys

    if getattr(sys, "frozen", False):
        return os.path.join(config.default_config_dir(), WORKSPACE_ROOT, WORKSPACE_NAME)
    return os.path.join(repo_root(), WORKSPACE_ROOT, WORKSPACE_NAME)


def _abs(path: str) -> str:
    """统一路径：展开 `~`、绝对化、解析符号链接（见 `library.norm_path`）。"""
    return library.norm_path(path)


def _same_path(left: str, right: str) -> bool:
    return os.path.normcase(os.path.realpath(left)) == os.path.normcase(os.path.realpath(right))


def active_root() -> str:
    """当前工作区根；没选过（或列表空了）时是**空串** —— 一等状态，不是错误。"""
    return config.load().active or ""


def workspace_root(base: str | None = None) -> str:
    """工作区根：显式 `base` 优先，否则当前工作区（可能是空串）。"""
    return _abs(base) if base else active_root()


def subdir_names(path: str) -> list[str]:
    """目录下已占用的子目录名（按名字排序，跳过隐藏目录 —— 老版本留下的 `.trash` 也在这类里）。"""
    if not os.path.isdir(path):
        return []
    with os.scandir(path) as entries:
        return sorted(entry.name for entry in entries if entry.is_dir() and not entry.name.startswith("."))


def auto_name(names: Iterable[str], stem: str, *, start: int = 1, plain_first: bool = False) -> str:
    """取第一个没被占用的自动名字（`names` = 已占用的名字）。

    - 默认：`<stem><N>`，N 从 `start` 起 → 「工作流1」「工作流2」……
    - `plain_first=True`：先试 `<stem>` 本身，再 `<stem>2`、`<stem>3`……
      → 复制工作流时用：「斗技-副本」「斗技-副本2」……
    """
    taken = set(names)
    if plain_first and stem not in taken:
        return stem
    index = 2 if plain_first else start
    while f"{stem}{index}" in taken:
        index += 1
    return f"{stem}{index}"


def list_workflows(base: str | None = None) -> list[dict[str, Any]]:
    """当前工作区里的工作流（按 name 排序），每项见 `library.list_workflows`。

    没有当前工作区时返回空列表。
    """
    root = workspace_root(base)
    return library.list_workflows(root) if root else []


def tree(base: str | None = None) -> dict[str, Any]:
    """整棵树：`{root, workflows: [{name, root, nodes, edges, recognizers, templates, modified}]}`。

    没有当前工作区时 `root` 是**空串**、`workflows` 为空 —— 前端据此显示空状态，不报错。
    """
    root = workspace_root(base)
    return {"root": root, "workflows": library.list_workflows(root) if root else []}


def first_workflow(base: str | None = None) -> str | None:
    """树里第一个工作流（按名字排序）；一个都没有时返回 None。"""
    items = list_workflows(base)
    return str(items[0]["root"]) if items else None


def normalize_dir(directory: str) -> str:
    """工作区路径规范化：只接受**绝对路径或 `~` 开头**（相对路径歧义，直接中文报错）。

    返回解析过符号链接的绝对路径（和前端 `Path.resolve()` 一致）。
    """
    raw = (directory or "").strip()
    if not raw:
        raise ValueError("缺少工作区路径")
    if not raw.startswith("~") and not os.path.isabs(raw):
        raise ValueError(f"工作区路径必须是绝对路径（或以 ~ 开头）: {directory}")
    return _abs(raw)


def delete_workflow(root: str) -> str:
    """**真删除**一个工作流目录，返回被删掉的路径（不可恢复）。

    层级护栏：必须真的含 `graph.json`，传工作区根本身（或别的目录）过来会报
    「工作流目录不存在」—— 免得手滑把整个工作区删掉。
    """
    source = _abs(root)
    if not os.path.isfile(os.path.join(source, library.GRAPH_FILE)):
        raise ValueError(f"工作流目录不存在: {source}")
    return library.remove_dir(source, "工作流目录")


@dataclass(frozen=True)
class Removal:
    """移除一个工作区之后的状态（给 RPC 层切当前工作流用）。"""

    root: str
    removed: str | None
    was_active: bool


class Workspaces:
    """工作区列表 + 当前工作区（持久化在 `config.json`；逃生口模式下只在进程内）。

    `items()` 返回形状统一为 `{name, root, active, exists}`（契约 §2.1）：
    `name` 是**列表显示名**（`workspace.add { name }` 输的那个，省略时退化成目录名）、
    `exists` 是目录现在还在不在（用户在 Finder 里删了就是 False）。
    """

    @property
    def active(self) -> str | None:
        """当前工作区路径；没选过就是 None。"""
        return config.load().active

    def items(self) -> list[dict[str, Any]]:
        """工作区列表（最近使用排序），每项 `{name, root, active, exists}`。"""
        cfg = config.load()
        return [_entry(root, cfg) for root in cfg.workspaces]

    def name_of(self, root: str) -> str:
        """某个工作区在列表里的显示名（没有就退化成目录名）。"""
        return config.display_name(config.load(), root)

    def add(self, directory: str, *, name: str | None = None, create: bool = True) -> str:
        """登记一个工作区并设为当前，返回规范化后的绝对路径。

        - `directory` 必须是绝对路径或 `~` 开头；
        - `name` 是**列表显示名**（不要求等于目录名）：省略/空白时保留列表里已有的名字，
          新工作区则退化成目录名；传了就用这次传的（用户可能就是来改名的）；
        - `create`（默认 True）时目录不存在就建；False 时目录不存在报错；
        - **不往这个目录里写任何东西**（空文件夹保持空着）；
        - 同一个目录再加一次 = 幂等：设为当前，**列表里的位置不变**（新目录才追加到末尾）。
        """
        root = normalize_dir(directory)
        if os.path.exists(root) and not os.path.isdir(root):
            raise ValueError(f"这个路径不是目录: {root}")
        if create:
            os.makedirs(root, exist_ok=True)
        elif not os.path.isdir(root):
            raise ValueError(f"工作区目录不存在: {root}")
        # 名字为 None 时 `with_workspace` 会保留列表里已有的显示名（只切不改名）
        config.save(config.with_workspace(config.load(), root, (name or "").strip() or None))
        return root

    def remove(self, directory: str, *, delete_files: bool = True) -> Removal:
        """把一个工作区从列表里移除。

        - `delete_files`（默认 True）→ 整个目录**真删除**（`shutil.rmtree`，不可恢复）；
        - `delete_files=False` → 只从列表移除，磁盘一个字节不动；
        - 不在列表里 → 报错「没有这个工作区: <路径>」，不猜。
        """
        root = normalize_dir(directory)
        current = config.load()
        match = next((item for item in current.workspaces if _same_path(item, root)), None)
        if match is None:
            raise ValueError(f"没有这个工作区: {root}")
        was_active = current.active is not None and _same_path(current.active, match)
        removed: str | None = None
        if delete_files and os.path.isdir(match):
            removed = library.remove_dir(match, "工作区目录")
        config.save(config.without_workspace(current, match))
        return Removal(root=match, removed=removed, was_active=was_active)

    def next_existing(self) -> str | None:
        """列表里下一个还存在的工作区（移除当前工作区之后切过去用）；没有就 None。"""
        for item in config.load().workspaces:
            if os.path.isdir(item):
                return item
        return None

    def activate(self, root: str) -> str:
        """把一个**已经登记**的工作区设为当前（只改配置，不建目录、不建工作流，名字保持不变）。"""
        path = _abs(root)
        config.save(config.with_workspace(config.load(), path))
        return path


def _entry(root: str, cfg: config.Config) -> dict[str, Any]:
    return {
        "name": config.display_name(cfg, root),
        "root": root,
        "active": cfg.active is not None and _same_path(root, cfg.active),
        "exists": os.path.isdir(root),
    }


__all__ = [
    "WORKSPACE_DIR_ENV",
    "WORKSPACE_NAME",
    "WORKSPACE_ROOT",
    "Removal",
    "Workspaces",
    "active_root",
    "auto_name",
    "delete_workflow",
    "first_workflow",
    "list_workflows",
    "normalize_dir",
    "recommended_root",
    "repo_root",
    "subdir_names",
    "tree",
    "workspace_root",
]
