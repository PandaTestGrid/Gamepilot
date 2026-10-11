"""脚本库：一个目录 = 一个状态图（多状态图 = 一个库里的多个目录）。

目录布局（契约见 docs/rpc.md「脚本库（多状态图）」）：

    <库根>/
    ├── <脚本名>/
    │   ├── graph.json      状态图（唯一真源）
    │   └── templates/      识别器模板 PNG
    └── .trash/             删除的脚本：<名字>-<YYYYmmdd-HHMMSS>/（可恢复）

本模块是**纯文件系统逻辑**，不认识 RPC、不碰 stdout：

- 名称规则统一走 `validate_name`（长度 1~64、禁止 `/ \\ : * ? " < > |`、
  不以 `.` 开头或结尾），错误信息是中文、可直接显示给用户；
- 列举脚本时跳过 `.trash` 与没有 `graph.json` 的目录；
- 删除一律是**移动到 `.trash/`，不做真删除**（用户后悔时能捞回来）。

副作用：所有写操作都会在磁盘上建/改/移目录。
"""

from __future__ import annotations

import os
import shutil
import time
from typing import Any

from .core.graph import Graph

SCRIPT_FILE = "graph.json"
TRASH_DIR = ".trash"
MAX_NAME_LEN = 64

# Windows/macOS 上都非法的文件名字符（含路径分隔符，避免逃出库根）
_INVALID_CHARS = '/\\:*?"<>|'
_TRASH_STAMP_FORMAT = "%Y%m%d-%H%M%S"


def _abs(path: str) -> str:
    """用户给的路径统一成绝对路径（支持 `~`）。"""
    return os.path.abspath(os.path.expanduser(path))


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


def library_root(current_root: str) -> str:
    """库根 = 当前脚本目录的父目录。"""
    return os.path.dirname(_abs(current_root))


def validate_name(name: str) -> str:
    """校验脚本名，合法时原样返回；非法时抛中文 ValueError（可直接给用户看）。"""
    if not name:
        raise ValueError("脚本名不能为空")
    if len(name) > MAX_NAME_LEN:
        raise ValueError(f"脚本名太长：最多 {MAX_NAME_LEN} 个字符（当前 {len(name)} 个）")
    bad = sorted({char for char in name if char in _INVALID_CHARS})
    if bad:
        raise ValueError(f"脚本名不能包含这些字符：{' '.join(bad)}")
    if name.startswith(".") or name.endswith("."):
        raise ValueError("脚本名不能以 . 开头或结尾")
    return name


def _count_templates(root: str) -> int:
    templates = os.path.join(root, "templates")
    if not os.path.isdir(templates):
        return 0
    with os.scandir(templates) as entries:
        return sum(1 for entry in entries if entry.is_file())


def list_scripts(base: str) -> list[dict[str, Any]]:
    """列出库根下的脚本目录（含 `graph.json` 的子目录），按 name 排序。

    - 跳过 `.trash`（回收站不是脚本）与没有 `graph.json` 的目录；
    - `base` 不是目录时返回空列表（列表接口不该因为库还没建就报错）；
    - 每项：`{name, root, nodes, edges, recognizers, templates}`，
      其中 `templates` 是 `templates/` 里的**文件数**。
    """
    root = _abs(base)
    if not os.path.isdir(root):
        return []
    with os.scandir(root) as entries:
        names = sorted(entry.name for entry in entries if entry.is_dir() and entry.name != TRASH_DIR)
    items: list[dict[str, Any]] = []
    for name in names:
        script_root = os.path.join(root, name)
        if not os.path.isfile(os.path.join(script_root, SCRIPT_FILE)):
            continue
        graph = Graph.load(os.path.join(script_root, SCRIPT_FILE))
        items.append(
            {
                "name": name,
                "root": script_root,
                "nodes": len(graph.nodes),
                "edges": len(graph.edges),
                "recognizers": len(graph.recognizers),
                "templates": _count_templates(script_root),
            }
        )
    return items


def create_script(base: str, name: str) -> str:
    """新建空脚本目录（空 `graph.json` + `templates/`），返回新 root。"""
    validate_name(name)
    root = _require_dir(base, "库目录")
    target = os.path.join(root, name)
    if os.path.exists(target):
        raise ValueError(f"同库里已经有叫「{name}」的脚本了")
    os.makedirs(os.path.join(target, "templates"))
    Graph.empty(target).save(os.path.join(target, SCRIPT_FILE))
    return target


def duplicate_script(src_root: str, base: str, name: str) -> str:
    """复制一个已有脚本（`graph.json` + 整个 `templates/`）到新名字，返回新 root。"""
    validate_name(name)
    source = _abs(src_root)
    if not os.path.isfile(os.path.join(source, SCRIPT_FILE)):
        raise ValueError(f"脚本不存在或缺少 {SCRIPT_FILE}: {source}")
    root = _require_dir(base, "库目录")
    target = os.path.join(root, name)
    if os.path.exists(target):
        raise ValueError(f"同库里已经有叫「{name}」的脚本了")
    os.makedirs(target)
    shutil.copy2(os.path.join(source, SCRIPT_FILE), os.path.join(target, SCRIPT_FILE))
    source_templates = os.path.join(source, "templates")
    target_templates = os.path.join(target, "templates")
    if os.path.isdir(source_templates):
        shutil.copytree(source_templates, target_templates)
    else:
        os.makedirs(target_templates)
    return target


def rename_script(root: str, name: str) -> str:
    """重命名脚本目录（同库内改名），返回新 root。"""
    validate_name(name)
    source = _require_dir(root, "脚本目录")
    target = os.path.join(os.path.dirname(source), name)
    if os.path.exists(target) and not _same_dir(source, target):
        raise ValueError(f"同库里已经有叫「{name}」的脚本了")
    os.rename(source, target)
    return target


def trash_script(root: str) -> str:
    """把脚本移进 `<父目录>/.trash/<名字>-<YYYYmmdd-HHMMSS>/`（**不做真删除**）。

    返回回收站里的路径；同一秒内删两个同名脚本时追加序号，不覆盖前一个。
    """
    source = _require_dir(root, "脚本目录")
    script_name = os.path.basename(source)
    trash_dir = os.path.join(os.path.dirname(source), TRASH_DIR)
    os.makedirs(trash_dir, exist_ok=True)
    stamp = time.strftime(_TRASH_STAMP_FORMAT, time.localtime())
    target = os.path.join(trash_dir, f"{script_name}-{stamp}")
    index = 2
    while os.path.exists(target):
        target = os.path.join(trash_dir, f"{script_name}-{stamp}-{index}")
        index += 1
    shutil.move(source, target)
    return target


__all__ = [
    "MAX_NAME_LEN",
    "SCRIPT_FILE",
    "TRASH_DIR",
    "create_script",
    "duplicate_script",
    "library_root",
    "list_scripts",
    "rename_script",
    "trash_script",
    "validate_name",
]
