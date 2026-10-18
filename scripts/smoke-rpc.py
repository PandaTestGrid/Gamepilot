#!/usr/bin/env python3
"""端到端冒烟：拿**真实引擎子进程**核对 v4 契约（docs/WORKSPACE-CONTRACT.md）。

这是 Lead 的独立验收工具 —— 不依赖引擎/前端各自的测试，直接按协议打 stdio JSON-RPC。

用法：
    engine/.venv/bin/python scripts/smoke-rpc.py

隔离：临时工作区目录 + 临时 config 目录（`GAMEPILOT_CONFIG_DIR`），
绝不碰用户真实工作区与真实 config.json。退出码 0 = 全过。

覆盖（契约 §4.4）：
  1. 空配置 → workspace.list 的 active 为 null、items 为空
  2. workspace.add 一个空文件夹 + 名字 → 磁盘**一个文件都没有**，列表用显示名
  3. 同目录再 add + 新名字 → 幂等且改名
  4. workflow.create { name } → 目录 + graph.json 出现并切过去
  5. 再建一个、切换、改名、复制、删（校验目录真的没了）
  6. workspace.remove { deleteFiles: true } → 真删（目录真的没了）
  7. 重启引擎进程 → 列表 / 名字 / active / 当前工作流都记得
  8. 删掉最后一个工作流 → project.get().root == ""
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

ENGINE_SRC = Path(__file__).resolve().parent.parent / "engine" / "src"

FAILURES: list[str] = []
CHECKS = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if condition:
        print(f"  \033[32mPASS\033[0m {label}")
        return
    FAILURES.append(label)
    print(f"  \033[31mFAIL\033[0m {label}" + (f" —— {detail}" if detail else ""))


class Engine:
    """一个真实的 `python -m gamepilot.rpc` 子进程。"""

    def __init__(self, config_dir: Path, env_extra: dict[str, str] | None = None) -> None:
        env = {
            **os.environ,
            "PYTHONPATH": str(ENGINE_SRC),
            "GAMEPILOT_CONFIG_DIR": str(config_dir),
            "GAMEPILOT_LOG_LEVEL": "ERROR",
            **(env_extra or {}),
        }
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "gamepilot.rpc"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            env=env,
        )
        self._id = 0
        self._wait_ready()

    def _wait_ready(self, timeout: float = 20.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline() if self.proc.stdout else ""
            if not line:
                break
            frame = json.loads(line)
            if frame.get("method") == "engine.ready":
                self.methods = set(frame.get("params", {}).get("methods", []))
                return
        raise RuntimeError("引擎没有发 engine.ready")

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        assert self.proc.stdin and self.proc.stdout
        self._id += 1
        request = {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}}
        self.proc.stdin.write(json.dumps(request) + "\n")
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError(f"{method}: 引擎没回话（进程挂了？）")
            frame = json.loads(line)
            if frame.get("id") != self._id:
                continue  # 通知（engine.frame / project.changed 之类）跳过
            if "error" in frame:
                raise RuntimeError(f"{method} 报错: {frame['error'].get('message')}")
            return frame["result"]

    def close(self) -> None:
        try:
            self.call("engine.shutdown")
        except Exception:  # noqa: BLE001 —— 关不掉就直接杀，冒烟脚本不纠结
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def files_under(path: Path) -> list[str]:
    return sorted(str(item.relative_to(path)) for item in path.rglob("*") if item.is_file())


def main() -> int:
    work = Path(tempfile.mkdtemp(prefix="gamepilot-smoke-ws-"))
    config = Path(tempfile.mkdtemp(prefix="gamepilot-smoke-cfg-"))
    ws_a = work / "工作区A"
    ws_b = work / "工作区B"
    print(f"临时工作区: {work}\n临时配置:   {config}\n")

    engine = Engine(config)
    try:
        # ---------------------------------------------------------------- 1
        print("[1] 空配置")
        listing = engine.call("workspace.list")
        check("active 为 null", listing["active"] is None, repr(listing["active"]))
        check("items 为空", listing["items"] == [], repr(listing["items"]))
        check("没有 trashRoot（回收站没了）", "trashRoot" not in listing, repr(sorted(listing)))
        check("带 recommended", isinstance(listing.get("recommended"), str), "")

        # ---------------------------------------------------------------- 2
        print("[2] 添加空文件夹当工作区（带显示名）")
        added = engine.call("workspace.add", {"dir": str(ws_a), "name": "我的工作区"})
        check("返回 root 是选的目录", added["root"] == str(ws_a.resolve()), added["root"])
        check("列表用显示名", added["name"] == "我的工作区", added["name"])
        check("磁盘上一个文件都没有（不许建默认项目/默认工作流）", files_under(ws_a) == [], str(files_under(ws_a)))
        check("树里没有工作流", added["tree"].get("workflows", []) == [], str(added["tree"]))
        check("当前工作流为空串（一等状态）", engine.call("project.get")["root"] == "", "")

        # ---------------------------------------------------------------- 3
        print("[3] 同目录再 add（幂等 + 改名）")
        renamed_ws = engine.call("workspace.add", {"dir": str(ws_a), "name": "改过名字的工作区"})
        check("名字被更新", renamed_ws["name"] == "改过名字的工作区", renamed_ws["name"])
        check("列表里只有一条（没重复）", len(renamed_ws["items"]) == 1, str(renamed_ws["items"]))
        engine.call("workspace.add", {"dir": str(ws_b), "name": "工作区B"})
        both = engine.call("workspace.list")
        check("两个工作区都在", len(both["items"]) == 2, str(both["items"]))
        check("当前是最后加的那个", both["active"] == str(ws_b.resolve()), str(both["active"]))

        # ---------------------------------------------------------------- 4
        print("[4] workflow.create（必须带名字）")
        engine.call("workspace.add", {"dir": str(ws_a)})  # 只切回 A，名字沿用列表里已有的
        made = engine.call("workflow.create", {"name": "斗技"})
        script = ws_a / "斗技"
        check("目录建在工作区根下", made["created"] == str(script.resolve()), made["created"])
        check("graph.json 落盘", (script / "graph.json").is_file(), str(files_under(ws_a)))
        check("templates/ 落盘", (script / "templates").is_dir(), "")
        check("建完切过去", made["current"] == str(script.resolve()), made["current"])

        # ---------------------------------------------------------------- 5
        print("[5] 再来一个 + 切换 + 改名 + 复制 + 删除")
        engine.call("workflow.create", {"name": "御魂"})
        engine.call("project.set", {"dir": str(script)})
        renamed = engine.call("workflow.rename", {"dir": str(script), "name": "斗技改"})
        check("改名后目录动了", (ws_a / "斗技改").is_dir() and not script.exists(), str(files_under(ws_a)))
        check("改名后 current 跟着走", renamed["current"] == str((ws_a / "斗技改").resolve()), renamed["current"])
        copy = engine.call("workflow.duplicate", {"dir": renamed["root"]})
        check("复制出副本", Path(copy["created"]).is_dir(), copy["created"])
        deleted = engine.call("workflow.delete", {"dir": copy["created"]})
        check("目录真的删掉了", not script.exists(), str(script))
        check("删掉的是当前 → 切到剩下的", engine.call("project.get")["root"] != "", "")
        tree = engine.call("workspace.tree")
        names = [item["name"] for item in tree.get("workflows", [])]
        check("树里剩两个工作流", sorted(names) == sorted(["斗技改", "御魂"]), str(names))
        workflows = tree.get("workflows", [])
        check(
            "工作流带 modified",
            bool(workflows) and isinstance(workflows[0].get("modified"), int),
            str(workflows[0] if workflows else tree),
        )

        # ---------------------------------------------------------------- 8（删空）
        print("[6] 把工作流全删掉 → 当前工作流为空串")
        for item in engine.call("workspace.tree").get("workflows", []):
            engine.call("workflow.delete", {"dir": item["root"]})
        check("全删后没有工作流", engine.call("workspace.tree").get("workflows", []) == [], "")
        check("project.get().root 为空串", engine.call("project.get")["root"] == "", "")

        # ---------------------------------------------------------------- 6（remove 工作区）
        print("[7] workspace.remove deleteFiles=true → 真删")
        removed = engine.call("workspace.remove", {"dir": str(ws_b), "deleteFiles": True})
        check("目录从原位置消失", not ws_b.exists(), str(ws_b))
        check("回传 removed", Path(str(removed.get("removed"))).name == ws_b.name, str(removed.get("removed")))
        check("没有留下回收站", not (config / ".trash").exists(), str(config / ".trash"))
        check("当前工作区切回 A", removed["active"] == str(ws_a.resolve()), str(removed["active"]))
    finally:
        engine.close()

    # ---------------------------------------------------------------- 7（重启记忆）
    print("[8] 重启引擎进程 → 记得列表 / 名字 / active")
    engine2 = Engine(config)
    try:
        listing = engine2.call("workspace.list")
        names = [item["name"] for item in listing["items"]]
        check("列表记得", names == ["改过名字的工作区"], str(names))
        check("显示名活过重启（config.json 的 names）", listing["items"][0]["name"] == "改过名字的工作区", str(listing["items"][0]))
        check("active 记得", listing["active"] == str(ws_a.resolve()), str(listing["active"]))
        check("没被 remove 的那个还在磁盘上", ws_a.is_dir(), "")
    finally:
        engine2.close()

    # ---------------------------------------------------------------- 9（逃生口）
    print("[9] GAMEPILOT_WORKSPACE_DIR 仍能覆盖（测试逃生口）")
    escape = work / "逃生口"
    escape.mkdir()
    engine3 = Engine(config, {"GAMEPILOT_WORKSPACE_DIR": str(escape)})
    try:
        listing = engine3.call("workspace.list")
        check("active 被环境变量覆盖", listing["active"] == str(escape.resolve()), str(listing["active"]))
    finally:
        engine3.close()

    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(config, ignore_errors=True)

    print()
    if FAILURES:
        print(f"\033[31m失败 {len(FAILURES)}/{CHECKS}\033[0m")
        for item in FAILURES:
            print(f"  - {item}")
        return 1
    print(f"\033[32m全部通过（{CHECKS} 项）\033[0m")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
