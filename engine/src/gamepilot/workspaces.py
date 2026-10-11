"""工作区（workspace）：一组任务的"库根"。

- **工作区 = 一个目录**，里面每个子目录是一个任务（脚本：`graph.json` + `templates/`）
- 注册表放在仓库根的 `workspaces.json`（可手改，`root` 支持任意路径）
- 默认注册一个「默认」工作区 → `projects/`，所以老脚本**一个都不用搬**

引擎里 `list_scripts/create_script/duplicate/rename/trash` 早就按"库根"工作了，
这个模块只负责"有哪些库根、新建哪个"，不碰任务内部。
"""

from __future__ import annotations

import json
import os
import shutil
import time
from dataclasses import dataclass
from typing import Any

from .library import SCRIPT_FILE

REGISTRY_NAME = "workspaces.json"
DEFAULT_WORKSPACE = "默认"
DEFAULT_ROOT = "projects"


@dataclass(frozen=True)
class Workspace:
    name: str
    root: str

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "root": self.root, "exists": os.path.isdir(self.root)}


def repo_root() -> str:
    """engine/src/gamepilot/workspaces.py → 仓库根（向上三层）。"""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", ".."))


def registry_path(root: str | None = None) -> str:
    return os.path.join(root or repo_root(), REGISTRY_NAME)


def _default_entry(base: str) -> dict[str, str]:
    return {"name": DEFAULT_WORKSPACE, "root": os.path.join(base, DEFAULT_ROOT)}


def load_registry(base: str | None = None) -> dict[str, Any]:
    """读注册表；没有就返回"只有一个默认工作区"的最小结构（不写盘）。"""
    root = base or repo_root()
    path = registry_path(root)
    if not os.path.isfile(path):
        return {"items": [_default_entry(root)]}
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    items = [item for item in data.get("items", []) if isinstance(item, dict) and item.get("name")]
    if not items:
        items = [_default_entry(root)]
    return {"items": items}


def save_registry(data: dict[str, Any], base: str | None = None) -> str:
    root = base or repo_root()
    path = registry_path(root)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    return path


def list_workspaces(base: str | None = None) -> list[Workspace]:
    root = base or repo_root()
    items = load_registry(root)["items"]
    out: list[Workspace] = []
    for item in items:
        raw = str(item.get("root") or "")
        path = raw if os.path.isabs(raw) else os.path.join(root, raw)
        # 相对路径统一存"相对仓库根"，方便手改和跨机器
        out.append(Workspace(name=str(item["name"]), root=os.path.abspath(path)))
    return out


def create_workspace(name: str, base: str | None = None) -> Workspace:
    """新建工作区目录并登记；同名已存在就报错（不覆盖）。"""
    clean = name.strip().strip("/")
    if not clean or clean in {".", ".."}:
        raise ValueError("工作区名字不合法")
    root = base or repo_root()
    items = load_registry(root)["items"]
    if any(str(item.get("name")) == clean for item in items):
        raise ValueError(f"已经有叫「{clean}」的工作区了")
    target = os.path.join(root, "workspaces", clean)
    if os.path.exists(target):
        raise ValueError(f"目录已存在: {target}")
    os.makedirs(target, exist_ok=True)
    items.append({"name": clean, "root": os.path.relpath(target, root)})
    save_registry({"items": items}, root)
    return Workspace(name=clean, root=os.path.abspath(target))


def resolve_workspace(name: str | None, base: str | None = None) -> Workspace:
    """按名字找工作区；不传名字就是第一个（默认）。"""
    items = list_workspaces(base)
    if not name:
        return items[0]
    for item in items:
        if item.name == name:
            return item
    raise ValueError(f"没有这个工作区: {name}")


