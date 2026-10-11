"""`workspace.*` / `workflow.*` / `project.get|set` RPC：工作区（= 项目）› 工作流。

契约见 docs/WORKSPACE-CONTRACT.md **v4**（唯一事实来源）：

- `workspace.*` 只管工作区列表与当前工作区（用户自己选的文件夹，最近使用列表 + 显示名
  持久化在 `config.json`）；`workflow.*` 只管工作流（= 一张状态图，工作区根下的直接子目录）；
- **中间那层「项目」没有了**：项目层那四个 RPC（list / create / rename / delete）全部下线；
- 保留 `project.get` / `project.set`：它们是"当前工作流"的读取/切换，`{dir}` 语义不变；
- **没有当前工作区 / 没有当前工作流**都是一等状态：报中文错误或回空，不猜、不偷偷建目录；
- 删除：工作区里的工作流进**该工作区**的 `.trash/`；整个工作区进**全局回收站**
  `<配置目录>/.trash/`（可恢复，不做真删除）。

返回形状（契约 §2.1 / §2.2）：

- 工作区层：`workspace.list → {active, recommended, items, trashRoot}`、
  `workspace.add → {root, name, tree, current, items, trashRoot}`、
  `workspace.remove → {active, items, tree, current, trashed, trashRoot}`；
  `items` 三项统一是 `[{name, root, active, exists}]`（`name` = 显示名，最近使用排序）；
- `workspace.tree → {root, workflows: [{name, root, nodes, edges, recognizers, templates, modified}]}`；
- 工作流层：`workflow.create/duplicate → {created, current, items}`、
  `workflow.rename → {root, current, items}`、`workflow.delete → {trashed, current, items}`。
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any

from .. import library, workspace
from ..protocol import (
    METHOD_PROJECT_GET,
    METHOD_PROJECT_SET,
    METHOD_WORKFLOW_CREATE,
    METHOD_WORKFLOW_DELETE,
    METHOD_WORKFLOW_DUPLICATE,
    METHOD_WORKFLOW_RENAME,
    METHOD_WORKSPACE_ADD,
    METHOD_WORKSPACE_LIST,
    METHOD_WORKSPACE_REMOVE,
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


def _require_name(params: dict[str, Any], key: str = "name") -> str:
    """必填的名字参数：缺了/只有空白都报「缺少参数 name」（工作流必须输名字）。"""
    value = params.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"缺少参数 {key}")
    return value.strip()


def _optional_name(params: dict[str, Any]) -> str | None:
    """可选的名字参数：省略 / 空白 → None（交给自动命名）。"""
    value = params.get("name")
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def _optional_text(params: dict[str, Any], key: str) -> str | None:
    """可选的文本参数（比如工作区显示名）：省略 / 空白 → None。"""
    value = params.get(key)
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def _flag(params: dict[str, Any], key: str, *, default: bool) -> bool:
    """布尔参数：不是 bool 就用默认值（不把 "false" 这种字符串当 True）。"""
    value = params.get(key, default)
    return value if isinstance(value, bool) else default


def _abs(path: str) -> str:
    """统一路径（展开 `~`、绝对化、解析符号链接）—— 回给前端的路径要和它自己的 key 对得上。"""
    return library.norm_path(path)


def _same_path(left: str, right: str) -> bool:
    return os.path.normcase(os.path.realpath(left)) == os.path.normcase(os.path.realpath(right))


def _is_current(manager: SessionManager, target: str) -> bool:
    """`target` 是不是当前工作流（**没有当前工作流时永远是 False**，空串不能拿来当 cwd 比）。"""
    return bool(manager.project.root) and _same_path(manager.project.root, target)


def _require_workflow(root: str) -> str:
    """确认 `root` 是一个工作流目录（含 `graph.json`），否则中文报错。"""
    path = _abs(root)
    if not os.path.isfile(os.path.join(path, library.GRAPH_FILE)):
        raise ValueError(f"工作流目录不存在: {path}")
    return path


def _require_workspace() -> str:
    """当前工作区根；没选过就报「请先选择工作区」，不猜。"""
    root = workspace.workspace_root()
    if not root:
        raise ValueError("请先选择工作区")
    return root


def _items(base: str) -> list[dict[str, Any]]:
    """当前工作区里刷新后的工作流列表（工作流层每个方法的 `items`）。"""
    return library.list_workflows(base)


def register(server: RpcServer, manager: SessionManager) -> None:
    """注册 `workspace.*` / `workflow.*` / `project.get|set`（显式接收 manager，不做隐式全局）。"""

    # ------------------------------------------------------------------ #
    # 工作区层
    # ------------------------------------------------------------------ #

    @server.method(METHOD_WORKSPACE_LIST)
    def _workspace_list(params: dict[str, Any]) -> dict[str, Any]:
        """工作区列表（最近使用排序，`name` 是显示名）+ 当前工作区 + 推荐目录 + 全局回收站。

        没选过任何工作区时 `active` 是 `null`、`items` 为空（一等状态，不自动设成当前）。
        """
        _ = params
        return {
            "active": manager.workspaces.active,
            "recommended": workspace.recommended_root(),
            "items": manager.workspaces.items(),
            "trashRoot": workspace.global_trash_root(),
        }

    @server.method(METHOD_WORKSPACE_ADD)
    def _workspace_add(params: dict[str, Any]) -> dict[str, Any]:
        """添加 / 切换工作区：登记 + 设为当前 + 切过去（同一目录再加一次是幂等的）。

        - `dir` 只接受绝对路径或 `~` 开头；
        - `name` 是**列表显示名**（省略/空白 → 保留列表里已有的名字，新工作区退化成目录名）；
        - `create`（默认 `true`）：目录不存在就建；
        - **不往这个目录里写任何东西**（空文件夹保持空着，"＋工作流"是用户的事）；
        - 成功后当前工作流 = 新工作区里第一个工作流；没有就是空（一等状态）。
        """
        root = manager.workspaces.add(
            _require_str(params, "dir"),
            name=_optional_text(params, "name"),
            create=_flag(params, "create", default=True),
        )
        manager.switch_workspace(root)
        return {
            "root": root,
            "name": manager.workspaces.name_of(root),
            "tree": workspace.tree(),
            "current": manager.project.root,
            "items": manager.workspaces.items(),
            "trashRoot": workspace.global_trash_root(),
        }

    @server.method(METHOD_WORKSPACE_REMOVE)
    def _workspace_remove(params: dict[str, Any]) -> dict[str, Any]:
        """把一个工作区移出列表；`deleteFiles`（默认 `true`）时整个目录移到**全局回收站**。

        移掉的是当前工作区 → 自动切到列表里下一个还存在的；列表空了 `active` 为 `null`。
        `deleteFiles: false` 只移出列表，磁盘一个字节不动。返回里的 `trashed` 是这次实际
        落进回收站的路径（没删文件时是空串），前端拿它告诉用户"文件去哪了"。
        """
        removal = manager.workspaces.remove(
            _require_str(params, "dir"), delete_files=_flag(params, "deleteFiles", default=True)
        )
        if removal.was_active:
            # 列表里下一个还存在的顶上；一个都不存在就保持"没有当前工作区"
            following = manager.workspaces.next_existing()
            if following:
                manager.workspaces.activate(following)
            manager.switch_workspace(following)
        return {
            "active": manager.workspaces.active,
            "items": manager.workspaces.items(),
            "tree": workspace.tree(),
            "current": manager.project.root,
            "trashed": removal.trashed or "",
            "trashRoot": workspace.global_trash_root(),
        }

    @server.method(METHOD_WORKSPACE_TREE)
    def _workspace_tree(params: dict[str, Any]) -> dict[str, Any]:
        """当前工作区的整棵树：`{root, workflows: [{...摘要, modified}]}`。"""
        _ = params
        return workspace.tree()

    # ------------------------------------------------------------------ #
    # 当前工作流：读取 / 切换（RPC 名字按契约保留 project.*）
    # ------------------------------------------------------------------ #

    @server.method(METHOD_PROJECT_GET)
    def _project_get(params: dict[str, Any]) -> dict[str, Any]:
        """当前工作流概览；没有选择工作流时是全空（`root`/`graphPath` 为空串 + 全 0）。"""
        _ = params
        return manager.project_info()

    @server.method(METHOD_PROJECT_SET)
    def _project_set(params: dict[str, Any]) -> dict[str, Any]:
        """切换当前工作流目录（不存在就创建），并热重载所有已连接设备的状态图。"""
        manager.use_project(_require_str(params, "dir"))
        return manager.project_info()

    # ------------------------------------------------------------------ #
    # 工作流层
    # ------------------------------------------------------------------ #

    @server.method(METHOD_WORKFLOW_CREATE)
    def _workflow_create(params: dict[str, Any]) -> dict[str, Any]:
        """在当前工作区根下新建工作流（**名字必填**，界面会弹输入框让你起名），并**切过去**。

        为什么不做"点一下自动命名"：用户要的是"点 ＋ → 输名字 → 建"（自己起的名字一眼认得出）。
        自动命名只留给"复制"那种确实想不出名字的场景。
        没有当前工作区 → 报「请先选择工作区」。
        """
        base = _require_workspace()
        root = library.create_workflow(base, _require_name(params))
        manager.use_project(root)
        return {"created": root, "current": manager.project.root, "items": _items(base)}

    @server.method(METHOD_WORKFLOW_RENAME)
    def _workflow_rename(params: dict[str, Any]) -> dict[str, Any]:
        """工作流改名（同工作区内）；它正是当前工作流时，当前工作流跟着改到新目录。"""
        source = _require_workflow(_require_str(params, "dir"))
        base = os.path.dirname(source)
        root = library.rename_workflow(source, _require_name(params))
        if _is_current(manager, source):
            manager.use_project(root)
        return {"root": root, "current": manager.project.root, "items": _items(base)}

    @server.method(METHOD_WORKFLOW_DUPLICATE)
    def _workflow_duplicate(params: dict[str, Any]) -> dict[str, Any]:
        """复制一个工作流（状态图 + 整个 `templates/`）并**切到副本**。

        `name` 省略时自动命名「<原名>-副本」「<原名>-副本2」……
        """
        source = _require_workflow(_require_str(params, "dir"))
        base = os.path.dirname(source)
        stem = f"{os.path.basename(source)}-副本"
        name = _optional_name(params) or workspace.auto_name(workspace.subdir_names(base), stem, plain_first=True)
        root = library.duplicate_workflow(source, base, name)
        manager.use_project(root)
        return {"created": root, "current": manager.project.root, "items": _items(base)}

    @server.method(METHOD_WORKFLOW_DELETE)
    def _workflow_delete(params: dict[str, Any]) -> dict[str, Any]:
        """把工作流移进**它所属工作区**的 `.trash/`（可恢复）。

        删的是当前工作流时：切到剩下的第一个；一个都不剩 → 保持"没有当前工作流"。
        """
        source = _require_workflow(_require_str(params, "dir"))
        base = os.path.dirname(source)
        was_current = _is_current(manager, source)
        trashed = workspace.delete_workflow(source)
        items = _items(base)
        if was_current:
            if items:
                manager.use_project(str(items[0]["root"]))
            else:
                manager.reselect_workflow()
        return {"trashed": trashed, "current": manager.project.root, "items": items}


__all__ = ["register"]
