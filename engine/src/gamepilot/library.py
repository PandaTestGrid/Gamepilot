"""工作流目录：一个目录 = 一个工作流（= 一张状态图）。

层级见 docs/WORKSPACE-CONTRACT.md v4：**工作区（= 用户选的一个文件夹）› 工作流**，
工作流是工作区根下的**直接子目录**：

    <工作区根>/
    ├── .trash/                 ← 删掉的工作流（可恢复，不做真删除）
    ├── 斗技/                    ← 工作流
    │   ├── graph.json          ← 状态图（唯一真源）
    │   └── templates/          ← 识别器模板 PNG
    └── 御魂/
        └── ...

本模块是**纯文件系统逻辑**，不认识 RPC、不碰 stdout：

- 名称规则统一走 `validate_name`（长度 1~64、禁止 `/ \\ : * ? " < > |`、
  不以 `.` 开头或结尾），错误信息是中文、可直接显示给用户；
- 列举工作流时只认**直接子目录 + 含 `graph.json`**，隐藏目录（`.` 开头）一律不算；
- 删除一律是**移动到回收站，不做真删除**：回收站在哪由调用方定（`trash_into`），
  工作区里的工作流进 `<工作区>/.trash`（见 `workspace`）。

副作用：所有写操作都会在磁盘上建/改/移目录。
"""

from __future__ import annotations

import os
import shutil
import time
from typing import Any

from .core.graph import Graph

GRAPH_FILE = "graph.json"
TRASH_DIR = ".trash"
MAX_NAME_LEN = 64

# Windows/macOS 上都非法的文件名字符（含路径分隔符，避免逃出工作区根）
_INVALID_CHARS = '/\\:*?"<>|'
_TRASH_STAMP_FORMAT = "%Y%m%d-%H%M%S"


def norm_path(path: str) -> str:
    """统一路径：展开 `~`、绝对化、**解析符号链接**。

    macOS 上 `/var/...` 是 `/private/var/...` 的软链：引擎回给前端的路径必须
    和 `Path.resolve()` 一致，否则前端拿它当 key 会对不上。
    """
    return os.path.realpath(os.path.abspath(os.path.expanduser(path)))


def _abs(path: str) -> str:
    return norm_path(path)


def _same_dir(left: str, right: str) -> bool:
    """两个路径是否指向同一个目录（大小写不敏感的文件系统上改名会命中这里）。"""
    try:
        return os.path.samefile(left, right)
    except OSError:
        return False


def _require_dir(path: str, what: str) -> str:
    resolved = _abs(path)
    if not os.path.isdir(resolved):
        raise ValueError(f"{what}不存在: {resolved}")
    return resolved


def validate_name(name: str, what: str = "工作流名") -> str:
    """校验名字（工作流名等），合法时原样返回；非法时抛中文 ValueError（可直接给用户看）。"""
    if not name:
        raise ValueError(f"{what}不能为空")
    if len(name) > MAX_NAME_LEN:
        raise ValueError(f"{what}太长：最多 {MAX_NAME_LEN} 个字符（当前 {len(name)} 个）")
    bad = sorted({char for char in name if char in _INVALID_CHARS})
    if bad:
        raise ValueError(f"{what}不能包含这些字符：{' '.join(bad)}")
    if name.startswith(".") or name.endswith("."):
        raise ValueError(f"{what}不能以 . 开头或结尾")
    return name


def _count_templates(root: str) -> int:
    templates = os.path.join(root, "templates")
    if not os.path.isdir(templates):
        return 0
    with os.scandir(templates) as entries:
        return sum(1 for entry in entries if entry.is_file())


def _mtime(path: str) -> float:
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def workflow_modified(root: str) -> int:
    """工作流最近一次改动（epoch 秒，整数）：`max(graph.json mtime, 工作流目录 mtime)`。

    面板里显示「10 分钟」这种相对时间就是拿它算的。
    """
    return int(max(_mtime(root), _mtime(os.path.join(root, GRAPH_FILE))))


