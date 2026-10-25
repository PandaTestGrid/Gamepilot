"""会话相关 RPC：连接设备、状态图读写、录制、运行控制。

设计：`SessionManager` 持有所有会话（每台设备一个），RPC handler 只做参数校验与转发。
通知（`engine.frame` / `engine.event`）由 Session 的截图线程直接推给前端。
"""

from __future__ import annotations

import base64
import contextlib
import logging
import os
import re
import sys
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, urlparse

import cv2

from .. import workspace
from ..core import yolo_component
from ..core.flow_engine import FlowEngine
from ..core.frame import Frame
from ..core.geometry import Rect
from ..core.graph import GRAPH_WRITE_LOCK, Graph
from ..core.ocr import OCR_MANAGER
from ..core.recognizer import YoloRecognizer
from ..core.yolo import YOLO_MANAGER
from ..devices.base import Controller, controller_for_scheme
from ..devices.ios import KIND_IOS
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
    METHOD_EVIDENCE_IMAGE,
    METHOD_GRAPH_EDGE_ADD,
    METHOD_GRAPH_GET,
    METHOD_GRAPH_NODE_ADD,
    METHOD_GRAPH_NODE_REMOVE,
    METHOD_GRAPH_NODE_UPDATE,
    METHOD_GRAPH_SAVE,
    METHOD_MAC_WINDOWS,
    METHOD_OCR_CANCEL,
    METHOD_OCR_LOAD,
    METHOD_OCR_RECOGNIZE,
    METHOD_OCR_STATUS,
    METHOD_RECOGNIZER_CREATE,
    METHOD_RECOGNIZER_DETAIL,
    METHOD_RECOGNIZER_ENABLED,
    METHOD_RECOGNIZER_EXAMPLE,
    METHOD_RECOGNIZER_FRAME_AT,
    METHOD_RECOGNIZER_FRAME_META,
    METHOD_RECOGNIZER_FRAMES,
    METHOD_RECOGNIZER_PREVIEW,
    METHOD_RECOGNIZER_REMOVE,
    METHOD_RECOGNIZER_RENAME,
    METHOD_RECOGNIZER_SEARCH,
    METHOD_RECOGNIZER_THRESHOLD,
    METHOD_RECOGNIZER_UPDATE,
    METHOD_RECORD_ACTION,
    METHOD_RECORD_OCR,
    METHOD_RECORD_TEMPLATE,
    METHOD_RECORDING_DELETE,
    METHOD_RECORDING_FRAME_AT,
    METHOD_RECORDING_META,
    METHOD_RECORDING_START,
    METHOD_RECORDING_STOP,
    METHOD_RUN_EVIDENCE,
    METHOD_RUN_RESUME,
    METHOD_RUN_START,
    METHOD_RUN_STATUS,
    METHOD_RUN_STEP,
    METHOD_RUN_STOP,
    METHOD_TEMPLATE_IMAGE,
    METHOD_TIMELINE,
    METHOD_VARIABLE_SET,
    METHOD_WINDOW_LIST,
    METHOD_YOLO_ADD_MODEL,
    METHOD_YOLO_INSTALL,
    METHOD_YOLO_MODELS,
    METHOD_YOLO_REMOVE,
    METHOD_YOLO_SET_MODEL,
    METHOD_YOLO_STATUS,
    METHOD_YOLO_WARMUP,
    NOTIFY_DEVICE_CONNECTED,
    NOTIFY_DEVICE_CONNECTING,
    NOTIFY_DEVICE_DISCONNECTED,
    NOTIFY_DEVICE_FAILED,
    NOTIFY_OCR_PROGRESS,
    NOTIFY_OCR_RESULT,
    NOTIFY_PROJECT_CHANGED,
    NOTIFY_YOLO_PROGRESS,
)
from ..session import (
    DeviceSession,
    describe_graph_error,
    graph_edge_add,
    graph_node_add,
    graph_node_remove,
    graph_node_update,
    graph_recognizer_detail,
    graph_remove_recognizer,
    graph_rename_recognizer,
)
from ..session import (
    _load_graph as load_session_graph,
)

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


def _optional_str(params: dict[str, Any], key: str) -> str | None:
    value = params.get(key)
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def device_id_for(scheme: str, options: dict[str, Any]) -> str:
    """会话 id：`<类型>:<唯一键>`。

    坑：原来只认 URI 里的 `serial`，而 iOS 用 `udid`、macOS 窗口用 `window`
    → 全落到 `ios:default` / `mac:default`，**两台 iPhone（或两个 Mac 窗口）会互相顶掉**。
    这里按设备类型取各自的唯一键。
    """
    kind = scheme.lower()
    for key in ("serial", "udid", "window", "hwnd", "pid", "app"):
        value = options.get(key)
        if value:
            # 逻辑 display id 会随 MuMu 标签页重排；优先用物理 id 作稳定会话键。
            display = options.get("display")
            physical = options.get("physical") if kind == "android" else None
            screen = physical if physical not in (None, "", 0, "0") else display
            suffix = f":{screen}" if screen not in (None, "", 0, "0") else ""
            return f"{kind}:{value}{suffix}"
    return f"{kind}:default"


def _create_controller(
    scheme: str,
    device_id: str,
    options: dict[str, Any],
    *,
    sessions: dict[str, DeviceSession] | None = None,
) -> Controller:
    cls = controller_for_scheme(scheme)
    if cls is None:
        raise ValueError(f"暂不支持该设备类型: {scheme}（当前支持 Android / iOS / macOS 窗口 / Windows 窗口）")
    if _ios_slot_taken(device_id, sessions):
        # 引擎进程只能有一条用户态隧道（见 devices/ios.py）：第二台起换成子进程
        from ..devices.ios_worker import IosWorkerController

        cls = IosWorkerController
    return cls(device_id=device_id, **options)


