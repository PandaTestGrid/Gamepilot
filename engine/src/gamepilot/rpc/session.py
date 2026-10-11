"""会话相关 RPC：连接设备、状态图读写、录制、运行控制。

设计：`SessionManager` 持有所有会话（每台设备一个），RPC handler 只做参数校验与转发。
通知（`engine.frame` / `engine.event`）由 Session 的截图线程直接推给前端。
"""

from __future__ import annotations

import base64
import logging
import os
import re
import sys
import threading
import time
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, urlparse

import cv2

from .. import library
from ..core.frame import Frame
from ..core.geometry import Rect
from ..core.graph import Graph
from ..devices.base import Controller, controller_for_scheme
from ..devices.mock import MOCK_DEVICE_ID
from ..project import Project, resolve_project
from ..protocol import (
    METHOD_ACTION_RUN,
    METHOD_BREAKPOINT,
    METHOD_DEVICE_CONNECT,
    METHOD_DEVICE_DISCONNECT,
    METHOD_DEVICE_KEY,
    METHOD_DEVICE_STATUS,
    METHOD_DEVICE_STREAM,
    METHOD_DEVICE_SWIPE,
    METHOD_DEVICE_TAP,
    METHOD_DEVICE_TOUCH,
    METHOD_GRAPH_EDGE_ADD,
    METHOD_GRAPH_GET,
    METHOD_GRAPH_NODE_ADD,
    METHOD_GRAPH_NODE_REMOVE,
    METHOD_GRAPH_NODE_UPDATE,
    METHOD_GRAPH_SAVE,
    METHOD_MAC_WINDOWS,
    METHOD_RECOGNIZER_REMOVE,
    METHOD_RECOGNIZER_RENAME,
    METHOD_RECOGNIZER_THRESHOLD,
    METHOD_RECORD_ACTION,
    METHOD_RECORD_TEMPLATE,
    METHOD_RUN_RESUME,
    METHOD_RUN_START,
    METHOD_RUN_STOP,
    METHOD_TEMPLATE_IMAGE,
    METHOD_TIMELINE,
    METHOD_VARIABLE_SET,
    NOTIFY_DEVICE_CONNECTED,
    NOTIFY_DEVICE_CONNECTING,
    NOTIFY_DEVICE_DISCONNECTED,
    NOTIFY_DEVICE_FAILED,
    NOTIFY_PROJECT_CHANGED,
)
from ..session import DeviceSession

if TYPE_CHECKING:  # 避免循环导入
    from .stdio import RpcServer

logger = logging.getLogger("gamepilot.rpc.session")
_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]*$")


def _coerce(value: str) -> Any:
    if value.lower() in ("true", "false"):
        return value.lower() == "true"
    for cast in (int, float):
        try:
            return cast(value)
        except ValueError:
            continue
    return value


def _require_float(params: dict[str, Any], key: str) -> float:
    value = params.get(key)
    if not isinstance(value, (int, float)):
        raise ValueError(f"缺少 {key} 参数（需要数字）")
    return float(value)


def _require_str(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"缺少参数 {key}")
    return value


def device_id_for(scheme: str, options: dict[str, Any]) -> str:
    """会话 id：`<类型>:<唯一键>`。

    坑：原来只认 URI 里的 `serial`，而 iOS 用 `udid`、macOS 窗口用 `window`
    → 全落到 `ios:default` / `mac:default`，**两台 iPhone（或两个 Mac 窗口）会互相顶掉**。
    这里按设备类型取各自的唯一键。
    """
    kind = scheme.lower()
    if kind == "mock":
        return MOCK_DEVICE_ID
    for key in ("serial", "udid", "window", "hwnd", "pid", "app"):
        value = options.get(key)
        if value:
            return f"{kind}:{value}"
    return f"{kind}:default"


def _create_controller(scheme: str, device_id: str, options: dict[str, Any]) -> Controller:
    cls = controller_for_scheme(scheme)
    if cls is None:
        raise ValueError(f"暂不支持该设备类型: {scheme}（当前支持 Android / iOS / Mock）")
    return cls(device_id=device_id, **options)


