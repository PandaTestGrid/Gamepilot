"""真实入口必须在旧 Windows 代码页下仍然收发 UTF-8（含中文路径及非 BMP 字符）。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize("encoding", ["gbk", "cp1252"])
@pytest.mark.parametrize("entry", ["rpc", "sidecar"])
def test_entries_use_utf8_with_legacy_stdio(tmp_path: Path, encoding: str, entry: str) -> None:
    engine_root = Path(__file__).resolve().parents[1]
    # 在执行入口前重配流，模拟 PyInstaller 按系统代码页初始化 stdio；仅设环境变量不足以覆盖冻结态。
    launcher = (
        "import runpy, sys; "
        f"[stream.reconfigure(encoding={encoding!r}) for stream in (sys.stdin, sys.stdout, sys.stderr)]; "
    )
    if entry == "rpc":
        launcher += "runpy.run_module('gamepilot.rpc', run_name='__main__')"
    else:
        launcher += f"runpy.run_path({str(engine_root / 'packaging/engine_sidecar_entry.py')!r}, run_name='__main__')"

    env = {
        **os.environ,
        "PYTHONPATH": str(engine_root / "src"),
        "PYTHONUTF8": "0",
        "PYTHONIOENCODING": encoding,
        "GAMEPILOT_CONFIG_DIR": str(tmp_path / "config"),
    }
    env.pop("GAMEPILOT_PROJECT_DIR", None)
    env.pop("GAMEPILOT_WORKSPACE_DIR", None)
    workspace_path = tmp_path / "脚本🐉"
    requests = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "workspace.add",
            "params": {"dir": str(workspace_path), "name": "测试🐉"},
        },
        {"jsonrpc": "2.0", "id": 2, "method": "missing.method", "params": {}},
        {"jsonrpc": "2.0", "id": 3, "method": "engine.ping", "params": {}},
    ]
    wire = "".join(json.dumps(request, ensure_ascii=False) + "\n" for request in requests).encode("utf-8")
    result = subprocess.run(
        [sys.executable, "-c", launcher],
        input=wire,
        capture_output=True,
        cwd=tmp_path,
        env=env,
        timeout=20,
        check=False,
    )

    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    frames = [json.loads(line) for line in result.stdout.decode("utf-8").splitlines()]
    assert frames[0]["method"] == "engine.ready"
    responses = {frame["id"]: frame for frame in frames if "id" in frame}
    assert responses[1]["result"]["name"] == "测试🐉"
    assert Path(responses[1]["result"]["root"]) == workspace_path
    assert responses[2]["error"]["message"] == "未知方法: missing.method"
    assert responses[3]["result"]["pong"] is True
    assert "引擎启动" in result.stderr.decode("utf-8")
