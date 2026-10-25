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
DEVICE_URI = "Synthetic:///?serial=test-1&width=640&height=360"
DEVICE_ID = "synthetic:test-1"


class EngineProcess:
    def __init__(self, project_dir: str, workspace_dir: str | None = None) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, "-m", MODULE],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            bufsize=1,
            env={
                **os.environ,
                "GAMEPILOT_LOG_LEVEL": "WARNING",
                "GAMEPILOT_PROJECT_DIR": project_dir,
                # 工作区也指到临时目录：project.* / script.* 一个字节都不碰仓库
                "GAMEPILOT_WORKSPACE_DIR": workspace_dir or os.path.join(project_dir, "workspaces", "默认"),
                "GAMEPILOT_CONFIG_DIR": os.path.join(project_dir, "config"),
                "GAMEPILOT_TEST_SYNTHETIC": "1",
            },
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


def test_disk_recording_rpc_exact_frames_and_disconnect_cleanup(engine: EngineProcess) -> None:
    engine.call("device.connect", {"uri": DEVICE_URI})
    params = {"deviceId": DEVICE_ID}
    started = engine.call("recording.start", params)
    recording_id = started["recordingId"]
    request = {**params, "recordingId": recording_id}
    assert started["active"] is True
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        meta = engine.call("recording.meta", {**request, "limit": 2})
        if meta["count"] >= 3:
            break
        time.sleep(0.1)
    assert meta["count"] >= 3
    assert len(meta["indices"]) == 2 and meta["hasMore"]
    next_page = engine.call("recording.meta", {**request, "afterIndex": meta["nextAfterIndex"], "limit": 2})
    assert next_page["indices"][0] > meta["indices"][-1]
    frame = engine.call("recording.frameAt", {**request, "index": meta["indices"][0]})
    assert frame["requestedIndex"] == frame["index"] == meta["indices"][0]
    assert frame["jpeg"]
    bad_id = engine.send("recording.frameAt", {**request, "index": -999})
    assert "error" in engine.wait_for(lambda message: message.get("id") == bad_id)
    stopped = engine.call("recording.stop", request)
    assert stopped["active"] is False and stopped["count"] >= meta["count"]
    assert engine.call("recording.frameAt", {**request, "index": meta["indices"][0]})["index"] == frame["index"]
    directory = engine.call("recording.meta", request)  # stopped recordings remain readable
    assert directory["count"] == stopped["count"]
    assert engine.call("recording.delete", request) == {"ok": True}
    missing = engine.send("recording.meta", request)
    assert "error" in engine.wait_for(lambda message: message.get("id") == missing)
    engine.call("device.disconnect", params)


def test_reconnect_with_different_uri_rebuilds_session(engine: EngineProcess) -> None:
    """同一个 deviceId 换 URI 再连（切前台/后台输入方式）必须重建会话，不能复用旧对象。"""
    first = engine.call("device.connect", {"uri": DEVICE_URI})
    device_id = first["deviceId"]
    before = sum(1 for message in engine.seen if message.get("method") == "device.connected")
    second = engine.call("device.connect", {"uri": f"{DEVICE_URI}&note=mode-switch"})
    after = sum(1 for message in engine.seen if message.get("method") == "device.connected")
    assert second["deviceId"] == device_id
    assert after == before + 1, "换了 URI 却没有重建会话（用户会看到切了模式却没生效）"
    engine.call("device.disconnect", {"deviceId": device_id})


def test_record_ocr_over_stdio(engine: EngineProcess, tmp_path: Path) -> None:
    """`record.ocr` 走完整 RPC：落一句"要认的字"，而不是裁一张模板图。"""
    engine.call("device.connect", {"uri": DEVICE_URI})
    engine.call("device.stream", {"deviceId": DEVICE_ID, "fps": 15})
    engine.wait_for(lambda message: message.get("method") == "engine.frame")

    recorded = engine.call(
        "record.ocr",
        {
            "deviceId": DEVICE_ID,
            "rect": [0.1, 0.1, 0.3, 0.1],
            "label": "金币",
            "text": "金币",
            "mode": "contains",
            "nodeId": "main",
            "nodeName": "主界面",
        },
    )
    assert recorded["mode"] == "ocr"
    spec = recorded["graph"]["recognizers"]["金币"]
    assert spec["type"] == "ocr"
    assert spec["text"] == "金币"
    assert os.path.exists(os.path.join(str(tmp_path), "templates", "金币.png"))
    # 界面的模板缩略图走 template.image：OCR 的证据截图也必须能从这条 RPC 取到，
    # 否则模块卡片只能显示一个「…」占位（曾经就是这样，用户看不出它在认什么）
    image = engine.call("template.image", {"label": "金币"})
    assert image["png"], "OCR 识别器的证据截图必须能取到"

    with pytest.raises(AssertionError, match="要识别的文字"):
        engine.call(
            "record.ocr",
            {"deviceId": DEVICE_ID, "rect": [0.1, 0.1, 0.3, 0.1], "label": "空", "text": " "},
        )


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
    # 默认设备（synthetic）没有 preferred_fps：循环上限仍是历史值 8fps
    assert status["fpsLimit"] == 8.0

    timeline = engine.call("timeline.get", {"deviceId": DEVICE_ID, "limit": 5})
    assert timeline["frames"] and timeline["events"]

    # 6) 停止与断开
    assert engine.call("run.stop", {"deviceId": DEVICE_ID})["running"] is False
    assert engine.call("device.disconnect", {"deviceId": DEVICE_ID})["ok"] is True