def parse_device_uri(uri: str) -> tuple[str, dict[str, Any]]:
    """解析设备 URI：`Android:///?serial=xxx`、`Mock:///?width=640&height=360`。

    两个坑都在这里解决：
    1. 别用 netloc/path 取 scheme —— `Android:///?serial=x` 的 netloc 是空、path 是 "/"；
    2. `serial` 必须保持字符串 —— 像 `serial=3387980` 这种"看起来像数字"的序列号一旦被
       转成 int，就会以 int 进入 subprocess 的 argv 抛 TypeError，表现为截图静默回退到
       慢路径（实测慢 3 倍，排查了一整轮）。
    """
    parsed = urlparse(uri)
    raw = parsed.scheme or parsed.netloc or parsed.path.strip("/")
    scheme = raw.lower()
    # 校验成标准的 URI scheme，避免 `://` 这类垃圾输入被当成设备类型往下传
    if not _SCHEME_RE.match(scheme):
        raise ValueError(f"无法解析设备 URI: {uri!r}")
    options = {key: _coerce(values[-1]) for key, values in parse_qs(parsed.query).items()}
    if "serial" in options:
        options["serial"] = str(options["serial"])
    return scheme, options


class SessionManager:
    def __init__(self, emit: Any) -> None:
        self.emit = emit
        self.project = resolve_project()
        self.sessions: dict[str, DeviceSession] = {}
        # 每台设备一把连接锁：并发/重试的 connect 只会有一次真正建会话，
        # 否则前端一个重试循环能叠加出几十个 scrcpy 会话
        self._connect_locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    # ---------- 连接 ----------

    # ------------------------------------------------------------------ #
    # 工程（脚本目录）与素材
    # ------------------------------------------------------------------ #

    def project_info(self) -> dict[str, Any]:
        """当前脚本目录的内容概览（界面顶栏显示、切换后回显）。"""
        project = self.project
        graph = Graph.load(project.graph_path) if os.path.isfile(project.graph_path) else Graph.empty(project.root)
        templates = (
            sorted(name for name in os.listdir(project.templates_dir)) if os.path.isdir(project.templates_dir) else []
        )
        return {
            "root": project.root,
            "graphPath": project.graph_path,
            "nodes": len(graph.nodes),
            "edges": len(graph.edges),
            "recognizers": len(graph.recognizers),
            "templates": len(templates),
        }

    def _resolve_script(self, name: str) -> str:
        """脚本名 → 目录：先按名字找同级脚本目录，找不到就当成路径。"""
        candidate = os.path.join(os.path.dirname(self.project.root), name)
        if os.path.isdir(candidate):
            return candidate
        return name

    def use_project(self, target: str) -> None:
        """切换脚本目录：重载所有已连接设备的状态图（保留它们的运行态）。"""
        path = os.path.abspath(os.path.expanduser(target))
        self.project = Project(root=path).ensure()
        logger.info("切换脚本目录: %s", self.project.root)
        for session in list(self.sessions.values()):
            session.project = self.project
            session.reload_graph()
        self.emit(NOTIFY_PROJECT_CHANGED, self.project_info())

    def list_projects(self, base: str | None = None) -> list[dict[str, Any]]:
        """列出库根下所有脚本目录（含 `graph.json` 的）；实现在 `library`。

        `project.*` 的库操作在 `rpc/projects.py`，这里只保留"当前脚本"的解析。
        """
        root = os.path.abspath(os.path.expanduser(base)) if base else library.library_root(self.project.root)
        return library.list_scripts(root)

    def template_image(self, label: str, *, grayscale: bool = False) -> dict[str, Any]:
        """取模板截图（PNG，base64）。黑白模式返回灰度图，方便界面直接看匹配用的样子。"""
        graph = Graph.load(self.project.graph_path) if os.path.isfile(self.project.graph_path) else None
        spec = graph.specs.get(label) if graph is not None else None
        if spec is None:
            raise ValueError(f"没有这个识别器: {label}")
        template = spec.get("template")
        if not isinstance(template, str):
            # 颜色识别器没有模板图，返回它的目标色
            return {"label": label, "mode": str(spec.get("mode", spec.get("type", "color"))), "png": "", "colors": spec}
        path = template if os.path.isabs(template) else os.path.join(self.project.root, template)
        image = cv2.imread(path, cv2.IMREAD_GRAYSCALE if grayscale else cv2.IMREAD_COLOR)
        if image is None:
            raise FileNotFoundError(f"模板文件不存在: {path}")
        ok, buffer = cv2.imencode(".png", image)
        if not ok:
            raise RuntimeError("模板编码失败")
        height, width = image.shape[:2]
        return {
            "label": label,
            "mode": "template",
            "width": int(width),
            "height": int(height),
            "png": base64.b64encode(buffer.tobytes()).decode("ascii"),
            "spec": {key: value for key, value in spec.items() if key != "template"},
        }

    def connect(self, uri: str) -> DeviceSession:
        scheme, options = parse_device_uri(uri)
        device_id = device_id_for(scheme, options)
        with self._locks_guard:
            lock = self._connect_locks.setdefault(device_id, threading.Lock())
        with lock:
            return self._connect_locked(device_id, uri, scheme, options)

    def _connect_locked(self, device_id: str, uri: str, scheme: str, options: dict[str, Any]) -> DeviceSession:
        existing = self.sessions.get(device_id)
        if existing is not None and existing.started:
            return existing

        self.emit(NOTIFY_DEVICE_CONNECTING, {"deviceId": device_id, "uri": uri, "phase": "adb 连接中…"})
        controller = _create_controller(scheme, device_id, options)
        try:
            controller.connect()
            self.emit(NOTIFY_DEVICE_CONNECTING, {"deviceId": device_id, "uri": uri, "phase": "读取分辨率…"})
            resolution = list(controller.resolution)
        except Exception as exc:
            self.emit(NOTIFY_DEVICE_FAILED, {"deviceId": device_id, "uri": uri, "error": str(exc)})
            raise

        session = DeviceSession(device_id, controller, self.project, self.emit)
        # 「运行子脚本」：切到指定脚本目录（名字可以是目录名或绝对路径）
        session.on_call_script = lambda name: self.use_project(self._resolve_script(name))
        session.start()
        self.sessions[device_id] = session
        self.emit(
            NOTIFY_DEVICE_CONNECTED,
            {
                "deviceId": device_id,
                "uri": uri,
                "resolution": resolution,
                "channel": getattr(controller, "channel", "unknown"),
                "linkNote": getattr(controller, "link_note", ""),
                # 人类可读的名字（iOS 的"wisdom (iOS 26.6.2)"、macOS 的窗口标题），
                # 界面用它显示设备条目，而不是显示 ios:00008120-…
                "name": controller.display_name,
                "graph": session.graph.to_dict(),
            },
        )
        return session

    def disconnect(self, device_id: str) -> None:
        session = self.sessions.pop(device_id, None)
        if session is None:
            return
        session.stop()
        self.emit(NOTIFY_DEVICE_DISCONNECTED, {"deviceId": device_id})

    def get(self, device_id: str) -> DeviceSession:
        session = self.sessions.get(device_id)
        if session is None:
            raise ValueError(f"设备未连接: {device_id}")
        return session

    def stop_all(self) -> None:
        for device_id in list(self.sessions):
            self.disconnect(device_id)


