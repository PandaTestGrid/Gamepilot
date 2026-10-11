"""`project.*` RPC：脚本目录 / 脚本库（多状态图）。

契约见 docs/rpc.md「脚本目录」与「脚本库（多状态图）」：

- `project.get` / `project.set` / `project.list` 是单脚本接口；
- `project.create` / `project.duplicate` / `project.rename` / `project.delete`
  是库操作（一个目录 = 一个状态图，多状态图 = 多个目录），**成功后统一返回
  `{"items": [...], "current": "<当前脚本 root>"}`**：刷新后的整份列表 + 当前脚本，
  前端一次调用即可重绘；
- 库根默认是当前脚本目录的父目录，可用 `base` 指定；`base` 不存在时报错。

副作用（都在 `library` 里落地）：新建/复制/改名磁盘目录；"删除"是移到
`<base>/.trash/<名字>-<时间戳>/`，不做真删除。create/duplicate 之后当前脚本会切到
新目录；rename/delete 若动的是当前脚本也会跟着切（delete 切到列表剩下的第一个，
一个都不剩则回到 `default`），切换会热重载所有已连接设备的状态图。
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any

from .. import library, workspaces
from ..project import resolve_project
from ..protocol import (
    METHOD_PROJECT_CREATE,
    METHOD_PROJECT_DELETE,
    METHOD_PROJECT_DUPLICATE,
    METHOD_PROJECT_GET,
    METHOD_PROJECT_LIST,
    METHOD_PROJECT_RENAME,
    METHOD_PROJECT_SET,
    METHOD_WORKSPACE_CREATE,
    METHOD_WORKSPACE_LIST,
    METHOD_WORKSPACE_TREE,
)

if TYPE_CHECKING:  # 避免循环导入
    from .session import SessionManager
    from .stdio import RpcServer


def _require_str(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"缺少参数 {key}")
    return value


def _abs(path: str) -> str:
    return os.path.abspath(os.path.expanduser(path))


def _same_path(left: str, right: str) -> bool:
    """两个路径是不是同一个东西（用于判断"动的是不是当前脚本"）。"""
    return os.path.normcase(os.path.realpath(left)) == os.path.normcase(os.path.realpath(right))


def _library_base(params: dict[str, Any], manager: SessionManager) -> str:
    """库根：显式 `base` 优先，否则用当前脚本目录的父目录。"""
    base = params.get("base")
    if isinstance(base, str) and base:
        return _abs(base)
    return library.library_root(manager.project.root)


def _library_result(manager: SessionManager, base: str) -> dict[str, Any]:
    """库操作的统一返回：刷新后的整份列表 + 当前脚本 root。"""
    return {"items": library.list_scripts(base), "current": manager.project.root}


def register(server: RpcServer, manager: SessionManager) -> None:
    """注册 `project.*`（显式接收 manager，不做隐式全局）。"""

    @server.method(METHOD_PROJECT_GET)
    def _project_get(params: dict[str, Any]) -> dict[str, Any]:
        _ = params
        return manager.project_info()

    @server.method(METHOD_PROJECT_SET)
    def _project_set(params: dict[str, Any]) -> dict[str, Any]:
        """切换脚本目录（不存在就创建），并热重载所有已连接设备的状态图。"""
        manager.use_project(_require_str(params, "dir"))
        return manager.project_info()

    @server.method(METHOD_PROJECT_LIST)
    def _project_list(params: dict[str, Any]) -> dict[str, Any]:
        base = params.get("base")
        return {"items": manager.list_projects(str(base) if base else None)}

    @server.method(METHOD_WORKSPACE_TREE)
    def _workspace_tree(params: dict[str, Any]) -> dict[str, Any]:
        """项目 > 工作区 > 任务 三层树（任务 = 一张状态图）。"""
        return {"projects": workspaces.tree()}

    @server.method(METHOD_WORKSPACE_LIST)
    def _workspace_list(params: dict[str, Any]) -> dict[str, Any]:
        """列出工作区（每个工作区是一个"库根"，里面放任务）。"""
        return {"items": [item.to_dict() for item in workspaces.list_workspaces()]}

    @server.method(METHOD_WORKSPACE_CREATE)
    def _workspace_create(params: dict[str, Any]) -> dict[str, Any]:
        """新建工作区目录并登记（同名不覆盖）。"""
        made = workspaces.create_workspace(_require_str(params, "name"))
        return {"created": made.to_dict(), "items": [item.to_dict() for item in workspaces.list_workspaces()]}

    @server.method(METHOD_PROJECT_CREATE)
    def _project_create(params: dict[str, Any]) -> dict[str, Any]:
        """新建空脚本目录，并**切换过去**。"""
        base = _library_base(params, manager)
        root = library.create_script(base, _require_str(params, "name"))
        manager.use_project(root)
        return _library_result(manager, base)

    @server.method(METHOD_PROJECT_DUPLICATE)
    def _project_duplicate(params: dict[str, Any]) -> dict[str, Any]:
        """复制一个已有脚本（状态图 + 整个 templates/）到新名字，并**切换过去**。"""
        base = _library_base(params, manager)
        root = library.duplicate_script(_require_str(params, "dir"), base, _require_str(params, "name"))
        manager.use_project(root)
        return _library_result(manager, base)

    @server.method(METHOD_PROJECT_RENAME)
    def _project_rename(params: dict[str, Any]) -> dict[str, Any]:
        """重命名脚本目录；若它正是当前脚本，当前脚本跟着改（不切换别的目录）。"""
        base = _library_base(params, manager)
        source = _abs(_require_str(params, "dir"))
        root = library.rename_script(source, _require_str(params, "name"))
        if _same_path(manager.project.root, source):
            manager.use_project(root)
        return _library_result(manager, base)

    @server.method(METHOD_PROJECT_DELETE)
    def _project_delete(params: dict[str, Any]) -> dict[str, Any]:
        """把脚本移进 `.trash/`（可恢复）；删的是当前脚本就切到列表剩下的第一个。"""
        base = _library_base(params, manager)
        source = _abs(_require_str(params, "dir"))
        library.trash_script(source)
        items = library.list_scripts(base)
        if _same_path(manager.project.root, source):
            manager.use_project(items[0]["root"] if items else resolve_project().root)
        return {"items": items, "current": manager.project.root}


__all__ = ["register"]