def _ios_slot_taken(device_id: str, sessions: dict[str, DeviceSession] | None) -> bool:
    """进程内那条 iOS 隧道已经被别的 iPhone 占了？（只有 iOS 有这个限制）"""
    if sessions is None or not device_id.startswith(f"{KIND_IOS}:"):
        return False
    return any(
        key != device_id and key.startswith(f"{KIND_IOS}:") and session.started for key, session in sessions.items()
    )


def parse_device_uri(uri: str) -> tuple[str, dict[str, Any]]:
    """解析设备 URI。scheme 取自 scheme/netloc/path；serial 等标识参数保持字符串。"""
    parsed = urlparse(uri)
    raw = parsed.scheme or parsed.netloc or parsed.path.strip("/")
    scheme = raw.lower()
    # 校验成标准的 URI scheme，避免 `://` 这类垃圾输入被当成设备类型往下传
    if not _SCHEME_RE.match(scheme):
        raise ValueError(f"无法解析设备 URI: {uri!r}")
    query = {key: values[-1] for key, values in parse_qs(parsed.query).items()}
    options = {key: _coerce(value) for key, value in query.items()}
    # 标识类参数必须保持**原始字符串**，不能经过 `_coerce`：`0012` 会变成 12、`123456e789` 会被当成浮点，
    # 之后按 serial / udid 匹配设备就会找不到，或者匹配到别的设备。
    for key in ("serial", "udid"):
        if key in query:
            options[key] = query[key]
    # 窗口句柄统一成十进制字符串：界面列表给的是十进制，手输允许 `0x1A2B`。
    # 不归一化的话同一个窗口会出 `windows:6700` 与 `windows:0x1a2b` 两个会话（互相顶不掉）。
    if "hwnd" in query:
        raw_handle = query["hwnd"].strip()
        try:
            options["hwnd"] = str(int(raw_handle, 0))
        except ValueError:
            options["hwnd"] = raw_handle
    return scheme, options


