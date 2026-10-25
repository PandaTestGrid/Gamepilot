"""AI 编辑 RPC：补丁保留未提交字段，显式空值和示例全集仍然替换。"""

from __future__ import annotations

import io
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from gamepilot.core.geometry import Rect
from gamepilot.core.recognizer import YoloRecognizer
from gamepilot.devices.synthetic_test import SyntheticController
from gamepilot.project import Project
from gamepilot.rpc.stdio import RpcServer
from gamepilot.session import DeviceSession


@pytest.fixture()
def rpc(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[RpcServer, io.StringIO, DeviceSession]]:
    monkeypatch.setenv("GAMEPILOT_CONFIG_DIR", str(tmp_path / ".config"))
    monkeypatch.setenv("GAMEPILOT_WORKSPACE_DIR", str(tmp_path / ".workspaces"))
    monkeypatch.delenv("GAMEPILOT_PROJECT_DIR", raising=False)
    out = io.StringIO()
    server = RpcServer(io.StringIO(), out)
    server.sessions.use_project(str(tmp_path))
    session = DeviceSession(
        "synthetic:yolo-edit",
        SyntheticController(),
        Project(root=str(tmp_path)).ensure(),
        server.notify,
    )
    # 配置更新不需要采集/推理线程；固定帧只用于物化参考图。
    session.last_frame = np.zeros((16, 24, 3), dtype=np.uint8)
    server.sessions.sessions[session.device_id] = session
    yield server, out, session
    server.sessions.stop_all()


def _call(rpc: tuple[RpcServer, io.StringIO, DeviceSession], method: str, spec: dict[str, Any]) -> dict[str, Any]:
    server, out, session = rpc
    out.seek(0)
    out.truncate(0)
    server.handle_line(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": {"deviceId": session.device_id, "label": "monster", "spec": spec},
            }
        )
    )
    for line in out.getvalue().splitlines():
        response = json.loads(line)
        if response.get("id") == 1:
            assert "error" not in response, response
            result: dict[str, Any] = response["result"]
            return result
    raise AssertionError(f"没有收到 {method} 的响应: {out.getvalue()!r}")


@pytest.mark.parametrize(
    "patch",
    [
        {},
        {"classes": []},  # 当前 dialog 明确发送 []：不能恢复旧类别。
        {"classes": ["new enemy"], "roi": [0.2, 0.3, 0.4, 0.5], "max_age_frames": 11},
    ],
    ids=["omitted-fields", "explicit-clear-classes", "explicit-overrides"],
)
def test_yolo_update_preserves_omitted_fields_and_replaces_examples(
    rpc: tuple[RpcServer, io.StringIO, DeviceSession], tmp_path: Path, patch: dict[str, Any]
) -> None:
    original = {
        "type": "yolo",
        "classes": ["old enemy"],
        "roi": [0.1, 0.2, 0.5, 0.6],
        "max_age_frames": 7,
        "threshold": 0.3,
        "search": "region",
        "imgsz": 960,
        "examples": [
            {"rect": [0.1, 0.1, 0.2, 0.2], "label": "old one"},
            {"rect": [0.4, 0.4, 0.2, 0.2], "label": "old two"},
        ],
    }
    _call(rpc, "recognizer.create", original)
    assert (tmp_path / "templates" / "monster_ai1.png").is_file()
    submitted = {
        "type": "yolo",
        "threshold": 0.44,
        "search": "full",
        "examples": [{"rect": [0.3, 0.3, 0.1, 0.1], "label": "replacement"}],
        **patch,
    }
    result = _call(rpc, "recognizer.update", submitted)
    expected = {
        **original,
        **submitted,
        "examples": [{"template": "templates/monster_ai0.png", "rect": [0.3, 0.3, 0.1, 0.1], "label": "replacement"}],
    }
    session = rpc[2]
    assert result["graph"]["recognizers"]["monster"] == expected
    assert session.graph.specs["monster"] == expected
    with (tmp_path / "graph.json").open(encoding="utf-8") as handle:
        assert json.load(handle)["recognizers"]["monster"] == expected
    # 热重载后的运行时对象也必须保留字段，而不只是 RPC 回包看起来正确。
    recognizer = session.graph.recognizers["monster"]
    assert isinstance(recognizer, YoloRecognizer)
    assert recognizer.classes == expected["classes"]
    assert recognizer.roi == Rect.parse(expected["roi"])
    assert recognizer.max_age_frames == expected["max_age_frames"]
    assert recognizer.threshold == 0.44
    assert (tmp_path / "templates" / "monster_ai0.png").is_file()
    assert not (tmp_path / "templates" / "monster_ai1.png").exists()