def register(server: RpcServer) -> SessionManager:
    manager = SessionManager(server.notify)

    @server.method(METHOD_TEMPLATE_IMAGE)
    def _template_image(params: dict[str, Any]) -> dict[str, Any]:
        """取识别器用的模板截图（界面里显示"我录的是什么"）。"""
        label = _require_str(params, "label")
        grayscale = bool(params.get("grayscale", False))
        return manager.template_image(label, grayscale=grayscale)

    @server.method(METHOD_MAC_WINDOWS)
    def _mac_windows(params: dict[str, Any]) -> dict[str, Any]:
        """列出 macOS 上可以当设备用的窗口（界面上的选择器用它，也可手输句柄）。"""
        from ..devices import macos

        if not macos.available():
            return {"platform": sys.platform, "allowed": False, "windows": []}
        return {
            "platform": sys.platform,
            "allowed": macos.screen_capture_allowed(),
            "windows": [item.to_dict() for item in macos.list_windows()],
        }

    @server.method(METHOD_DEVICE_CONNECT)
    def _connect(params: dict[str, Any]) -> dict[str, Any]:
        uri = _require_str(params, "uri")
        session = manager.connect(uri)
        # 等首帧（最多 3s）：前端拿到响应时画面里就有内容，体验上"点了就连上"
        first = session.index
        waited = 0.0
        while session.index <= first and waited < 3.0:
            time.sleep(0.05)
            waited += 0.05
        return {
            "deviceId": session.device_id,
            "resolution": list(session.controller.resolution),
            "channel": getattr(session.controller, "channel", "unknown"),
            # 界面用它显示设备条目（iOS 显示"wisdom (iOS 26.6.2)"、macOS 显示窗口标题）
            "name": session.controller.display_name,
            "kind": getattr(session.controller, "kind", None),
            "linkNote": getattr(session.controller, "link_note", ""),
            "graph": session.graph.to_dict(),
        }

    @server.method(METHOD_ACTION_RUN)
    def _action_run(params: dict[str, Any]) -> dict[str, Any]:
        """单独执行一个动作（界面上的"立即执行这一步"）。"""
        session = manager.get(_require_str(params, "deviceId"))
        action = params.get("action")
        if not isinstance(action, dict):
            raise ValueError("缺少 action 参数（对象，含 type 等）")
        if not session.running:
            # 没在跑状态机时也要能用：手动触发一次识别，动作里的识别器目标才解析得出来
            image = session.controller.screenshot()
            session.engine.perceive(Frame(image=image, size=session.controller.resolution, index=session.index))
        described = session.engine.run_action(action)
        return {"ok": True, "described": described}

    @server.method(METHOD_DEVICE_DISCONNECT)
    def _disconnect(params: dict[str, Any]) -> dict[str, Any]:
        manager.disconnect(_require_str(params, "deviceId"))
        return {"ok": True}

    @server.method(METHOD_DEVICE_STATUS)
    def _status(params: dict[str, Any]) -> dict[str, Any]:
        return manager.get(_require_str(params, "deviceId")).status()

    @server.method(METHOD_DEVICE_TOUCH)
    def _touch(params: dict[str, Any]) -> dict[str, Any]:
        """实时触控：phase=down/move/up，坐标归一化。画面栏拖动就是靠它。"""
        session = manager.get(_require_str(params, "deviceId"))
        session.touch(_require_str(params, "phase"), _require_float(params, "x"), _require_float(params, "y"))
        return {"ok": True}

    @server.method(METHOD_DEVICE_TAP)
    def _tap(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        session.tap(_require_float(params, "x"), _require_float(params, "y"))
        return {"ok": True}

    @server.method(METHOD_DEVICE_SWIPE)
    def _swipe(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        duration = params.get("durationMs", 300)
        if not isinstance(duration, (int, float)):
            raise ValueError("durationMs 必须是数字")
        session.swipe(
            _require_float(params, "x1"),
            _require_float(params, "y1"),
            _require_float(params, "x2"),
            _require_float(params, "y2"),
            max(0.02, float(duration) / 1000.0),
        )
        return {"ok": True}

    @server.method(METHOD_DEVICE_KEY)
    def _key(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        session.press(_require_str(params, "key"))
        return {"ok": True}

    @server.method(METHOD_DEVICE_STREAM)
    def _stream(params: dict[str, Any]) -> dict[str, Any]:
        """界面告知引擎"这台设备我只看 N fps"（0 = 先别推帧）。

        识别与状态机不受影响：引擎照常按会话帧率截图、识别、跑状态机，
        只是不再编码 JPEG 推给界面 —— 多设备同时开时这是最大的一笔开销。
        """
        session = manager.get(_require_str(params, "deviceId"))
        fps = params.get("fps", 15.0)
        if not isinstance(fps, (int, float)):
            raise ValueError("fps 必须是数字（0 表示暂停推帧）")
        session.set_stream_fps(float(fps))
        return {"ok": True, "streamFps": session.stream_fps}

    @server.method(METHOD_RECORD_ACTION)
    def _record_action(params: dict[str, Any]) -> dict[str, Any]:
        """把手动操作录成脚本里的一步（画面栏开着「录操作」时调它）。"""
        session = manager.get(_require_str(params, "deviceId"))
        action = params.get("action")
        if not isinstance(action, dict):
            raise ValueError("缺少 action 参数（对象，含 type 等）")
        to = params.get("to")
        return session.record_action(action, to=str(to) if to else None)

    @server.method(METHOD_GRAPH_NODE_ADD)
    def _node_add(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        enter = params.get("enter")
        return session.graph_node_add(
            str(params["nodeId"]) if params.get("nodeId") else None,
            str(params["name"]) if params.get("name") else None,
            [str(item) for item in enter] if isinstance(enter, list) else None,
        )

    @server.method(METHOD_GRAPH_NODE_UPDATE)
    def _node_update(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        patch = params.get("patch")
        if not isinstance(patch, dict):
            raise ValueError("缺少 patch 参数")
        return session.graph_node_update(_require_str(params, "nodeId"), patch)

    @server.method(METHOD_GRAPH_NODE_REMOVE)
    def _node_remove(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        return session.graph_node_remove(_require_str(params, "nodeId"))

    @server.method(METHOD_GRAPH_EDGE_ADD)
    def _edge_add(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        action = params.get("action")
        return session.graph_edge_add(
            src=str(params["from"]) if params.get("from") else None,
            dst=str(params["to"]) if params.get("to") else None,
            when=str(params["when"]) if params.get("when") else None,
            action=action if isinstance(action, dict) else None,
            condition=params.get("condition") if isinstance(params.get("condition"), dict) else None,
        )

    @server.method(METHOD_VARIABLE_SET)
    def _variable_set(params: dict[str, Any]) -> dict[str, Any]:
        """改运行期变量值（黑板面板上直接试参数用；不写回脚本）。"""
        session = manager.get(_require_str(params, "deviceId"))
        name = _require_str(params, "name")
        value = params.get("value")
        session.engine.variables.set(name, value if isinstance(value, (int, float, str, bool)) else str(value))
        return {"name": name, "value": session.engine.variables.get(name)}

    @server.method(METHOD_RECOGNIZER_REMOVE)
    def _recognizer_remove(params: dict[str, Any]) -> dict[str, Any]:
        result: dict[str, Any] = manager.get(_require_str(params, "deviceId")).remove_recognizer(
            _require_str(params, "label")
        )
        return result

    @server.method(METHOD_RECOGNIZER_RENAME)
    def _recognizer_rename(params: dict[str, Any]) -> dict[str, Any]:
        """识别器改名：`{deviceId, label, to}` → `{from, to, refs, graph}`。

        引用会一起改（节点进入条件 / 边条件 / 动作目标 / 动作里的 $score），
        所以改名不像删除那样需要考虑"被引用"。
        """
        result: dict[str, Any] = manager.get(_require_str(params, "deviceId")).rename_recognizer(
            _require_str(params, "label"), _require_str(params, "to")
        )
        return result

    @server.method(METHOD_GRAPH_GET)
    def _graph_get(params: dict[str, Any]) -> dict[str, Any]:
        return manager.get(_require_str(params, "deviceId")).graph.to_dict()

    @server.method(METHOD_GRAPH_SAVE)
    def _graph_save(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        payload = params.get("graph")
        if not isinstance(payload, dict):
            raise ValueError("缺少 graph 参数")
        return session.save_graph(payload)

    @server.method(METHOD_RECORD_TEMPLATE)
    def _record_template(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        rect = Rect.parse(params["rect"]) if "rect" in params else None
        if rect is None:
            raise ValueError("缺少 rect 参数（归一化 [x, y, w, h]）")
        return session.record_template(
            rect=rect,
            label=_require_str(params, "label"),
            threshold=float(params.get("threshold", 0.82)),
            as_enter=bool(params.get("asEnter", True)),
            as_action_target=bool(params.get("asActionTarget", True)),
            node_id=params.get("nodeId") if isinstance(params.get("nodeId"), str) else None,
            node_name=params.get("nodeName") if isinstance(params.get("nodeName"), str) else None,
        )

    @server.method(METHOD_RECOGNIZER_THRESHOLD)
    def _threshold(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        return session.set_threshold(_require_str(params, "label"), float(params.get("threshold", 0.82)))

    @server.method(METHOD_RUN_START)
    def _run_start(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        session.start_run()
        return {"ok": True, "running": True}

    @server.method(METHOD_RUN_RESUME)
    def _run_resume(params: dict[str, Any]) -> dict[str, Any]:
        """断点暂停后继续跑。"""
        session = manager.get(_require_str(params, "deviceId"))
        session.engine.resume()
        session.emit("run.resumed", {"deviceId": session.device_id})
        return {"ok": True, "paused": session.engine.paused}

    @server.method(METHOD_BREAKPOINT)
    def _breakpoint(params: dict[str, Any]) -> dict[str, Any]:
        """给一条边设/清断点（调试用：走到这里暂停）。"""
        session = manager.get(_require_str(params, "deviceId"))
        edge_id = _require_str(params, "edgeId")
        enabled = bool(params.get("enabled", True))
        if enabled:
            session.engine.breakpoints.add(edge_id)
        else:
            session.engine.breakpoints.discard(edge_id)
        return {"edgeId": edge_id, "enabled": enabled, "breakpoints": sorted(session.engine.breakpoints)}

    @server.method(METHOD_RUN_STOP)
    def _run_stop(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        session.stop_run()
        return {"ok": True, "running": False}

    @server.method(METHOD_TIMELINE)
    def _timeline(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        return session.timeline(int(params.get("limit", 60)))

    return manager


__all__ = ["SessionManager", "parse_device_uri", "register"]
