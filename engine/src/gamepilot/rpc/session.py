"""会话相关 RPC：连接设备、状态图读写、录制、运行控制。

设计：`SessionManager` 持有所有会话（每台设备一个），RPC handler 只做参数校验与转发。
通知（`engine.frame` / `engine.event`）由 Session 的截图线程直接推给前端。
"""

from __future__ import annotations

import base64
import logging
import os
import re
import threading
import time
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, urlparse

import cv2

from ..core.geometry import Rect
from ..core.graph import Graph
from ..devices.base import Controller, controller_for_scheme
from ..devices.mock import MOCK_DEVICE_ID
from ..project import Project, resolve_project
from ..protocol import (
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
    METHOD_PROJECT_GET,
    METHOD_PROJECT_LIST,
    METHOD_PROJECT_SET,
    METHOD_RECOGNIZER_THRESHOLD,
    METHOD_RECORD_ACTION,
    METHOD_RECORD_TEMPLATE,
    METHOD_RUN_START,
    METHOD_RUN_STOP,
    METHOD_TEMPLATE_IMAGE,
    METHOD_TIMELINE,
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
        """列出一个目录下所有"像工程"的子目录（含 graph.json 的）。"""
        root = os.path.abspath(os.path.expanduser(base)) if base else os.path.dirname(self.project.root)
        if not os.path.isdir(root):
            return []
        items: list[dict[str, Any]] = []
        for name in sorted(os.listdir(root)):
            child = os.path.join(root, name)
            if not os.path.isdir(child):
                continue
            graph_path = os.path.join(child, "graph.json")
            if not os.path.isfile(graph_path):
                continue
            graph = Graph.load(graph_path)
            items.append(
                {
                    "name": name,
                    "root": child,
                    "nodes": len(graph.nodes),
                    "edges": len(graph.edges),
                    "recognizers": len(graph.recognizers),
                }
            )
        return items

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
        serial = str(options.get("serial", "")) if options.get("serial") else ""
        device_id = MOCK_DEVICE_ID if scheme.lower() == "mock" else f"{scheme.lower()}:{serial or 'default'}"
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

    @server.method(METHOD_PROJECT_GET)
    def _project_get(params: dict[str, Any]) -> dict[str, Any]:
        return manager.project_info()

    @server.method(METHOD_PROJECT_SET)
    def _project_set(params: dict[str, Any]) -> dict[str, Any]:
        """切换脚本目录：新建目录、热重载所有已连接设备的状态图。"""
        target = _require_str(params, "dir")
        manager.use_project(target)
        return manager.project_info()

    @server.method(METHOD_PROJECT_LIST)
    def _project_list(params: dict[str, Any]) -> dict[str, Any]:
        base = params.get("base")
        return {"items": manager.list_projects(str(base) if base else None)}

    @server.method(METHOD_TEMPLATE_IMAGE)
    def _template_image(params: dict[str, Any]) -> dict[str, Any]:
        """取识别器用的模板截图（界面里显示"我录的是什么"）。"""
        label = _require_str(params, "label")
        grayscale = bool(params.get("grayscale", False))
        return manager.template_image(label, grayscale=grayscale)

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
            "linkNote": getattr(session.controller, "link_note", ""),
            "graph": session.graph.to_dict(),
        }

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
        )

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