def list_workflows(base: str) -> list[dict[str, Any]]:
    """列出**工作区根** `base` 下的工作流（含 `graph.json` 的直接子目录），按 name 排序。

    - 隐藏目录（`.` 开头，含 `.trash`）与没有 `graph.json` 的目录都不算工作流；
    - `base` 不是目录时返回空列表（列表接口不该因为工作区还没建就报错）；
    - 每项：`{name, root, nodes, edges, recognizers, templates, modified}`，
      其中 `templates` 是 `templates/` 里的**文件数**、`modified` 见 `workflow_modified`。
    """
    root = _abs(base)
    if not os.path.isdir(root):
        return []
    with os.scandir(root) as entries:
        names = sorted(entry.name for entry in entries if entry.is_dir() and not entry.name.startswith("."))
    items: list[dict[str, Any]] = []
    for name in names:
        workflow_root = os.path.join(root, name)
        graph_path = os.path.join(workflow_root, GRAPH_FILE)
        if not os.path.isfile(graph_path):
            continue
        graph = Graph.load(graph_path)
        items.append(
            {
                "name": name,
                "root": workflow_root,
                "nodes": len(graph.nodes),
                "edges": len(graph.edges),
                "recognizers": len(graph.recognizers),
                "templates": _count_templates(workflow_root),
                "modified": workflow_modified(workflow_root),
            }
        )
    return items


def create_workflow(base: str, name: str) -> str:
    """在工作区根 `base` 下新建空工作流（空 `graph.json` + `templates/`），返回新 root。"""
    validate_name(name)
    root = _require_dir(base, "工作区目录")
    target = os.path.join(root, name)
    if os.path.exists(target):
        raise ValueError(f"已经有叫「{name}」的工作流了")
    os.makedirs(os.path.join(target, "templates"))
    Graph.empty(target).save(os.path.join(target, GRAPH_FILE))
    return target


def duplicate_workflow(src_root: str, base: str, name: str) -> str:
    """复制一个已有工作流（`graph.json` + 整个 `templates/`）到新名字，返回新 root。"""
    validate_name(name)
    source = _abs(src_root)
    if not os.path.isfile(os.path.join(source, GRAPH_FILE)):
        raise ValueError(f"工作流目录不存在: {source}")
    root = _require_dir(base, "工作区目录")
    target = os.path.join(root, name)
    if os.path.exists(target):
        raise ValueError(f"已经有叫「{name}」的工作流了")
    os.makedirs(target)
    shutil.copy2(os.path.join(source, GRAPH_FILE), os.path.join(target, GRAPH_FILE))
    source_templates = os.path.join(source, "templates")
    target_templates = os.path.join(target, "templates")
    if os.path.isdir(source_templates):
        shutil.copytree(source_templates, target_templates)
    else:
        os.makedirs(target_templates)
    return target


def rename_workflow(root: str, name: str) -> str:
    """重命名工作流目录（同工作区内改名），返回新 root。"""
    validate_name(name)
    source = _require_dir(root, "工作流目录")
    target = os.path.join(os.path.dirname(source), name)
    if os.path.exists(target) and not _same_dir(source, target):
        raise ValueError(f"已经有叫「{name}」的工作流了")
    os.rename(source, target)
    return target


def trash_into(root: str, trash: str, what: str = "目录") -> str:
    """把目录 `root` 移进指定的回收站 `trash`：`<trash>/<名字>-<YYYYmmdd-HHMMSS>/`。

    **不做真删除**，返回回收站里的路径；同一秒内删两个同名目录时追加序号，不覆盖前一个。
    调用方决定回收站在哪：工作区里的工作流进 `<工作区>/.trash`（见 `workspace`）。
    `what` 只影响报错文案（工作流目录 / 工作区目录……）。
    """
    source = _require_dir(root, what)
    # 回收站路径按调用方给的写法保留（`<配置目录>/.trash` 不解析符号链接，
    # 返回值要和它一致）；源目录仍然取 realpath，保证等价路径也能删。
    destination = os.path.abspath(os.path.expanduser(trash))
    os.makedirs(destination, exist_ok=True)
    name = os.path.basename(source)
    stamp = time.strftime(_TRASH_STAMP_FORMAT, time.localtime())
    target = os.path.join(destination, f"{name}-{stamp}")
    index = 2
    while os.path.exists(target):
        target = os.path.join(destination, f"{name}-{stamp}-{index}")
        index += 1
    shutil.move(source, target)
    return target


__all__ = [
    "GRAPH_FILE",
    "MAX_NAME_LEN",
    "TRASH_DIR",
    "create_workflow",
    "duplicate_workflow",
    "list_workflows",
    "norm_path",
    "rename_workflow",
    "trash_into",
    "validate_name",
    "workflow_modified",
]
