"""引擎配置（`config.json`）：当前工作区 + 最近使用列表（契约 §1）。

全部在 `tmp_path` 上跑：`GAMEPILOT_CONFIG_DIR` 指到临时目录，**不碰用户真实的配置目录**。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from gamepilot import config


@pytest.fixture()
def cfg_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """配置目录 → tmp_path/config（不碰用户真实配置）。"""
    root = tmp_path / "config"
    monkeypatch.setenv(config.CONFIG_DIR_ENV, str(root))
    monkeypatch.delenv(config.WORKSPACE_DIR_ENV, raising=False)
    return root


# --------------------------------------------------------------------------- #
# 目录解析
# --------------------------------------------------------------------------- #


def test_config_dir_follows_env(cfg_dir: Path) -> None:
    assert config.config_dir() == str(cfg_dir)
    assert config.config_path() == str(cfg_dir / config.CONFIG_FILE)


def test_default_config_dir_is_platform_specific(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """平台默认目录：macOS / Linux / Windows 各按自己的规矩。

    `default_config_dir()` 同时看 `sys.platform`（darwin）和 `os.name`（nt），
    所以三个分支都得把这两个摆到位 —— 只改 `sys.platform` 的话，在 Windows 上会一直
    落到 nt 那条（真机就是），另外两条永远测不到。
    """
    monkeypatch.delenv(config.CONFIG_DIR_ENV, raising=False)
    # `~` 的展开两边都要钉住：POSIX 看 HOME，Windows 看 USERPROFILE
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.delenv("APPDATA", raising=False)

    monkeypatch.setattr(os, "name", "posix")
    monkeypatch.setattr(sys, "platform", "darwin")
    assert config.default_config_dir() == str(tmp_path / "Library" / "Application Support" / "gamepilot")

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    assert config.default_config_dir() == str(tmp_path / "xdg" / "gamepilot")

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.delenv("XDG_CONFIG_HOME")
    assert config.default_config_dir() == str(tmp_path / ".config" / "gamepilot")

    monkeypatch.setattr(os, "name", "nt")
    monkeypatch.setenv("APPDATA", str(tmp_path / "Roaming"))
    assert config.default_config_dir() == str(tmp_path / "Roaming" / "gamepilot")


# --------------------------------------------------------------------------- #
# 读写与容错
# --------------------------------------------------------------------------- #


def test_load_without_file_is_empty_and_creates_nothing(cfg_dir: Path) -> None:
    assert config.load() == config.Config(active=None, workspaces=())
    assert not cfg_dir.exists(), "读配置不该顺手建目录"


def test_save_then_load_round_trip(cfg_dir: Path) -> None:
    alpha = str(cfg_dir.parent / "a")
    beta = str(cfg_dir.parent / "b")

    saved = config.save(config.Config(active=alpha, workspaces=(alpha, beta), names={alpha: "我的工作区"}))

    assert saved == str(cfg_dir / config.CONFIG_FILE)
    assert config.load() == config.Config(active=alpha, workspaces=(alpha, beta), names={alpha: "我的工作区"})
    with open(cfg_dir / config.CONFIG_FILE, encoding="utf-8") as handle:
        raw = json.load(handle)
    assert raw == {
        "active": alpha,
        "workspaces": [alpha, beta],
        "names": {alpha: "我的工作区"},
    }, "存的是绝对路径、最近使用在前；显示名旁挂在 names 里"


def test_load_dedupes_and_keeps_the_mru_order(cfg_dir: Path) -> None:
    """去重、保序（最近使用在前）；active 在列表里就保持它原来的位置。"""
    one = str(cfg_dir.parent / "one")
    two = str(cfg_dir.parent / "two")
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / config.CONFIG_FILE).write_text(
        json.dumps({"active": two, "workspaces": [one, one, two]}), encoding="utf-8"
    )

    cfg = config.load()

    assert cfg.workspaces == (one, two)
    assert cfg.active == two


def test_old_config_without_names_still_loads_and_falls_back_to_dirname(cfg_dir: Path) -> None:
    """v3 的老配置没有 `names`：读得动，显示名退化成目录名（不报错、不改写文件）。"""
    alpha = str(cfg_dir.parent / "my-game-bot")
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / config.CONFIG_FILE).write_text(json.dumps({"active": alpha, "workspaces": [alpha]}), encoding="utf-8")

    cfg = config.load()

    assert cfg.workspaces == (alpha,)
    assert cfg.names == {}
    assert config.display_name(cfg, alpha) == "my-game-bot"


def test_display_name_prefers_the_stored_name(cfg_dir: Path) -> None:
    alpha = str(cfg_dir.parent / "my-game-bot")
    cfg = config.Config(active=alpha, workspaces=(alpha,), names={alpha: "阴阳师专用"})
    assert config.display_name(cfg, alpha) == "阴阳师专用"
    assert config.display_name(cfg, str(cfg_dir.parent / "other")) == "other", "没存名字 → 目录名"


def test_with_workspace_keeps_or_updates_the_display_name() -> None:
    # 路径统一走 realpath（macOS 上 /tmp → /private/tmp），断言也按解析后的写法
    alpha, beta = os.path.realpath("/tmp/a"), os.path.realpath("/tmp/b")

    named = config.with_workspace(config.Config(), alpha, "我的工作区")
    assert named.names == {alpha: "我的工作区"}

    assert config.with_workspace(named, alpha) == named, "不传名字 = 只切不改名"
    updated = config.with_workspace(named, alpha, "换了个名字")
    assert updated.names == {alpha: "换了个名字"}
    assert config.with_workspace(named, beta).names == {alpha: "我的工作区"}, "新工作区不继承别人的名字"
    assert config.without_workspace(named, alpha) == config.Config(active=None, workspaces=(), names={})


def test_load_merges_active_that_is_not_in_the_list(cfg_dir: Path) -> None:
    """active 可以不在 workspaces 里（有人手改过配置）→ 并进列表最前。"""
    one = str(cfg_dir.parent / "one")
    two = str(cfg_dir.parent / "two")
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / config.CONFIG_FILE).write_text(json.dumps({"active": two, "workspaces": [one]}), encoding="utf-8")

    cfg = config.load()

    assert cfg.workspaces == (two, one)
    assert cfg.active == two


@pytest.mark.parametrize(
    "payload",
    [
        "{不是 JSON",
        "[]",
        '"字符串"',
        "null",
        '{"active": 3, "workspaces": "不是数组"}',
        '{"workspaces": [1, null, ""]}',
        "{}",
    ],
)
def test_corrupt_config_is_treated_as_empty(cfg_dir: Path, payload: str) -> None:
    """坏 config.json 不能让 App 起不来：一律当空配置。"""
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / config.CONFIG_FILE).write_text(payload, encoding="utf-8")

    cfg = config.load()

    assert cfg.active is None
    assert cfg.workspaces == ()


def test_with_workspace_keeps_position_and_activates() -> None:
    # 路径统一走 realpath（macOS 上 /tmp → /private/tmp），断言也按解析后的写法
    alpha, beta = os.path.realpath("/tmp/a"), os.path.realpath("/tmp/b")
    cfg = config.Config(active=beta, workspaces=(beta, alpha))

    updated = config.with_workspace(cfg, alpha)

    assert updated.active == alpha
    assert updated.workspaces == (beta, alpha), "切过去不改顺序（用户明确不要挪到最上面）"
    assert config.with_workspace(updated, alpha) == updated, "幂等"


def test_with_workspace_appends_a_new_directory_at_the_end() -> None:
    alpha, beta = os.path.realpath("/tmp/a"), os.path.realpath("/tmp/b")
    cfg = config.Config(active=alpha, workspaces=(alpha,))

    assert config.with_workspace(cfg, beta).workspaces == (alpha, beta), "新目录追加在末尾"


def test_without_workspace_clears_active_when_it_was_active() -> None:
    # 路径统一走 realpath（macOS 上 /tmp → /private/tmp），断言也按解析后的写法
    alpha, beta = os.path.realpath("/tmp/a"), os.path.realpath("/tmp/b")
    cfg = config.Config(active=alpha, workspaces=(alpha, beta))

    assert config.without_workspace(cfg, alpha) == config.Config(active=None, workspaces=(beta,))
    assert config.without_workspace(cfg, beta) == config.Config(active=alpha, workspaces=(alpha,))


# --------------------------------------------------------------------------- #
# 逃生口：GAMEPILOT_WORKSPACE_DIR 跳过配置读写
# --------------------------------------------------------------------------- #


def test_pinned_workspace_seeds_in_memory_and_never_writes_a_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pinned = tmp_path / "pinned"
    monkeypatch.delenv(config.CONFIG_DIR_ENV, raising=False)
    # 默认配置目录也要钉在临时目录里：Windows 看 APPDATA（否则这一条会去读用户真实的 config.json）
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setenv(config.WORKSPACE_DIR_ENV, str(pinned))

    cfg = config.load()
    assert cfg.active == str(pinned)
    assert cfg.workspaces == (str(pinned),)
    assert config.save(config.Config(active=None, workspaces=())) is None, "逃生口模式不写盘"
    assert config.load().active is None, "改的是进程内状态"
    assert not config.config_path().startswith(str(tmp_path / "pinned"))
    assert not Path(config.config_path()).exists(), "一个字节都不该写到配置文件"


def test_pinned_workspace_is_none_without_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(config.WORKSPACE_DIR_ENV, raising=False)
    assert config.pinned_workspace() is None
