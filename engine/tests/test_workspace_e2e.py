"""契约 §4.4 的端到端验收：**真实引擎子进程** + 临时目录（工作区与配置都隔离）。

这一份是可重复跑的"手动端到端"：空配置 → add → 幂等 → 项目/脚本全流程 → 删工作区（真删除）
→ **重启引擎进程**后列表与当前仍然记得。

和 `test_workspace_rpc.py`（进程内 RpcServer）互补：这里走真正的 `python -m gamepilot.rpc`，
配置**必须真的落盘**（否则重启就丢了）。
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

MODULE = "gamepilot.rpc"


class Engine:
    """一个真实引擎子进程（stdio JSON-RPC）；配置目录/逃生口都由调用方指定。"""

    def __init__(self, *, config_dir: Path, workspace_dir: str | None = None) -> None:
        env = {**os.environ, "GAMEPILOT_LOG_LEVEL": "ERROR", "GAMEPILOT_CONFIG_DIR": str(config_dir)}
        env.pop("GAMEPILOT_PROJECT_DIR", None)
        if workspace_dir is None:
            env.pop("GAMEPILOT_WORKSPACE_DIR", None)
        else:
            env["GAMEPILOT_WORKSPACE_DIR"] = workspace_dir
        self.proc = subprocess.Popen(
            [sys.executable, "-m", MODULE],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            env=env,
        )
        self._id = 0
        ready = self._read()
        assert ready["method"] == "engine.ready", ready

    def _read(self) -> dict[str, Any]:
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline()
        assert line, "引擎没有输出（进程可能退出了）"
        payload = json.loads(line)
        assert isinstance(payload, dict)
        return payload

    def _send(self, method: str, params: dict[str, Any] | None) -> int:
        self._id += 1
        assert self.proc.stdin is not None
        payload = {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}}
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        return self._id

    def reply(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """发一条请求，返回整条响应（成功或错误都原样返回）。"""
        request_id = self._send(method, params)
        while True:
            message = self._read()
            if message.get("id") == request_id:
                return message

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        response = self.reply(method, params)
        assert "error" not in response, response
        result = response["result"]
        assert isinstance(result, dict), result
        return result

    def close(self) -> None:
        if self.proc.stdin is not None:
            with contextlib.suppress(Exception):
                self.call("engine.shutdown")
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait(timeout=5)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            with contextlib.suppress(Exception):
                if stream is not None:
                    stream.close()


def _error(engine: Engine, method: str, params: dict[str, Any]) -> str:
    """发一条**必失败**的请求，返回中文错误文案。"""
    response = engine.reply(method, params)
    assert "error" in response, response
    return str(response["error"]["message"])


def _workflow_names(tree: dict[str, Any]) -> list[str]:
    return [item["name"] for item in tree["workflows"]]


def test_v4_end_to_end_with_restart(tmp_path: Path) -> None:
    """契约 §4.4：空配置 → 加空文件夹（零文件）→ 幂等改名 → 工作流全流程 → 删工作区 → 重启记忆。"""
    cfg_dir = tmp_path / "config"
    alpha = tmp_path / "工作区A"
    beta = tmp_path / "工作区B"

    engine = Engine(config_dir=cfg_dir)
    try:
        # ① 空配置：active 为 null、items 为空
        listing = engine.call("workspace.list")
        assert listing["active"] is None
        assert listing["items"] == []

        assert Path(listing["recommended"]).name == "默认"

        # ② add 一个**空临时目录** + 显示名 → 磁盘上一个文件都没有
        added = engine.call("workspace.add", {"dir": str(alpha), "name": "我的工作区"})
        assert added["root"] == str(alpha)
        assert added["name"] == "我的工作区"
        assert list(alpha.iterdir()) == [], "接入空文件夹时什么都不建"
        assert not list(alpha.rglob("*")), "连一个文件/目录都不该有"
        assert added["tree"] == {"root": str(alpha), "workflows": []}
        assert added["current"] == "", "没有工作流 → 没有当前工作流"
        assert engine.call("project.get")["root"] == ""

        # ③ 同目录再 add + 新名字 → 幂等 + 改名；只传 dir → 名字保持不变
        renamed = engine.call("workspace.add", {"dir": str(alpha), "name": "改过名字的"})
        assert renamed["name"] == "改过名字的"
        assert len(renamed["items"]) == 1, "幂等：没有重复条目"
        kept = engine.call("workspace.add", {"dir": str(alpha)})
        assert kept["name"] == "改过名字的", "只传 dir 不传 name → 名字保持不变"

        engine.call("workspace.add", {"dir": str(beta), "name": "工作区B"})
        both = engine.call("workspace.list")
        # 顺序 = 登记顺序（新加的追加在末尾）；切工作区不改顺序
        assert [item["name"] for item in both["items"]] == ["改过名字的", "工作区B"]
        assert both["active"] == str(beta), "当前是最后加的那个"

        # ④ workflow.create 必须带名字，建完切过去
        assert "缺少参数 name" in _error(engine, "workflow.create", {})
        engine.call("workspace.add", {"dir": str(alpha)})  # 切回 A，名字沿用
        made = engine.call("workflow.create", {"name": "斗技"})
        assert made["created"] == str(alpha / "斗技"), "工作流建在工作区根下"
        assert (alpha / "斗技" / "graph.json").is_file()
        assert (alpha / "斗技" / "templates").is_dir()
        assert made["current"] == made["created"], "建完切过去"

        # ⑤ 再来一个 + 切换 + 改名 + 复制 + 删（校验 .trash/）
        engine.call("workflow.create", {"name": "御魂"})
        engine.call("project.set", {"dir": str(alpha / "斗技")})
        renamed_wf = engine.call("workflow.rename", {"dir": str(alpha / "斗技"), "name": "斗技改"})
        assert renamed_wf["root"] == str(alpha / "斗技改")
        assert not (alpha / "斗技").exists()
        assert renamed_wf["current"] == renamed_wf["root"], "改的是当前工作流 → 跟着走"
        copy = engine.call("workflow.duplicate", {"dir": renamed_wf["root"]})
        assert Path(copy["created"]).is_dir()
        assert engine.call("project.get")["root"] == copy["created"], "复制完切到副本"
        deleted = engine.call("workflow.delete", {"dir": copy["created"]})
        assert Path(str(deleted["removed"])).name == "斗技改-副本", "返回被真删掉的目录"
        assert not (alpha / ".trash").exists(), "不再有回收站"
        assert engine.call("project.get")["root"] != "", "删当前 → 切到剩下的"
        tree = engine.call("workspace.tree")
        assert _workflow_names(tree) == ["御魂", "斗技改"], "按 name 排序"
        assert all(isinstance(item["modified"], int) and item["modified"] > 0 for item in tree["workflows"])

        # ⑥ 把工作流全删掉 → 当前工作流为空串（不崩、不自动补建）
        for item in engine.call("workspace.tree")["workflows"]:
            engine.call("workflow.delete", {"dir": item["root"]})
        assert _workflow_names(engine.call("workspace.tree")) == []
        assert engine.call("project.get")["root"] == ""

        # ⑦ remove deleteFiles=true → 目录**真删除**，当前切回 A
        removed = engine.call("workspace.remove", {"dir": str(beta), "deleteFiles": True})
        assert not beta.exists(), "目录真的删掉了"
        assert Path(str(removed["removed"])).name == "工作区B"
        assert not (cfg_dir / ".trash").exists(), "不再有全局回收站"
        assert removed["active"] == str(alpha), "当前工作区切回上一个"
    finally:
        engine.close()

    # ⑧ 重启引擎进程 → 列表 / 显示名 / active 都记得
    restarted = Engine(config_dir=cfg_dir)
    try:
        listing = restarted.call("workspace.list")
        assert [item["name"] for item in listing["items"]] == ["改过名字的"], "显示名活过重启"
        assert listing["active"] == str(alpha)
        assert listing["items"][0]["exists"] is True
        assert restarted.call("workspace.tree") == {"root": str(alpha), "workflows": []}
    finally:
        restarted.close()


def test_pinned_workspace_dir_overrides_config_and_skips_config_file(tmp_path: Path) -> None:
    """`GAMEPILOT_WORKSPACE_DIR` 仍然覆盖当前工作区，并且**跳过配置读写**。"""
    cfg_dir = tmp_path / "config"
    pinned = tmp_path / "钉住的工作区"
    pinned.mkdir()

    engine = Engine(config_dir=cfg_dir, workspace_dir=str(pinned))
    try:
        listing = engine.call("workspace.list")
        assert listing["active"] == str(pinned)
        assert listing["items"] == [{"name": "钉住的工作区", "root": str(pinned), "active": True, "exists": True}]
        created = engine.call("workflow.create", {"name": "斗技"})
        assert created["created"] == str(pinned / "斗技")
        assert [item["name"] for item in created["items"]] == ["斗技"]
    finally:
        engine.close()

    assert not (cfg_dir / "config.json").exists(), "逃生口模式：一个字节都不写配置文件"


def test_corrupt_config_does_not_stop_the_app(tmp_path: Path) -> None:
    """坏 config.json 不能让 App 起不来：当空配置用，而且还能正常 add 覆盖它。"""
    cfg_dir = tmp_path / "config"
    cfg_dir.mkdir(parents=True)
    (cfg_dir / "config.json").write_text("{这不是 JSON", encoding="utf-8")

    engine = Engine(config_dir=cfg_dir)
    try:
        listing = engine.call("workspace.list")
        assert listing["active"] is None
        assert listing["items"] == []

        added = engine.call("workspace.add", {"dir": str(tmp_path / "新工作区"), "name": "新工作区"})
        assert added["items"][0]["name"] == "新工作区"
        assert added["items"][0]["active"] is True
    finally:
        engine.close()

    with open(cfg_dir / "config.json", encoding="utf-8") as handle:
        assert json.load(handle)["active"] == str(tmp_path / "新工作区")