def _task_summary(task_dir: str) -> dict[str, Any] | None:
    """一个任务目录（含 graph.json）的摘要；不是任务就返回 None。"""
    graph_path = os.path.join(task_dir, SCRIPT_FILE)
    if not os.path.isfile(graph_path):
        return None
    try:
        with open(graph_path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        data = {}
    nodes = data.get("nodes") or []
    edges = data.get("edges") or []
    return {
        "name": os.path.basename(task_dir),
        "root": os.path.abspath(task_dir),
        "nodes": len(nodes),
        "edges": len(edges),
        "recognizers": len(data.get("recognizers") or {}),
    }


def _subdirs(path: str) -> list[str]:
    if not os.path.isdir(path):
        return []
    return sorted(
        os.path.join(path, name)
        for name in os.listdir(path)
        if os.path.isdir(os.path.join(path, name)) and not name.startswith(".")
    )


def tree(base: str | None = None) -> list[dict[str, Any]]:
    """三层目录树：**项目 > 工作区 > 任务**（任务 = 一张状态图）。

    兼容老布局：如果某个目录**自己**就是一个任务（直接含 graph.json），
    就把它当成「默认」工作区下的任务，而不是要求你现在就搬文件。
    """
    root = base or repo_root()
    projects: list[dict[str, Any]] = []
    for entry in list_workspaces(root):
        buckets: list[dict[str, Any]] = []
        project: dict[str, Any] = {"name": entry.name, "root": entry.root, "workspaces": buckets}
        # ① 先看直接是任务的情况（老布局：库根下面就是脚本目录）
        flat: list[dict[str, Any]] = []
        # ② 正常三层：库根/工作区/任务
        for ws_dir in _subdirs(entry.root):
            tasks = [item for item in (_task_summary(sub) for sub in _subdirs(ws_dir)) if item]
            own = _task_summary(ws_dir)
            if own:  # 这个目录自己就是任务 → 老布局里的一个脚本
                flat.append(own)
            elif tasks:
                buckets.append({"name": os.path.basename(ws_dir), "root": ws_dir, "tasks": tasks})
        if flat:
            project["workspaces"].insert(0, {"name": DEFAULT_WORKSPACE, "root": entry.root, "tasks": flat})
        projects.append(project)
    return projects


def make_workspace_dir(project: str, name: str) -> str:
    """在项目目录下建一个工作区目录（`<项目>/<工作区>/`），返回路径。

    工作区只是"装任务的目录"，不写 graph.json —— 免得被当成一个老布局的任务。
    """
    clean = name.strip().strip("/")
    if not clean or clean in {".", ".."}:
        raise ValueError("工作区名字不合法")
    root = os.path.abspath(os.path.expanduser(project))
    if not os.path.isdir(root):
        raise ValueError(f"项目目录不存在: {root}")
    target = os.path.join(root, clean)
    if os.path.exists(target):
        raise ValueError(f"这个项目里已经有叫「{clean}」的工作区了")
    os.makedirs(target, exist_ok=True)
    return target


def migrate_legacy(project: str, task_name: str = "默认任务", backup_root: str | None = None) -> list[dict[str, str]]:
    """把"库根下直接是状态图"的老布局，迁成 **工作区目录 > 任务目录**。

    用户要的层级是：项目 › **工作区**（管理它下面所有状态图）› 状态图 = 任务。
    老布局里 `projects/阴阳师/` 自己就是一张状态图 —— 于是"工作区"和"状态图"看着绑在一起。
    这里把 `projects/阴阳师/{graph.json,templates/}` 挪到 `projects/阴阳师/<任务名>/` 下面，
    阴阳师 就成了一个**真正的工作区**（里面可以再放别的状态图）。

    安全第一：先把整个目录**复制**到备份处（默认 `<项目>/.trash/`），确认复制成功后才删除原文件。
    """
    root = os.path.abspath(os.path.expanduser(project))
    if not os.path.isdir(root):
        raise ValueError(f"项目目录不存在: {root}")
    backup = os.path.abspath(backup_root) if backup_root else os.path.join(root, ".trash")

    moved: list[dict[str, str]] = []
    for entry in _subdirs(root):
        if _task_summary(entry) is None:  # 不是老布局的状态图
            continue
        workspace_name = os.path.basename(entry)
        target = os.path.join(entry, task_name)
        if os.path.exists(target):
            raise ValueError(f"已经迁移过了: {target}")
        # ① 先备份（整目录复制）
        stamp = time.strftime("%Y%m%d-%H%M%S")
        saved = os.path.join(backup, f"{workspace_name}-{stamp}")
        os.makedirs(backup, exist_ok=True)
        shutil.copytree(entry, saved)
        # ② 再就地把 graph.json + templates/ 挪进任务子目录
        os.makedirs(target, exist_ok=True)
        for item in (SCRIPT_FILE, "templates"):
            source = os.path.join(entry, item)
            if os.path.exists(source):
                shutil.move(source, os.path.join(target, item))
        moved.append({"workspace": workspace_name, "task": task_name, "root": target, "backup": saved})
    if not moved:
        raise ValueError("没有需要迁移的老布局脚本（或都已经是三层结构了）")
    return moved