def test_connect_reports_unknown_scheme(engine: EngineProcess) -> None:
    # 用真正不存在的 scheme；`Windows://` 已经是合法设备类型（PC 窗口），不能再拿来当反例
    request_id = engine.send("device.connect", {"uri": "Lunar:///?foo=bar"})
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

    # 看树 / 列工作区：契约 v4 的返回形状
    # （工作区、配置目录都指到临时目录，仓库里的 workspaces/ 与用户真实配置都不受影响）
    tree = engine.call("workspace.tree")
    assert set(tree) == {"root", "workflows"}
    assert Path(tree["root"]).name == "默认", "树根就是当前工作区目录"
    assert tree["workflows"] == [], "这个临时工作区里还没有工作流"
    workspaces = engine.call("workspace.list")
    assert set(workspaces) == {"active", "recommended", "items"}
    assert workspaces["items"] == [{"name": "默认", "root": str(Path(tree["root"])), "active": True, "exists": False}]

    # 不存在的识别器要报错
    request_id = engine.send("template.image", {"label": "不存在"})
    error = engine.wait_for(lambda item: item.get("id") == request_id)
    assert "error" in error


def test_record_action_chains_into_next_node(engine: EngineProcess, tmp_path: Path) -> None:
    """录操作：点一下 → 变成脚本里的一步；录下一个界面时自动接上（A --点--> B）。"""
    engine.call("device.connect", {"uri": DEVICE_URI})

    # 脚本里一个界面都没有时录操作：自动用当前画面建一个界面（不能卡住用户）
    auto = engine.call("record.action", {"deviceId": DEVICE_ID, "action": {"type": "click", "x": 0.3, "y": 0.3}})
    auto_edge = next(edge for edge in auto["graph"]["edges"] if edge["id"] == auto["edgeId"])
    assert auto_edge.get("from"), "自动建的界面要挂上去，而不是造孤立步骤"
    auto_nodes = [node for node in auto["graph"]["nodes"] if node["id"] == auto_edge["from"]]
    assert auto_nodes and auto_nodes[0]["enter"], "自动界面要带一个识别器（画面中部模板）"
    assert any(
        item.get("method") == "engine.event" and item["params"]["type"] == "node_auto_created" for item in engine.seen
    ), "自动建界面要在事件栏留痕"

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


# ---------------------------------------------------------------- 设备 id


def test_device_id_uses_type_specific_keys() -> None:
    """会话 id 必须按设备类型取唯一键 —— 曾经 iOS/macOS 全都落到 xxx:default，
    两台 iPhone 或两个 Mac 窗口会互相顶掉。"""
    from gamepilot.rpc.session import device_id_for

    assert device_id_for("Android", {"serial": "3387980"}) == "android:3387980"
    assert device_id_for("iOS", {"udid": "00008120-000648403C78C01E"}) == "ios:00008120-000648403C78C01E"
    assert device_id_for("Mac", {"window": "89"}) == "mac:89"
    assert device_id_for("Mac", {"app": "访达"}) == "mac:访达"
    assert device_id_for("Synthetic", {"serial": "test-1"}) == "synthetic:test-1"
    assert device_id_for("Mac", {}) == "mac:default"  # 兜底仍可用
    # 两个不同窗口不能撞成同一个 id
    assert device_id_for("Mac", {"window": "89"}) != device_id_for("Mac", {"window": "90"})
    assert device_id_for("iOS", {"udid": "A"}) != device_id_for("iOS", {"udid": "B"})


def test_action_run_executes_one_step(engine: EngineProcess, tmp_path: Path) -> None:
    """ "单独跑这一步"：不启动状态机也能执行一个动作，并在事件栏留痕。"""
    engine.call("device.connect", {"uri": DEVICE_URI})
    result = engine.call("action.run", {"deviceId": DEVICE_ID, "action": {"type": "click", "x": 0.4, "y": 0.4}})
    assert result["ok"] is True
    assert "点击" in result["described"], result
    manual = [
        item
        for item in engine.seen
        if item.get("method") == "engine.event" and item["params"]["type"] == "action_manual"
    ]
    assert manual, "单独执行要在事件栏留痕"


def test_action_run_rejects_bad_action(engine: EngineProcess, tmp_path: Path) -> None:
    engine.call("device.connect", {"uri": DEVICE_URI})
    request_id = engine.send("action.run", {"deviceId": DEVICE_ID, "action": {"type": "click"}})
    error = engine.wait_for(lambda item: item.get("id") == request_id)
    assert "error" in error, error  # 点击必须给目标或坐标


def test_recognizer_search_switch_over_stdio(engine: EngineProcess, tmp_path: Path) -> None:
    """record.template 的 search 与 recognizer.search 走完整 RPC：落盘、热重载、非法值报错。"""
    engine.call("device.connect", {"uri": DEVICE_URI})
    engine.call("device.stream", {"deviceId": DEVICE_ID, "fps": 15})
    engine.wait_for(lambda message: message.get("method") == "engine.frame")

    recorded = engine.call(
        "record.template",
        {
            "deviceId": DEVICE_ID,
            "rect": [0.60, 0.30, 0.16, 0.12],
            "label": "logo",
            "threshold": 0.8,
            "nodeId": "main",
            "nodeName": "主界面",
            "search": "full",
        },
    )
    assert recorded["search"] == "full"
    assert recorded["graph"]["recognizers"]["logo"]["search"] == "full"

    region = engine.call("recognizer.search", {"deviceId": DEVICE_ID, "label": "logo", "search": "region"})
    assert region == {"label": "logo", "search": "region"}

    request_id = engine.send(
        "recognizer.search",
        {"deviceId": DEVICE_ID, "label": "logo", "search": "everywhere"},
    )
    error = engine.wait_for(lambda item: item.get("id") == request_id)
    assert "error" in error
    assert "搜索范围" in json.dumps(error, ensure_ascii=False)
