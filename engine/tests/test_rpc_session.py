"""端到端：不启动 GUI，只用真实 stdio JSON-RPC 走完整闭环。

覆盖第一版的用户路径：
    device.connect → engine.frame 通知 → record.template 落盘
    → graph.save → run.start → engine.event（动作真的点到了设备）
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

MODULE = "gamepilot.rpc"
DEVICE_URI = "Mock:///?width=640&height=360"
DEVICE_ID = "mock:mock-1"


class EngineProcess:
    def __init__(self, project_dir: str) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, "-m", MODULE],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            env={**os.environ, "GAMEPILOT_LOG_LEVEL": "WARNING", "GAMEPILOT_PROJECT_DIR": project_dir},
        )
        self.next_id = 0
        # 读过的所有消息：RPC 等待响应时会顺手消费掉通知，靠这个才能事后断言
        self.seen: list[dict[str, Any]] = []

    def send(self, method: str, params: dict[str, Any] | None = None) -> int:
        self.next_id += 1
        assert self.proc.stdin is not None
        payload = {"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}}
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        return self.next_id

    def read(self) -> dict[str, Any]:
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline()
        assert line, "引擎没有输出（进程可能退出了）"
        payload = json.loads(line)
        assert isinstance(payload, dict)
        return payload

    def wait_for(self, predicate: Callable[[dict[str, Any]], bool], timeout: float = 15.0) -> dict[str, Any]:
        deadline = time.time() + timeout
        seen: list[str] = []
        while time.time() < deadline:
            message = self.read()
            self.seen.append(message)
            seen.append(str(message.get("method") or message.get("id")))
            if predicate(message):
                return message
        raise AssertionError(f"等待超时，收到过: {seen[-12:]}")

    def call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 15.0) -> dict[str, Any]:
        request_id = self.send(method, params)
        response = self.wait_for(lambda message: message.get("id") == request_id, timeout=timeout)
        assert "error" not in response, response
        result = response["result"]
        assert isinstance(result, dict), f"result 必须是对象: {result!r}"
        return result

    def close(self) -> None:
        if self.proc.stdin is not None:
            with contextlib.suppress(Exception):
                self.proc.stdin.close()
        if self.proc.poll() is None:
            try:
                self.call("engine.shutdown")
            except Exception:
                self.proc.kill()
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait(timeout=5)
        if self.proc.stdout is not None:
            with contextlib.suppress(Exception):
                self.proc.stdout.close()


@pytest.fixture()
def engine(tmp_path: Path) -> Any:
    instance = EngineProcess(str(tmp_path))
    ready = instance.read()
    assert ready["method"] == "engine.ready"
    yield instance
    instance.close()


def test_full_loop_over_stdio(engine: EngineProcess, tmp_path: Path) -> None:
    # 1) 连接设备：响应里直接带回分辨率与（空）状态图
    result = engine.call("device.connect", {"uri": DEVICE_URI})
    assert result["deviceId"] == DEVICE_ID
    assert result["resolution"] == [640, 360]
    assert result["graph"]["nodes"] == []

    # 2) 界面告诉引擎要看多少帧，引擎才开始推（默认不推，免得灌满控制通道）
    streamed = engine.call("device.stream", {"deviceId": DEVICE_ID, "fps": 15})
    assert streamed == {"ok": True, "streamFps": 15.0}
    frame = engine.wait_for(lambda message: message.get("method") == "engine.frame")
    params = frame["params"]
    assert params["deviceId"] == DEVICE_ID
    assert params["resolution"] == [640, 360]
    assert params["jpeg"], "帧里必须有 base64 JPEG"

    # 3) 录制模板：从当前帧裁剪 → 落盘 → 注册识别器 → 建节点
    recorded = engine.call(
        "record.template",
        {
            "deviceId": DEVICE_ID,
            "rect": [0.60, 0.30, 0.16, 0.12],
            "label": "logo",
            "threshold": 0.8,
            "nodeId": "main",
            "nodeName": "主界面",
        },
    )
    assert recorded["mode"] == "template"
    assert os.path.exists(os.path.join(str(tmp_path), "templates", "logo.png"))
    assert "logo" in recorded["graph"]["recognizers"]

    # 4) 写一条边并运行：状态机应当自动点到 logo 上
    graph = recorded["graph"]
    graph["edges"] = [
        {
            "id": "e_tap",
            "from": "main",
            "when": "logo",
            "cooldown_ms": 150,
            "action": {"type": "click", "target": "logo"},
        }
    ]
    saved = engine.call("graph.save", {"deviceId": DEVICE_ID, "graph": graph})
    assert saved["edges"][0]["id"] == "e_tap"

    engine.call("run.start", {"deviceId": DEVICE_ID})
    entered = engine.wait_for(
        lambda message: message.get("method") == "engine.event" and message["params"]["type"] == "node_entered"
    )
    assert entered["params"]["node"] == "main"

    executed = engine.wait_for(
        lambda message: message.get("method") == "engine.event" and message["params"]["type"] == "action_executed"
    )
    assert "click" in executed["params"]["message"]

    # 5) 状态与时间轴都能查
    status = engine.call("device.status", {"deviceId": DEVICE_ID})
    assert status["running"] is True
    assert status["stats"]["actions"] >= 1

    timeline = engine.call("timeline.get", {"deviceId": DEVICE_ID, "limit": 5})
    assert timeline["frames"] and timeline["events"]

    # 6) 停止与断开
    assert engine.call("run.stop", {"deviceId": DEVICE_ID})["running"] is False
    assert engine.call("device.disconnect", {"deviceId": DEVICE_ID})["ok"] is True


def test_connect_reports_unknown_scheme(engine: EngineProcess) -> None:
    request_id = engine.send("device.connect", {"uri": "Windows:///?title_re=Game.*"})
    response = engine.wait_for(lambda message: message.get("id") == request_id)

    assert response["error"]["code"] == -32603
    assert "暂不支持该设备类型" in response["error"]["message"]


def test_graph_save_validates_references(engine: EngineProcess) -> None:
    engine.call("device.connect", {"uri": DEVICE_URI})
    request_id = engine.send(
        "graph.save",
        {
            "deviceId": DEVICE_ID,
            "graph": {"nodes": [{"id": "main", "enter": ["nope"]}], "edges": [], "recognizers": {}},
        },
    )
    response = engine.wait_for(lambda message: message.get("id") == request_id)

    assert response["error"]["code"] == -32603
    assert "未定义的识别器" in response["error"]["message"]


def test_operations_on_unknown_device_are_rejected(engine: EngineProcess) -> None:
    request_id = engine.send("device.status", {"deviceId": "nope"})
    response = engine.wait_for(lambda message: message.get("id") == request_id)

    assert "设备未连接" in response["error"]["message"]


def test_manual_control_tap_swipe_key(engine: EngineProcess, tmp_path: Path) -> None:
    """画面栏的手动控制：点击 / 滑动 / 功能键，并且要在事件栏留痕。"""
    engine.call("device.connect", {"uri": DEVICE_URI})

    assert engine.call("device.tap", {"deviceId": DEVICE_ID, "x": 0.25, "y": 0.75}) == {"ok": True}
    assert engine.call(
        "device.swipe",
        {"deviceId": DEVICE_ID, "x1": 0.8, "y1": 0.5, "x2": 0.2, "y2": 0.5, "durationMs": 250},
    ) == {"ok": True}
    assert engine.call("device.key", {"deviceId": DEVICE_ID, "key": "back"}) == {"ok": True}

    # 每次手动操作都要发一条 engine.event（事件栏显示"手动点击 …"）。
    # 注意：这些事件在 RPC 等待响应时就被读走了，所以查 engine.seen 而不是再等一次
    inputs = [item for item in engine.seen if item.get("method") == "engine.event"]
    assert [item["params"]["type"] for item in inputs] == ["manual_input"] * 3
    assert "手动点击" in inputs[0]["params"]["message"]
    assert "手动滑动" in inputs[1]["params"]["message"]
    assert "手动按键" in inputs[2]["params"]["message"]

    # 非法按键要报错，不能静默
    request_id = engine.send("device.key", {"deviceId": DEVICE_ID, "key": "不存在的键"})
    error = engine.wait_for(lambda item: item.get("id") == request_id)
    assert "error" in error
    assert "不支持的按键" in str(error["error"])


def test_realtime_touch_stream(engine: EngineProcess, tmp_path: Path) -> None:
    """实时滑动：down → 若干 move → up 逐个发，不是松手后合成一次滑动。"""
    engine.call("device.connect", {"uri": DEVICE_URI})

    assert engine.call("device.touch", {"deviceId": DEVICE_ID, "phase": "down", "x": 0.2, "y": 0.8}) == {"ok": True}
    for step in range(1, 6):
        assert engine.call(
            "device.touch",
            {"deviceId": DEVICE_ID, "phase": "move", "x": 0.2 + step * 0.1, "y": 0.8 - step * 0.1},
        ) == {"ok": True}
    assert engine.call("device.touch", {"deviceId": DEVICE_ID, "phase": "up", "x": 0.7, "y": 0.3}) == {"ok": True}

    # down / up 各留一条事件；中间的 move 不写事件（否则拖动一次刷上百条）
    inputs = [item for item in engine.seen if item.get("method") == "engine.event"]
    assert [item["params"]["type"] for item in inputs] == ["manual_input", "manual_input"]
    assert "手动触控" in inputs[0]["params"]["message"]
    assert "→" in inputs[1]["params"]["message"]

    # 非法 phase 要报错
    request_id = engine.send("device.touch", {"deviceId": DEVICE_ID, "phase": "fly", "x": 0.5, "y": 0.5})
    error = engine.wait_for(lambda item: item.get("id") == request_id)
    assert "error" in error


def test_project_directory_switch_and_template_image(engine: EngineProcess, tmp_path: Path) -> None:
    """脚本目录可以运行时切换；模板截图能取回来给界面显示。"""
    engine.call("device.connect", {"uri": DEVICE_URI})

    # 录一个模板 → 它会落到当前工程目录
    recorded = engine.call(
        "record.template",
        {
            "deviceId": DEVICE_ID,
            "rect": [0.60, 0.30, 0.16, 0.12],
            "label": "logo",
            "threshold": 0.8,
            "nodeId": "main",
            "nodeName": "主界面",
        },
    )
    assert recorded["mode"] == "template"

    # 模板截图（彩色 + 黑白）都能取到，尺寸和录的时候一致
    color = engine.call("template.image", {"label": "logo"})
    assert color["width"] > 0 and color["height"] > 0
    assert color["png"], "应该有 base64 PNG"

    gray = engine.call("template.image", {"label": "logo", "grayscale": True})
    assert gray["png"] and gray["png"] != color["png"], "黑白版应该是另一张图"

    before = engine.call("project.get")
    assert before["recognizers"] == 1
    assert before["templates"] >= 1

    # 换一个脚本目录：图与模板都要跟着到新目录
    target = tmp_path / "my-script"
    switched = engine.call("project.set", {"dir": str(target)})
    assert switched["root"] == str(target)
    assert switched["nodes"] == 0 and switched["edges"] == 0, "新目录是空的"
    assert (target / "templates").is_dir()

    # 切回去：原来的工程内容还在
    back = engine.call("project.set", {"dir": before["root"]})
    assert back["recognizers"] == 1

    # 列目录：能看到这个工程
    listing = engine.call("project.list", {"base": str(Path(before["root"]).parent)})
    names = [item["name"] for item in listing["items"]]
    assert Path(before["root"]).name in names

    # 不存在的识别器要报错
    request_id = engine.send("template.image", {"label": "不存在"})
    error = engine.wait_for(lambda item: item.get("id") == request_id)
    assert "error" in error


def test_record_action_chains_into_next_node(engine: EngineProcess, tmp_path: Path) -> None:
    """录操作：点一下 → 变成脚本里的一步；录下一个界面时自动接上（A --点--> B）。"""
    engine.call("device.connect", {"uri": DEVICE_URI})

    # 还没有任何界面时录的一步：无条件（进节点就做）
    orphan = engine.call("record.action", {"deviceId": DEVICE_ID, "action": {"type": "wait", "seconds": 0.2}})
    orphan_edge = next(edge for edge in orphan["graph"]["edges"] if edge["id"] == orphan["edgeId"])
    assert orphan_edge["when"] == "always"
    assert orphan_edge["condition"] == {"always": True}, orphan_edge
    assert "from" not in orphan_edge, "还没有界面时录的步骤不属于任何界面"

    # 录第一个界面（模板 + 节点 main）
    engine.call(
        "record.template",
        {
            "deviceId": DEVICE_ID,
            "rect": [0.60, 0.30, 0.16, 0.12],
            "label": "home",
            "nodeId": "main",
            "nodeName": "首页",
        },
    )
    time.sleep(0.6)  # 等识别器确认（投票窗口）

    # 录一步"点击"：条件默认是当前界面的识别器，坐标原样保留
    step = engine.call("record.action", {"deviceId": DEVICE_ID, "action": {"type": "click", "x": 0.5, "y": 0.8}})
    edge_id = step["edgeId"]
    recorded = next(edge for edge in step["graph"]["edges"] if edge["id"] == edge_id)
    assert recorded["from"] == "main"
    assert recorded["when"] == "home"
    assert recorded.get("condition") is None, "默认条件（就是 when）不写进文件"
    assert recorded["action"] == {"type": "click", "x": 0.5, "y": 0.8, "duration_ms": 300}, recorded["action"]
    assert recorded.get("to") is None, "还没录下一个界面时不该有终点"

    # 录下一个界面 → 上一步自动指过来
    after = engine.call(
        "record.template",
        {
            "deviceId": DEVICE_ID,
            "rect": [0.10, 0.10, 0.20, 0.10],
            "label": "detail",
            "nodeId": "detail",
            "nodeName": "详情",
        },
    )
    linked = next(edge for edge in after["graph"]["edges"] if edge["id"] == edge_id)
    assert linked["to"] == "detail", f"录制的步骤应该接到新节点: {linked}"

    # 再录一步滑动：属于某个已录界面（不再是无条件）
    time.sleep(0.6)
    swipe = engine.call(
        "record.action",
        {
            "deviceId": DEVICE_ID,
            "action": {"type": "swipe", "x": 0.5, "y": 0.8, "to_x": 0.5, "to_y": 0.2, "duration_ms": 350},
        },
    )
    swipe_edge = next(edge for edge in swipe["graph"]["edges"] if edge["id"] == swipe["edgeId"])
    assert swipe_edge["action"] == {
        "type": "swipe",
        "x": 0.5,
        "y": 0.8,
        "to_x": 0.5,
        "to_y": 0.2,
        "duration_ms": 350,
    }, swipe_edge["action"]
    assert swipe_edge["from"], "应该挂在某个界面上"

    # 录制要在事件栏留痕
    recorded_events = [item for item in engine.seen if item.get("method") == "engine.event"]
    assert any(item["params"]["type"] == "action_recorded" for item in recorded_events)


def test_graph_editor_node_and_edge_rpcs(engine: EngineProcess, tmp_path: Path) -> None:
    """图编辑器：加节点、连边、改节点、删节点（引用的边一起删）。"""
    engine.call("device.connect", {"uri": DEVICE_URI})
    engine.call(
        "record.template",
        {
            "deviceId": DEVICE_ID,
            "rect": [0.60, 0.30, 0.16, 0.12],
            "label": "home",
            "nodeId": "main",
            "nodeName": "首页",
        },
    )

    added = engine.call("graph.node.add", {"deviceId": DEVICE_ID, "name": "结算页"})
    node_id = added["nodeId"]
    assert any(node["id"] == node_id for node in added["graph"]["nodes"])

    # 从界面拖一条线过来：默认条件是源节点的进入识别器
    edge = engine.call("graph.edge.add", {"deviceId": DEVICE_ID, "from": "main", "to": node_id})
    edge_id = edge["edgeId"]
    created = next(item for item in edge["graph"]["edges"] if item["id"] == edge_id)
    # 默认形态（等于 when）不写 condition 字段，读回来就是 all_of=[when]
    assert created.get("condition") is None and created["when"] == "home"
    assert created["from"] == "main" and created["to"] == node_id

    # 把识别器挂到新节点上
    updated = engine.call(
        "graph.node.update", {"deviceId": DEVICE_ID, "nodeId": node_id, "patch": {"enter": ["home"], "name": "结果页"}}
    )
    target = next(node for node in updated["graph"]["nodes"] if node["id"] == node_id)
    assert target["name"] == "结果页" and target["enter"] == ["home"]

    # 删节点：引用它的边一起删
    removed = engine.call("graph.node.remove", {"deviceId": DEVICE_ID, "nodeId": node_id})
    assert not any(node["id"] == node_id for node in removed["graph"]["nodes"])
    assert not any(item["from"] == node_id or item.get("to") == node_id for item in removed["graph"]["edges"])

    # 删不存在的节点要报错
    request_id = engine.send("graph.node.remove", {"deviceId": DEVICE_ID, "nodeId": "不存在"})
    error = engine.wait_for(lambda item: item.get("id") == request_id)
    assert "error" in error