class SessionManager:
    def __init__(self, emit: Any) -> None:
        self.emit = emit
        # 工作区列表 + 当前工作区（持久化在 config.json；GAMEPILOT_WORKSPACE_DIR 时只在进程内）
        self.workspaces = workspace.Workspaces()
        # "没有当前工作流"是一等状态（契约 §2.4）：不伪造路径，也不偷偷建目录
        self.project = Project()
        self.sessions: dict[str, DeviceSession] = {}
        # 每台设备一把连接锁：并发/重试的 connect 只会有一次真正建会话，
        # 否则前端一个重试循环能叠加出几十个 scrcpy 会话
        self._connect_locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._restore()

    def _restore(self) -> None:
        """启动恢复：`GAMEPILOT_PROJECT_DIR`（逃生口）优先，否则当前工作区里第一个工作流。

        **启动不建任何东西**（不建工作流、也不建目录）：没有就保持"什么都没选"（一等状态）。
        这里不发通知 —— 服务还没 serve，前端此时还没订阅。
        """
        override = os.environ.get("GAMEPILOT_PROJECT_DIR")
        if override:
            self.project = resolve_project()  # 逃生口：只对显式指定的目录 ensure()
            return
        try:
            first = workspace.first_workflow()
        except Exception as error:
            # 列工作流本身出问题（权限、盘掉了、路径非法…）也不能让引擎起不来：
            # 退回"什么都没选"这一等状态，用户自己去右栏挑。
            logger.error("恢复工作区失败，保持「什么都没选」: %s", error)
            self.project = Project()
            return
        self.project = Project(root=first).ensure() if first else Project()

    def project_info(self) -> dict[str, Any]:
        """当前工作流的内容概览（界面顶栏显示、切换后回显）。

        没有当前工作流时是空串 + 全 0（一等状态），**绝不伪造磁盘上不存在的路径**。
        """
        project = self.project
        if not project.root:
            return {"root": "", "graphPath": "", "nodes": 0, "edges": 0, "recognizers": 0, "templates": 0}
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

    def _resolve_workflow(self, name: str) -> str:
        """工作流名 → 目录：先按名字找同一个工作区里的工作流，找不到就当成路径。"""
        if not self.project.root:
            return name
        candidate = os.path.join(os.path.dirname(self.project.root), name)
        if os.path.isdir(candidate):
            return candidate
        return name

    def _call_workflow(self, session: DeviceSession, name: str, caller_root: str | None = None) -> None:
        """「调用/运行子工作流」：后台跑目标链，**跑完回到调用方继续**。

        - `session.project` 始终是调用方这份图：画布、选中节点、模板列表不跳；
        - 目标 runner 用 `start_run(workflow_root=target)` 单开；
        - 如果调用方是 FlowEngine，把它挂起（`wait_for_subflow`）并登记父子关系，
          子链结束由 `_complete_run` 恢复父链；状态机调用则保持原有“调用后继续自己的边”；
        - caller_root 必须从**正在 tick 的 runner** 取，不能取 `project.root`：
          调用不跳画布后，嵌套调用 B→C 时 project 仍是 A。
        """
        caller = session._root_key(caller_root or session.project.root)
        target = self._resolve_workflow(name)
        target_key = session._root_key(target)
        if caller and caller == target_key:
            raise ValueError(f"不能调用当前正在运行的工作流「{name}」")
        with session._lifecycle_lock:
            if session._root_busy(target_key):
                raise ValueError(f"目标工作流「{name}」已经在运行，不能重复调用")
            parent = session.runners.get(caller)
            if parent is None or parent.cancelled or session._stop.is_set():
                raise ValueError("当前没有正在运行的工作流，不能调用子工作流")
            if session._ticking_engine is not None and parent.engine is not session._ticking_engine:
                raise ValueError("调用方已停止，不能启动子工作流")
            session.start_run(workflow_root=target)
            target_runner = session.runners.get(target_key)
            if target_runner is None or not isinstance(target_runner.engine, FlowEngine):
                if target_runner is not None:
                    session.stop_run(workflow_root=target_key)
                raise ValueError(f"工作流「{name}」没有步骤链，不能用「调用工作流」运行")
            if isinstance(parent.engine, FlowEngine):
                parent.engine.wait_for_subflow(target_key)
                with session.lock:
                    session.subflow_parent[target_key] = caller

    def _require_project(self) -> Project:
        if not self.project.root:
            raise ValueError("还没有选择脚本（工作流）")
        return self.project

    def project_graph(self) -> Graph:
        """当前脚本的图（真源 = 项目目录里的 graph.json）。"""
        project = self._require_project()
        try:
            return load_session_graph(project)
        except ValueError as error:
            # 读不回来时把"哪份文件、为什么"说清楚，界面直接就能显示出来，
            # 而不是只丢一句 invalid 让人猜
            raise ValueError(describe_graph_error(project, error)) from error

    def current_workflow_is_running(self) -> bool:
        """当前打开的这份工作流是否有设备在跑（改图会热重载，丢掉步骤指针）。"""
        root = self.project.root
        if not root:
            return False
        return any(session._root_busy(root) for session in list(self.sessions.values()))

    def reject_edit_if_running(self) -> None:
        if self.current_workflow_is_running():
            raise ValueError("运行中不能修改流程图，请先停止")

    def save_project_graph(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.reject_edit_if_running()
        project = self._require_project()
        with GRAPH_WRITE_LOCK:
            # 现有文件读不回来时**拒绝覆盖**：界面此时看到的是空画布，
            # 直接存会把那份打不开的图换成空的 —— 坏数据也是用户的数据，
            # 宁可让他先备份/删除，也不要悄悄替他"清空"。
            existing_graph: Graph | None = None
            if os.path.exists(project.graph_path):
                try:
                    existing_graph = load_session_graph(project)
                except ValueError as error:
                    raise ValueError(
                        f"{describe_graph_error(project, error)}；"
                        "请先备份或删除这个工作流，或手动修好 graph.json 再编辑"
                    ) from error
            graph = Graph.from_dict(payload, base_dir=project.root, path=project.graph_path)
            graph.save()
        self.reload_graphs()
        return graph.to_dict()

    def mutate_project_graph(self, mutate: Any) -> dict[str, Any]:
        """改一下项目里的图并落盘，然后让所有会话热重载。"""
        self.reject_edit_if_running()
        graph = self.project_graph()
        result = mutate(graph)
        graph.save()
        self.reload_graphs()
        return dict(result)

    def reload_graphs(self) -> None:
        """让所有已连接设备重新读盘上的脚本（保留它们各自的当前节点与运行态）。"""
        for session in list(self.sessions.values()):
            session.reload_graph()

    def _set_project(self, project: Project) -> None:
        """真正切当前工作流：更新所有会话 + 广播 `project.changed`。

        正在跑的那份工作流执行器会保留（见 `DeviceSession.reload_graph`），
        切 Tab / 工作区只换界面当前这份图，不会把其它脚本停掉。
        """
        self.project = project
        logger.info("切换当前工作流: %s", project.root or "(无)")
        for session in list(self.sessions.values()):
            session.project = project
            try:
                session.reload_graph()
            except Exception as error:
                # reload_graph 自己已经吞了"读图失败"；这里是兜底 ——
                # 一台设备出意外不该让"切工作流"整体失败。
                logger.error("会话 %s 热重载失败: %s", session.device_id, error)
        self.emit(NOTIFY_PROJECT_CHANGED, self.project_info())

    def use_project(self, target: str, *, create: bool = True) -> None:
        """切换当前工作流目录：`create=False` 时要求工作流已存在（防止残留路径把已删目录建回来）。"""
        path = os.path.abspath(os.path.expanduser(target))
        if not create and not os.path.isfile(os.path.join(path, "graph.json")):
            raise ValueError(f"工作流目录不存在: {path}")
        self._set_project(Project(root=path).ensure())

    def switch_workspace(self, root: str | None) -> None:
        """切到某个工作区：当前工作流 = 它里面第一个工作流；没有就清空（不建任何东西）。"""
        first = workspace.first_workflow(root) if root else None
        self._set_project(Project(root=first).ensure() if first else Project())

    def reselect_workflow(self) -> None:
        """树变了以后重新选当前工作流：当前工作区里第一个，一个都没有就清空。"""
        self.switch_workspace(self.workspaces.active)

    def template_image(self, label: str, *, grayscale: bool = False) -> dict[str, Any]:
        """取模板截图（PNG，base64）。黑白模式返回灰度图，方便界面直接看匹配用的样子。"""
        if not self.project.root:
            raise ValueError("还没有选择工作流")
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
            # URI 里有输入参数（`post=global|sync|message`、`cursor=1`）：同一个窗口换了
            # 输入方式再连，必须重建会话；直接复用会让用户以为"切了后台但没生效"。
            same_link = not existing.source_uri or existing.source_uri == uri
            if existing.capture_error is None and same_link:
                return existing
            # 点击「重试」/切换输入方式：都必须真正重建，不能返回旧对象。
            self.disconnect(device_id)

        self.emit(NOTIFY_DEVICE_CONNECTING, {"deviceId": device_id, "uri": uri, "phase": "adb 连接中…"})
        controller = _create_controller(scheme, device_id, options, sessions=self.sessions)
        try:
            controller.connect()
            self.emit(NOTIFY_DEVICE_CONNECTING, {"deviceId": device_id, "uri": uri, "phase": "读取分辨率…"})
            resolution = list(controller.resolution)
        except Exception as exc:
            with contextlib.suppress(Exception):
                controller.close()
            self.emit(NOTIFY_DEVICE_FAILED, {"deviceId": device_id, "uri": uri, "error": str(exc)})
            raise

        # 抓图很快的设备（Windows WGC 约 3ms/帧）自带更高的循环帧率；其它设备用默认 8fps。
        preferred_fps = float(getattr(controller, "preferred_fps", 0.0) or 0.0)
        session = DeviceSession(
            device_id,
            controller,
            self.project,
            self.emit,
            fps=preferred_fps if preferred_fps > 0 else 8.0,
        )
        session.source_uri = uri
        # 「运行子工作流」（图上的 call 动作）：后台启动目标工作流，不切当前画布；
        # caller_root 用正在 tick 的 runner（嵌套调用时不能拿 project.root）
        session.on_call_script = lambda name: self._call_workflow(
            session, name, session._ticking_root or session.project.root
        )
        try:
            session.start()
            # 仅有视频头不代表有画面。等到真的抓到一帧才向前端报 connected；
            # ADB 回退可能耗时数秒，不能在它仍在截图时先报失败或假成功。
            deadline = time.monotonic() + 20.0
            while session.last_frame is None and session.capture_error is None and time.monotonic() < deadline:
                time.sleep(0.05)
            if session.last_frame is None:
                raise RuntimeError(
                    session.capture_error or "该窗口暂时没有画面；请确认 MuMu 标签页仍在，然后刷新后重试"
                )
        except Exception as exc:
            session.stop()
            self.emit(NOTIFY_DEVICE_FAILED, {"deviceId": device_id, "uri": uri, "error": str(exc)})
            raise
        self.sessions[device_id] = session
        self.emit(
            NOTIFY_DEVICE_CONNECTED,
            {
                "deviceId": device_id,
                "uri": uri,
                "resolution": resolution,
                "channel": getattr(controller, "channel", "unknown"),
                "capabilities": {
                    "multiTouch": getattr(controller, "max_touch_points", 0) > 1,
                    "maxTouchPoints": getattr(controller, "max_touch_points", 0),
                },
                "linkNote": getattr(controller, "link_note", ""),
                "kind": getattr(controller, "kind", None),
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

    @server.method(METHOD_WINDOW_LIST)
    def _window_list(params: dict[str, Any]) -> dict[str, Any]:
        """列出本机可以**绑定**的窗口（统一入口：Windows / macOS）。

        返回的每一项都自带 `uri`（`Windows:///?hwnd=…` / `Mac:///?window=…`）与 `deviceId`，
        界面点一下就能直接连接；`hwnd` / `handle` 同时给出来，手输句柄也行。
        """
        from ..devices import macos, windows

        include_own = bool(params.get("includeOwn", False))
        if sys.platform == "win32":
            return windows.window_list_payload(include_own=include_own)
        if sys.platform == "darwin":
            return macos.window_list_payload(include_own=include_own)
        return {
            "platform": sys.platform,
            "allowed": False,
            "note": "本机窗口自动化只在 Windows / macOS 上可用",
            "windows": [],
        }

    @server.method(METHOD_DEVICE_CONNECT)
    def _connect(params: dict[str, Any]) -> dict[str, Any]:
        uri = _require_str(params, "uri")
        session = manager.connect(uri)
        return {
            "deviceId": session.device_id,
            "resolution": list(session.controller.resolution),
            "channel": getattr(session.controller, "channel", "unknown"),
            "capabilities": {
                "multiTouch": session.controller.max_touch_points > 1,
                "maxTouchPoints": session.controller.max_touch_points,
            },
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
        described = session.run_action(action)
        return {"ok": True, "described": described}

    @server.method(METHOD_DEVICE_DISCONNECT)
    def _disconnect(params: dict[str, Any]) -> dict[str, Any]:
        manager.disconnect(_require_str(params, "deviceId"))
        return {"ok": True}

    @server.method(METHOD_DEVICE_STATUS)
    def _status(params: dict[str, Any]) -> dict[str, Any]:
        return manager.get(_require_str(params, "deviceId")).status()

    @server.method(METHOD_RUN_STATUS)
    def _run_status(params: dict[str, Any]) -> dict[str, Any]:
        """Authoritative lightweight run state; never wait for execution/lifecycle I/O."""
        session = manager.get(_require_str(params, "deviceId"))
        with session.lock:
            roots = [runner.root for runner in session.runners.values() if session._runner_busy(runner)]
            return {
                "deviceId": session.device_id,
                "workflowRoot": session._root_key(session.project.root),
                "runningWorkflowRoots": roots,
                "runRevision": session._run_revision,
                "running": bool(roots),
            }

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

    # AI dialog recordings use separate disk-backed storage, not the bounded recognizer preview history.
    @server.method(METHOD_RECORDING_START)
    def _recording_start(params: dict[str, Any]) -> dict[str, Any]:
        return manager.get(_require_str(params, "deviceId")).start_recording()

    @server.method(METHOD_RECORDING_STOP)
    def _recording_stop(params: dict[str, Any]) -> dict[str, Any]:
        return manager.get(_require_str(params, "deviceId")).stop_recording(_optional_str(params, "recordingId"))

    @server.method(METHOD_RECORDING_META)
    def _recording_meta(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        after_index = params.get("afterIndex", -1)
        limit = params.get("limit", 100)
        if isinstance(after_index, bool) or not isinstance(after_index, int):
            raise ValueError("afterIndex 必须是整数帧号")
        if isinstance(limit, bool) or not isinstance(limit, int):
            raise ValueError("limit 必须是整数")
        return session.recording_meta(_require_str(params, "recordingId"), after_index=after_index, limit=limit)

    @server.method(METHOD_RECORDING_FRAME_AT)
    def _recording_frame_at(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        index = params.get("index")
        if isinstance(index, bool) or not isinstance(index, int):
            raise ValueError("index 必须是整数帧号")
        return session.recording_frame_at(_require_str(params, "recordingId"), index)

    @server.method(METHOD_RECORDING_DELETE)
    def _recording_delete(params: dict[str, Any]) -> dict[str, Any]:
        manager.get(_require_str(params, "deviceId")).delete_recording(_require_str(params, "recordingId"))
        return {"ok": True}

    @server.method(METHOD_RECORD_ACTION)
    def _record_action(params: dict[str, Any]) -> dict[str, Any]:
        """把手动操作录成工作流里的一步（画面栏开着「录操作」时调它）。"""
        session = manager.get(_require_str(params, "deviceId"))
        action = params.get("action")
        if not isinstance(action, dict):
            raise ValueError("缺少 action 参数（对象，含 type 等）")
        to = params.get("to")
        return session.record_action(action, to=str(to) if to else None)

    # ---- 图编辑（legacy nodes/edges）：`flow.steps` 非空时会拒绝，见 session.reject_legacy_graph_edit ----

    def _graph_device(params: dict[str, Any]) -> str:
        """`deviceId`：有就用那台设备会话的图，没有就改项目里的 `graph.json`。"""
        device_id = params.get("deviceId")
        return device_id if isinstance(device_id, str) and device_id else ""

    @server.method(METHOD_GRAPH_NODE_ADD)
    def _node_add(params: dict[str, Any]) -> dict[str, Any]:
        enter = params.get("enter")
        args = (
            str(params["nodeId"]) if params.get("nodeId") else None,
            str(params["name"]) if params.get("name") else None,
            [str(item) for item in enter] if isinstance(enter, list) else None,
        )
        device_id = _graph_device(params)
        if device_id:
            return manager.get(device_id).graph_node_add(*args)
        return manager.mutate_project_graph(lambda graph: graph_node_add(graph, *args))

    @server.method(METHOD_GRAPH_NODE_UPDATE)
    def _node_update(params: dict[str, Any]) -> dict[str, Any]:
        patch = params.get("patch")
        if not isinstance(patch, dict):
            raise ValueError("缺少 patch 参数")
        node_id = _require_str(params, "nodeId")
        device_id = _graph_device(params)
        if device_id:
            return manager.get(device_id).graph_node_update(node_id, patch)
        return manager.mutate_project_graph(lambda graph: graph_node_update(graph, node_id, patch))

    @server.method(METHOD_GRAPH_NODE_REMOVE)
    def _node_remove(params: dict[str, Any]) -> dict[str, Any]:
        node_id = _require_str(params, "nodeId")
        device_id = _graph_device(params)
        if device_id:
            return manager.get(device_id).graph_node_remove(node_id)
        return manager.mutate_project_graph(lambda graph: graph_node_remove(graph, node_id))

    @server.method(METHOD_GRAPH_EDGE_ADD)
    def _edge_add(params: dict[str, Any]) -> dict[str, Any]:
        action = params.get("action")
        args: dict[str, Any] = {
            "src": str(params["from"]) if params.get("from") else None,
            "dst": str(params["to"]) if params.get("to") else None,
            "when": str(params["when"]) if params.get("when") else None,
            "action": action if isinstance(action, dict) else None,
            "condition": params.get("condition") if isinstance(params.get("condition"), dict) else None,
        }
        device_id = _graph_device(params)
        if device_id:
            return manager.get(device_id).graph_edge_add(**args)
        return manager.mutate_project_graph(lambda graph: graph_edge_add(graph, **args))

    @server.method(METHOD_VARIABLE_SET)
    def _variable_set(params: dict[str, Any]) -> dict[str, Any]:
        """改运行期变量值（黑板面板上直接试参数用；不写回工作流）。"""
        session = manager.get(_require_str(params, "deviceId"))
        name = _require_str(params, "name")
        value = params.get("value")
        with session.lock:
            session.engine.variables.set(name, value if isinstance(value, (int, float, str, bool)) else str(value))
            return {"name": name, "value": session.engine.variables.get(name)}

    @server.method(METHOD_RECOGNIZER_REMOVE)
    def _recognizer_remove(params: dict[str, Any]) -> dict[str, Any]:
        label = _require_str(params, "label")
        device_id = params.get("deviceId")
        if isinstance(device_id, str) and device_id and device_id in manager.sessions:
            result: dict[str, Any] = manager.get(device_id).remove_recognizer(label)
            return result
        project = manager._require_project()
        return manager.mutate_project_graph(
            lambda graph: graph_remove_recognizer(graph, label, project_root=project.root)
        )

    recognizer_edit_lock = threading.Lock()

    @server.method(METHOD_RECOGNIZER_RENAME)
    def _recognizer_rename(params: dict[str, Any]) -> dict[str, Any]:
        with recognizer_edit_lock:
            return _rename_recognizer(params)

    def _rename_recognizer(params: dict[str, Any]) -> dict[str, Any]:
        """识别器改名：`{deviceId, label, to}` → `{from, to, refs, graph}`。

        引用会一起改（节点进入条件 / 边条件 / 动作目标 / 动作里的 $score），
        所以改名不像删除那样需要考虑"被引用"。
        """
        old = _require_str(params, "label")
        to = _require_str(params, "to")
        device_id = params.get("deviceId")
        if isinstance(device_id, str) and device_id and device_id in manager.sessions:
            selected = manager.get(device_id)
            result: dict[str, Any] = selected.rename_recognizer(old, to)
            updated = Graph.from_dict(result["graph"], selected.project.root, path=selected.project.graph_path)
            from ..sessions.yolo import sync_recognizer_update

            for current in list(manager.sessions.values()):
                sync_recognizer_update(current, updated, old, result["to"])
            return result
        return manager.mutate_project_graph(lambda graph: graph_rename_recognizer(graph, old, to))

    @server.method(METHOD_GRAPH_GET)
    def _graph_get(params: dict[str, Any]) -> dict[str, Any]:
        """读当前脚本的图。

        `deviceId` **可选**：传了 = 那台设备会话里的那份（带它的运行态），
        不传 = 直接读项目里的 `graph.json` —— 没连设备也能看脚本（状态图属于项目，不属于设备）。

        **还没选脚本时给一张空图**（一等状态，不是错误）：界面刚起来还没选工作流是常态，
        这里报错只会在日志里刷红字，画布那边什么也拿不到。
        """
        device_id = params.get("deviceId")
        if isinstance(device_id, str) and device_id:
            return manager.get(device_id).graph.to_dict()
        if not manager.project.root:
            return Graph.empty("", path="").to_dict()
        return manager.project_graph().to_dict()

    @server.method(METHOD_GRAPH_SAVE)
    def _graph_save(params: dict[str, Any]) -> dict[str, Any]:
        payload = params.get("graph")
        if not isinstance(payload, dict):
            raise ValueError("缺少 graph 参数")
        device_id = params.get("deviceId")
        if isinstance(device_id, str) and device_id:
            return manager.get(device_id).save_graph(payload)
        # 项目级：落盘 + 让所有已连接会话热重载（连着的设备立刻拿到新脚本）
        return manager.save_project_graph(payload)

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
            # 「录一个新界面」：id 由引擎分配（界面传下来的 id 是本地序号，重启就重号，见 session.record_template）
            allocate_node_id=bool(params.get("allocateNodeId", False)),
            # 搜索范围：region（默认，只在框选区域找）/ full（整帧找，目标位置不固定时用）
            search=str(params.get("search", "region")),
        )

    @server.method(METHOD_RECORD_OCR)
    def _record_ocr(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        rect = Rect.parse(params["rect"]) if "rect" in params else None
        if rect is None:
            raise ValueError("缺少 rect 参数（归一化 [x, y, w, h]）")
        return session.record_ocr(
            rect=rect,
            label=_require_str(params, "label"),
            text=_require_str(params, "text"),
            mode=str(params.get("mode", "contains")),
            threshold=float(params.get("threshold", 0.6)),
            as_enter=bool(params.get("asEnter", True)),
            as_action_target=bool(params.get("asActionTarget", True)),
            node_id=params.get("nodeId") if isinstance(params.get("nodeId"), str) else None,
            node_name=params.get("nodeName") if isinstance(params.get("nodeName"), str) else None,
            allocate_node_id=bool(params.get("allocateNodeId", False)),
            search=str(params.get("search", "region")),
        )

    recognizer_enabled_lock = threading.Lock()

    @server.method(METHOD_RECOGNIZER_ENABLED)
    def _recognizer_enabled(params: dict[str, Any]) -> dict[str, Any]:
        with recognizer_enabled_lock:
            return _set_recognizer_enabled(params)

    def _set_recognizer_enabled(params: dict[str, Any]) -> dict[str, Any]:
        label = _require_str(params, "label")
        enabled = params.get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("enabled 必须是布尔值")
        device_id = params.get("deviceId")
        selected = manager.get(device_id) if isinstance(device_id, str) and device_id else None
        workflow_root = _optional_str(params, "workflowRoot")
        project = (
            Project(root=os.path.realpath(os.path.abspath(os.path.expanduser(workflow_root))))
            if workflow_root
            else selected.project
            if selected is not None
            else manager._require_project()
        )
        with GRAPH_WRITE_LOCK:
            graph = load_session_graph(project)
            result = graph.set_recognizer_enabled(label, enabled)
            graph.save()
        root = selected._root_key(project.root) if selected is not None else os.path.realpath(project.root)
        for session in list(manager.sessions.values()):
            with session.lock:
                targets = [session.graph] if session._same_root(session.project.root, root) else []
                targets.extend(
                    runner.graph for runner in session.runners.values() if session._same_root(runner.root, root)
                )
                seen: set[int] = set()
                for live_graph in targets:
                    if id(live_graph) in seen or label not in live_graph.specs:
                        continue
                    seen.add(id(live_graph))
                    live_graph.set_recognizer_enabled(label, enabled)
                    recognizer = live_graph.recognizers[label]
                    if isinstance(recognizer, YoloRecognizer):
                        recognizer.enabled_after_frame = session.index
                engines = [session.engine, *(runner.engine for runner in session.runners.values())]
                for engine in engines:
                    if id(engine.graph) not in seen:
                        continue
                    engine.detections.pop(label, None)
                    vote = engine._vote if isinstance(engine, FlowEngine) else engine.vote
                    vote.update(label, False)
                if id(session.engine.graph) in seen:
                    session._view_snapshot = None
        return result

    @server.method(METHOD_RECOGNIZER_THRESHOLD)
    def _threshold(params: dict[str, Any]) -> dict[str, Any]:
        label = _require_str(params, "label")
        threshold = float(params.get("threshold", 0.82))
        device_id = params.get("deviceId")
        if isinstance(device_id, str) and device_id and device_id in manager.sessions:
            return manager.get(device_id).set_threshold(label, threshold)
        return manager.mutate_project_graph(
            lambda graph: (graph.set_threshold(label, threshold), {"label": label, "threshold": threshold})[1]
        )

    @server.method(METHOD_RECOGNIZER_SEARCH)
    def _recognizer_search(params: dict[str, Any]) -> dict[str, Any]:
        label = _require_str(params, "label")
        search = str(params.get("search", "region"))
        device_id = params.get("deviceId")
        if isinstance(device_id, str) and device_id and device_id in manager.sessions:
            return manager.get(device_id).set_recognizer_search(label, search)
        return manager.mutate_project_graph(lambda graph: graph.set_recognizer_search(label, search))

    @server.method(METHOD_RECOGNIZER_DETAIL)
    def _recognizer_detail(params: dict[str, Any]) -> dict[str, Any]:
        label = _require_str(params, "label")
        device_id = params.get("deviceId")
        if isinstance(device_id, str) and device_id and device_id in manager.sessions:
            return manager.get(device_id).recognizer_detail(label)
        # 示例是工作流的磁盘素材，与是否连接设备无关（与 graph.get / template.image 一致）。
        return graph_recognizer_detail(manager.project_graph(), label)

    @server.method(METHOD_RECOGNIZER_UPDATE)
    def _recognizer_update(params: dict[str, Any]) -> dict[str, Any]:
        with recognizer_edit_lock:
            return _update_recognizer(params)

    def _update_recognizer(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        label = _require_str(params, "label")
        spec = params.get("spec")
        if not isinstance(spec, dict):
            raise RuntimeError("spec 必须是对象")
        new_label = params.get("newLabel")
        if new_label is not None and not isinstance(new_label, str):
            raise ValueError("newLabel 必须是字符串")
        result = session.recognizer_update(label, spec, new_label)
        updated = Graph.from_dict(result["graph"], session.project.root, path=session.project.graph_path)
        from ..sessions.yolo import sync_recognizer_update

        for other in list(manager.sessions.values()):
            if other is not session:
                sync_recognizer_update(other, updated, label, result["label"])
        return result

    @server.method(METHOD_RECOGNIZER_EXAMPLE)
    def _recognizer_example(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        label = _require_str(params, "label")
        rect = params.get("rect")
        if not isinstance(rect, (list, tuple)) or len(rect) != 4:
            raise RuntimeError("rect 必须是 [x, y, w, h]")
        return session.add_example(
            label,
            [float(value) for value in rect],
            params.get("image"),
        )

    @server.method(METHOD_RECOGNIZER_FRAMES)
    def _recognizer_frames(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        return {"frames": session.frame_history(int(params.get("count", 20)))}

    @server.method(METHOD_RECOGNIZER_FRAME_META)
    def _recognizer_frame_meta(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        return session.frame_meta()

    @server.method(METHOD_RECOGNIZER_FRAME_AT)
    def _recognizer_frame_at(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        # nearest 默认 false（精确命中、滚出缓冲报错）；界面回放时可传 true 容错取最近帧
        return session.frame_at(
            int(_require_float(params, "index")),
            nearest=bool(params.get("nearest", False)),
        )

    @server.method(METHOD_RECOGNIZER_PREVIEW)
    def _recognizer_preview(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        examples = params.get("examples")
        if not isinstance(examples, list):
            raise RuntimeError("examples 必须是数组")
        return session.preview_yolo(
            str(params.get("previewId") or "default"),
            [dict(item) for item in examples if isinstance(item, dict)],
            conf=float(params.get("conf", 0.3)),
            iou=float(params.get("iou", 0.45)),
            imgsz=int(params.get("imgsz", 640)),
            tile=bool(params.get("tile", False)),
            tile_size=int(params.get("tileSize", 640)),
            tile_overlap=float(params.get("tileOverlap", 0.2)),
            freeze=bool(params.get("freeze", True)),
            roi=params.get("roi"),
        )

    @server.method(METHOD_RECOGNIZER_CREATE)
    def _recognizer_create(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        label = _require_str(params, "label")
        spec = params.get("spec")
        if not isinstance(spec, dict):
            raise RuntimeError("spec 必须是对象")
        return session.add_recognizer(label, spec)

    @server.method(METHOD_RUN_START)
    def _run_start(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        step_id = params.get("stepId")
        from_step = str(step_id).strip() if step_id is not None and str(step_id).strip() else None
        workflow_root = _optional_str(params, "workflowRoot")
        # A priority stop may overtake a start waiting in the ordinary RPC pool.
        # Recheck while holding the same lifecycle lock used by stop/start so an
        # already superseded start cannot resurrect the stopped workflow.
        with session._lifecycle_lock:
            if not server.run_command_current():
                return {"ok": True, "running": False, "superseded": True}
            root = session._root_key(workflow_root or session.project.root)
            previous = session.runners.get(root)
            stop_intent = server.take_run_stop_intent()
            if previous is not None and (
                stop_intent or (isinstance(previous.engine, FlowEngine) and previous.engine._stop_requested.is_set())
            ):
                # A newer start may supersede stop after its cancellation signal.
                # Retire that exact cancelled generation before starting afresh.
                session.stop_run(workflow_root)
            session.start_run(from_step_id=from_step, workflow_root=workflow_root)
        return {"ok": True, "running": True, **({"stepId": from_step} if from_step else {})}

    @server.method(METHOD_RUN_RESUME)
    def _run_resume(params: dict[str, Any]) -> dict[str, Any]:
        """断点暂停后继续跑。"""
        session = manager.get(_require_str(params, "deviceId"))
        session.engine.resume()
        session.emit("run.resumed", {"deviceId": session.device_id})
        return {"ok": True, "paused": session.engine.paused}

    @server.method(METHOD_RUN_STEP)
    def _run_step(params: dict[str, Any]) -> dict[str, Any]:
        """单步：执行完当前这一步，进入下一步之前再暂停。"""
        session = manager.get(_require_str(params, "deviceId"))
        session.engine.step()
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
        workflow_root = _optional_str(params, "workflowRoot")
        root = session._root_key(workflow_root or session.project.root)
        # Snapshot identities before checking the command generation: an old stop
        # must never look up and cancel a new runner after its final token check.
        targets = [session.runners.get(key) for key in [root, *session._subflow_descendants(root)]]
        if not server.run_command_current():
            return {"ok": True, "running": session.running, "superseded": True}
        for runner in targets:
            if runner is not None and isinstance(runner.engine, FlowEngine):
                runner.engine.request_stop()
        with session._lifecycle_lock:
            if not server.run_command_current():
                return {"ok": True, "running": session.running, "superseded": True}
            session.stop_run(workflow_root)
        return {"ok": True, "running": session.running}

    @server.method(METHOD_TIMELINE)
    def _timeline(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        return session.timeline(int(params.get("limit", 60)))

    @server.method(METHOD_RUN_EVIDENCE)
    def _run_evidence(params: dict[str, Any]) -> dict[str, Any]:
        """最近一次运行的证据：目录 + 每一步的截图文件名（图另取 `evidence.image`）。"""
        session = manager.get(_require_str(params, "deviceId"))
        bundle = session.evidence_bundle(_optional_str(params, "workflowRoot"))
        return {"evidence": bundle}

    @server.method(METHOD_EVIDENCE_IMAGE)
    def _evidence_image(params: dict[str, Any]) -> dict[str, Any]:
        """按文件名取一张证据截图（base64 JPEG）。"""
        session = manager.get(_require_str(params, "deviceId"))
        name = _require_str(params, "name")
        data = session.evidence_image(name, _optional_str(params, "workflowRoot"))
        if data is None:
            raise RuntimeError(f"找不到这张证据截图: {name}")
        return {"name": name, "jpeg": base64.b64encode(data).decode("ascii")}

    @server.method(METHOD_OCR_STATUS)
    def _ocr_status(params: dict[str, Any]) -> dict[str, Any]:
        _ = params
        return OCR_MANAGER.status()

    @server.method(METHOD_OCR_LOAD)
    def _ocr_load(params: dict[str, Any]) -> dict[str, Any]:
        _ = params
        # 后台加载：立刻返回，避免 Rust 侧 RPC 超时（进度走 ocr.progress）
        return OCR_MANAGER.load(
            on_progress=lambda payload: server.notify(NOTIFY_OCR_PROGRESS, payload),
            wait=False,
        )

    @server.method(METHOD_OCR_RECOGNIZE)
    def _ocr_recognize(params: dict[str, Any]) -> dict[str, Any]:
        session = manager.get(_require_str(params, "deviceId"))
        with session.lock:
            raw_frame = session.last_frame
        if raw_frame is None:
            raise RuntimeError("还没有可用画面，请先连接设备并等待首帧")
        rect = Rect.parse(params["rect"]) if params.get("rect") is not None else None
        h, w = raw_frame.shape[:2]
        # 复制帧：识别在后台线程跑，不能与会话截图循环共享同一块内存
        frame = Frame(image=raw_frame.copy(), size=(int(w), int(h)))
        device_id = _require_str(params, "deviceId")

        def on_complete(result: dict[str, Any]) -> None:
            server.notify(
                NOTIFY_OCR_RESULT,
                {**result, "deviceId": device_id},
            )

        return OCR_MANAGER.begin_recognize(
            frame,
            rect,
            on_progress=lambda payload: server.notify(NOTIFY_OCR_PROGRESS, payload),
            on_complete=on_complete,
        )

    @server.method(METHOD_OCR_CANCEL)
    def _ocr_cancel(params: dict[str, Any]) -> dict[str, Any]:
        _ = params
        return OCR_MANAGER.cancel_recognize()

    # ---------------- YOLO 组件（可选下载） ----------------

    @server.method(METHOD_YOLO_STATUS)
    def _yolo_status(params: dict[str, Any]) -> dict[str, Any]:
        _ = params
        return {"component": yolo_component.status(), "runtime": YOLO_MANAGER.status()}

    @server.method(METHOD_YOLO_WARMUP)
    def _yolo_warmup(_params: dict[str, Any]) -> dict[str, Any]:
        return YOLO_MANAGER.warmup()

    @server.method(METHOD_YOLO_MODELS)
    def _yolo_models(params: dict[str, Any]) -> dict[str, Any]:
        _ = params
        return YOLO_MANAGER.models()

    @server.method(METHOD_YOLO_SET_MODEL)
    def _yolo_set_model(params: dict[str, Any]) -> dict[str, Any]:
        return YOLO_MANAGER.set_model(_require_str(params, "model"))

    @server.method(METHOD_YOLO_ADD_MODEL)
    def _yolo_add_model(params: dict[str, Any]) -> dict[str, Any]:
        source = Path(_require_str(params, "path"))
        if not source.is_file():
            raise RuntimeError(f"文件不存在: {source}")
        added = yolo_component.import_models(source)
        return {"added": added, "models": yolo_component.list_models()}

    @server.method(METHOD_YOLO_INSTALL)
    def _yolo_install(params: dict[str, Any]) -> dict[str, Any]:
        source = str(params.get("source") or "").strip() or yolo_component.default_source()
        if not source:
            raise RuntimeError(
                "没有组件下载源：传入 source（http(s)/file:///本地 zip），或设置 GAMEPILOT_YOLO_COMPONENT_URL"
            )

        def run() -> None:
            try:
                result = yolo_component.install(
                    source,
                    on_progress=lambda payload: server.notify(NOTIFY_YOLO_PROGRESS, payload),
                )
                # 组件换了（版本/变体）→ 停掉旧 worker，下一次推理用新组件
                YOLO_MANAGER.shutdown()
                server.notify(
                    NOTIFY_YOLO_PROGRESS,
                    {"state": "done", "progress": 100.0, "stage": "AI 组件已就绪", "status": result},
                )
            except Exception as exc:  # 安装失败只通知，不影响引擎
                logger.warning("YOLO 组件安装失败: %s", exc)
                server.notify(NOTIFY_YOLO_PROGRESS, {"state": "error", "error": str(exc)})

        threading.Thread(target=run, name="yolo-install", daemon=True).start()
        return {"accepted": True}

    @server.method(METHOD_YOLO_REMOVE)
    def _yolo_remove(params: dict[str, Any]) -> dict[str, Any]:
        _ = params
        YOLO_MANAGER.shutdown()
        return yolo_component.remove()

    return manager


__all__ = ["SessionManager", "parse_device_uri", "register"]
