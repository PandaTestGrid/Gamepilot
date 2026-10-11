"""引擎配置（**引擎独占**，前端不直接读写文件）：当前工作区 + 最近使用的工作区列表。

优先级（契约 docs/WORKSPACE-CONTRACT.md v3 §1）：

1. `GAMEPILOT_WORKSPACE_DIR` → 直接当**当前工作区**，并且**跳过配置读写**
   （测试/开发逃生口：进程内记着，不碰用户的 config.json）
2. `GAMEPILOT_CONFIG_DIR` → `<dir>/config.json`
3. 平台默认：macOS `~/Library/Application Support/gamepilot/config.json`
   （Linux `$XDG_CONFIG_HOME/gamepilot/`、Windows `%APPDATA%\\gamepilot\\`）

config.json 形状：

    {
      "active": "/Users/me/Documents/game-a",
      "workspaces": ["/Users/me/...", ...],
      "names": {"/Users/me/...": "我的工作区"}
    }

- `workspaces` 按最近使用排序（第一个通常就是 active）、去重、必须是绝对路径；
- `names` 是**列表显示名**（`workspace.add { name }` 输的那个），加法式扩展：
  老配置（v3）没有这个键就按目录名退化，读得动、不报错；
- `active` 可以不在 `workspaces` 里（有人手改过配置）→ 载入时并进列表；
- 文件损坏 / 字段缺失 → 当空配置，**绝不因为一个坏 config.json 让 App 起不来**；
- 全局回收站：`<配置目录>/.trash/`（删整个工作区时用它，可恢复，不做真删除）。
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field

CONFIG_FILE = "config.json"
CONFIG_DIR_ENV = "GAMEPILOT_CONFIG_DIR"
WORKSPACE_DIR_ENV = "GAMEPILOT_WORKSPACE_DIR"
TRASH_DIR = ".trash"
APP_DIR_NAME = "gamepilot"

# 逃生口模式下的进程内配置：`(GAMEPILOT_WORKSPACE_DIR, 配置)`。
# 环境变量一变（换了个测试的临时目录）就重新播种，天然隔离。
_pinned: tuple[str, Config] | None = None


@dataclass(frozen=True)
class Config:
    """持久化的引擎配置：当前工作区 + 最近使用的工作区列表（最近在前）+ 列表显示名。"""

    active: str | None = None
    workspaces: tuple[str, ...] = ()
    # 显示名：`<工作区绝对路径> → 用户输的名字`（省略时按目录名退化，见 display_name）
    names: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {"active": self.active, "workspaces": list(self.workspaces), "names": dict(self.names)}


def _abs(path: str) -> str:
    """统一路径：展开 `~`、绝对化、**解析符号链接**（macOS 上 /var → /private/var 也要一致）。"""
    return os.path.realpath(os.path.abspath(os.path.expanduser(path)))


def _same_path(left: str, right: str) -> bool:
    """两个路径是不是同一个目录（大小写不敏感的文件系统上也认得出）。"""
    return os.path.normcase(os.path.realpath(left)) == os.path.normcase(os.path.realpath(right))


def default_config_dir() -> str:
    """平台默认配置目录。"""
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support", APP_DIR_NAME)
    if os.name == "nt":
        base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
        return os.path.join(base, APP_DIR_NAME)
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, APP_DIR_NAME)


def config_dir() -> str:
    """配置目录：`GAMEPILOT_CONFIG_DIR` 优先，否则平台默认。

    保留调用方给的写法（只展开 `~`、绝对化，**不解析符号链接**）：契约说回收站就是
    `<配置目录>/.trash`，把 `/var/...` 偷偷换成 `/private/var/...` 会让前端/验收对不上。
    """
    override = os.environ.get(CONFIG_DIR_ENV)
    return os.path.abspath(os.path.expanduser(override)) if override else default_config_dir()


def config_path() -> str:
    return os.path.join(config_dir(), CONFIG_FILE)


def global_trash_root() -> str:
    """全局回收站：`<配置目录>/.trash`（删整个工作区时用；前端显示它告诉用户文件去哪了）。"""
    return os.path.join(config_dir(), TRASH_DIR)


def pinned_workspace() -> str | None:
    """`GAMEPILOT_WORKSPACE_DIR` 指定的当前工作区；没设置就是 None。"""
    raw = os.environ.get(WORKSPACE_DIR_ENV)
    return _abs(raw) if raw else None


def _clean(raw: Config) -> Config:
    """规范化：绝对路径、去重（保序）、active 并进列表。坏值直接丢掉。"""
    items: list[str] = []
    seen: set[str] = set()
    for item in raw.workspaces:
        if not isinstance(item, str) or not item.strip():
            continue
        path = _abs(item)
        key = os.path.normcase(path)
        if key in seen:
            continue
        seen.add(key)
        items.append(path)
    active: str | None = None
    if isinstance(raw.active, str) and raw.active.strip():
        active = _abs(raw.active)
        if os.path.normcase(active) not in seen:
            items.insert(0, active)  # 手改过配置：active 不在列表里，并进去
    wanted = {
        os.path.normcase(_abs(key)): value.strip()
        for key, value in raw.names.items()
        if isinstance(key, str) and isinstance(value, str) and value.strip()
    }
    names = {path: wanted[os.path.normcase(path)] for path in items if os.path.normcase(path) in wanted}
    return Config(active=active, workspaces=tuple(items), names=names)


def _read_file() -> Config:
    try:
        with open(config_path(), encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return Config()
    if not isinstance(data, dict):
        return Config()
    raw_workspaces = data.get("workspaces")
    raw_active = data.get("active")
    raw_names = data.get("names")
    return _clean(
        Config(
            active=raw_active if isinstance(raw_active, str) else None,
            workspaces=tuple(item for item in raw_workspaces if isinstance(item, str))
            if isinstance(raw_workspaces, list)
            else (),
            names={key: value for key, value in raw_names.items() if isinstance(value, str)}
            if isinstance(raw_names, dict)
            else {},
        )
    )


def load() -> Config:
    """读配置：逃生口 → 进程内；否则读文件。损坏/缺失一律当空配置，不抛异常。"""
    global _pinned
    pinned = pinned_workspace()
    if pinned:
        if _pinned is None or _pinned[0] != pinned:
            _pinned = (pinned, Config(active=pinned, workspaces=(pinned,)))
        return _pinned[1]
    return _read_file()


def save(config: Config) -> str | None:
    """写配置（规范化后）；逃生口模式下只在进程内记着，**不碰配置文件**。

    返回写盘路径；逃生口模式下返回 None。
    """
    global _pinned
    clean = _clean(config)
    pinned = pinned_workspace()
    if pinned:
        _pinned = (pinned, clean)
        return None
    path = config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(clean.to_dict(), handle, ensure_ascii=False, indent=2)
    return path


def with_workspace(config: Config, root: str, name: str | None = None) -> Config:
    """把 `root` 设为当前并登记进列表（**已有的一定留在原位**：只有新目录才追加到末尾）。

    `name` 是**列表显示名**：给了就更新成它（用户可能就是来改名的）；
    没给（None / 空白）时保留列表里已有的名字 —— 只切不传名字不该把名字洗掉。
    """
    path = _abs(root)
    if any(_same_path(item, path) for item in config.workspaces):
        # 已经在列表里：原位不动，只改 active（和显示名）—— 用户明确要求"不要把它挪到最上面"
        order = tuple(config.workspaces)
    else:
        order = (*config.workspaces, path)
    names = dict(config.names)
    clean = (name or "").strip()
    if clean:
        names[path] = clean
    return _clean(Config(active=path, workspaces=order, names=names))


def without_workspace(config: Config, root: str) -> Config:
    """把 `root` 从列表里去掉（连它的显示名一起）；去掉的正是当前工作区时 active 变 None。"""
    path = _abs(root)
    kept = [item for item in config.workspaces if not _same_path(item, path)]
    names = {key: value for key, value in config.names.items() if not _same_path(key, path)}
    active = None if config.active and _same_path(config.active, path) else config.active
    return _clean(Config(active=active, workspaces=tuple(kept), names=names))


def display_name(config: Config, root: str) -> str:
    """工作区在列表里的显示名：`names` 里有就用它，否则退化成目录名。"""
    path = _abs(root)
    return config.names.get(path) or os.path.basename(path.rstrip(os.sep)) or path


__all__ = [
    "APP_DIR_NAME",
    "CONFIG_DIR_ENV",
    "CONFIG_FILE",
    "TRASH_DIR",
    "WORKSPACE_DIR_ENV",
    "Config",
    "config_dir",
    "config_path",
    "default_config_dir",
    "display_name",
    "global_trash_root",
    "load",
    "pinned_workspace",
    "save",
    "with_workspace",
    "without_workspace",
]
