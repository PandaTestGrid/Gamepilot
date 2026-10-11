"""设备会话：一个设备 = 一个截图循环 + 一份状态图 + 一个状态机。

职责（DESIGN.md §4.6 的运行时部分）：
- **唯一的截图循环**：谁都不许绕过它去点设备；
- 每帧做识别（不跑状态机时也做，UI 要实时看到分数）；
- 运行态下每帧 tick 状态机并把事件推出去；
- 帧以 JPEG(base64) 推给前端，附带当帧识别结果与节点状态；
- 录制：从**当前帧**裁剪模板 → 落盘 → 注册识别器 → 写回 graph.json。

线程模型：capture 线程只做"抓帧 → 识别 → 推送"，RPC 线程只做读写，
共享的状态图用锁保护（录制/改阈值时短暂持有）。
"""

from __future__ import annotations

import base64
import json
import logging
import threading
import time
from collections.abc import Callable
from typing import Any

import cv2
import numpy as np

from .core.actions import Action
from .core.conditions import ALWAYS_LABEL
from .core.frame import Frame
from .core.geometry import Rect
from .core.graph import Edge, Graph, Node
from .core.state_machine import Engine
from .core.trace import TraceBuffer
from .devices import ORIENTATION_LABELS
from .devices.base import Controller
from .frames import FrameSink
from .project import Project

logger = logging.getLogger("gamepilot.session")

Emit = Callable[[str, dict[str, Any]], None]


class DeviceSession:
    def __init__(
        self,
        device_id: str,
        controller: Controller,
        project: Project,
        emit: Emit,
        *,
        fps: float = 8.0,
        jpeg_width: int = 720,
        jpeg_quality: int = 65,
    ) -> None:
        self.device_id = device_id
        self.controller = controller
        self.project = project
        self.emit = emit
        # scrcpy 通道能到 ~28fps，帧率上限跟着提上去；adb 截图通道每秒只有 1.8 帧，
        # 上限设多少都无所谓（循环自然被截图耗时卡住）
        if getattr(controller, "channel", "") == "scrcpy":
            fps = max(fps, 15.0)
        self.fps_limit = max(1.0, fps)
        self.jpeg_width = jpeg_width
        self.jpeg_quality = jpeg_quality

        self.trace = TraceBuffer()
        self.graph = Graph.load(project.graph_path)
        self.engine = Engine(self.graph, controller, trace=self.trace, on_event=self._on_engine_event)
        self.lock = threading.RLock()
        self.running = False  # 状态机是否在跑
        self.started = False  # 截图循环是否在跑
        self.index = 0
        self.fps = 0.0
        self.capture_ms = 0.0
        self.last_frame: np.ndarray | None = None
        self._last_emit_at: float | None = None
        self._input_seq = 0  # 手动控制事件的序号（事件栏按 seq 排序）
        self._touch_from: tuple[float, float] | None = None
        # 录制的上一条动作边：下次录新界面时自动把 to 接上
        self._pending_edge_id: str | None = None
        # 最近一次录制涉及的节点：刚录完模板马上点一下时，靠它定位这一步属于哪个界面
        self._last_node_id: str | None = None
        self._last_node_at = 0.0
        # 推给界面的帧率（0 = 暂停推帧）。识别/状态机不受影响，仍按 fps_limit 跑，
        # 这样"界面不看这台设备"时不会白烧 CPU 与带宽（多设备时尤其明显）
        # 默认 0：界面明确要了才推。连接瞬间就按 15fps 推帧会把控制通道（同一根
        # stdout）灌满，RPC 响应排在几万行帧后面 —— 表现就是"卡在 connecting、一帧都收不到"
        self.stream_fps = 0.0
        # 帧走独立 socket（见 frames.py）：不占控制通道，宿主也不做 base64
        self.frames = FrameSink.from_env()
        self._last_push_at = 0.0
        self._last_seq: int | None = None
        self._last_jpeg: bytes | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------ #
    # 生命周期
    # ------------------------------------------------------------------ #

    def start(self) -> None:
        if self.started:
            return
        self._stop.clear()
        if self.frames is not None:
            self.frames.start()  # 帧通道：JPEG 走独立 socket，不占控制通道
        self._thread = threading.Thread(target=self._loop, name=f"capture-{self.device_id}", daemon=True)
        self._thread.start()
        self.started = True
        logger.info("会话启动: %s", self.device_id)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
        self._thread = None
        if self.frames is not None:
            self.frames.close()
        self.started = False
        with self.lock:
            self.running = False
        try:
            self.controller.close()
        except Exception as exc:  # pragma: no cover - 关闭失败不影响退出
            logger.warning("关闭设备失败: %s", exc)

    # ------------------------------------------------------------------ #
    # 截图循环
    # ------------------------------------------------------------------ #

    def _loop(self) -> None:
        interval = 1.0 / self.fps_limit
        while not self._stop.is_set():
            started = time.perf_counter()
            try:
                image = self.controller.screenshot()
            except Exception as exc:
                self.emit("device.failed", {"deviceId": self.device_id, "error": f"截图失败: {exc}"})
                time.sleep(0.5)
                continue

            self.capture_ms = (time.perf_counter() - started) * 1000
            self.index += 1
            frame = Frame(image=image, size=self.controller.resolution, index=self.index)
            with self.lock:
                self.last_frame = image.copy()
                if self.running and self.graph.nodes:
                    events = self.engine.tick(frame)
                    for event in events:
                        logger.debug("event %s %s", event.type, event.message)
                else:
                    self.engine.perceive(frame)
                    self.trace.add_frame(
                        frame.index,
                        self.engine.current,
                        [item.to_dict() for item in self.engine.detections.values()],
                    )

            detections = [item.to_dict() for item in self.engine.detections.values()]
            if self._should_push():
                self._emit_frame(frame, detections)

            elapsed = time.perf_counter() - started
            # fps 是"实际交付节奏"（两次推帧的间隔），不是 1/截图耗时：
            # scrcpy 通道截图只要 0.3ms，按后者算会得出 1300fps 这种假数字
            now = time.perf_counter()
            period = now - self._last_emit_at if self._last_emit_at else elapsed
            self.fps = 1.0 / period if period > 0 else 0.0
            self._last_emit_at = now
            time.sleep(max(0.0, interval - (time.perf_counter() - started)))

    def _should_push(self) -> bool:
        """这一拍要不要推给界面（stream_fps = 0 表示界面没显示这台设备）。"""
        if self.stream_fps <= 0:
            return False
        now = time.perf_counter()
        if now - self._last_push_at < 1.0 / self.stream_fps:
            return False
        self._last_push_at = now
        return True

    def set_stream_fps(self, fps: float) -> None:
        self.stream_fps = max(0.0, float(fps))
        logger.info("推流帧率: %.1f fps (设备 %s)", self.stream_fps, self.device_id)

    def _emit_frame(self, frame: Frame, detections: list[dict[str, Any]]) -> None:
        # 画面没变（scrcpy 静止时会重复同一帧）就复用上次的 JPEG，省掉一次编码
        seq = getattr(self.controller, "_frame_seq", None)
        if seq is not None and seq == self._last_seq and self._last_jpeg is not None:
            jpeg_bytes = self._last_jpeg
        else:
            jpeg_bytes = self._encode_jpeg(frame.image)
            self._last_seq = seq
            self._last_jpeg = jpeg_bytes

        # 帧走独立 socket（原始字节）；没有 socket 时退回 base64 塞在通知里（单测/非 unix）
        send_raw = self.frames is not None
        if send_raw:
            assert self.frames is not None
            self.frames.submit(self.device_id, jpeg_bytes)

        payload = {
            "deviceId": self.device_id,
            "index": frame.index,
            "ts": round(frame.ts, 3),
            "resolution": list(frame.size),
            "node": self.engine.current,
            "pending": self.engine.pending.edge.id if self.engine.pending else None,
            "tick": self.engine.stats["ticks"],
            "fps": round(self.fps, 1),
            "captureMs": round(self.capture_ms, 1),
            "detections": detections,
            **({} if send_raw else {"jpeg": base64.b64encode(jpeg_bytes).decode("ascii")}),
        }
        self.emit("engine.frame", payload)

    def _encode_jpeg(self, image: np.ndarray) -> bytes:
        """编码成 JPEG 原始字节（缩到 jpeg_width）。返回空 bytes 表示编码失败。"""
        height, width = image.shape[:2]
        if width > self.jpeg_width:
            scale = self.jpeg_width / float(width)
            image = cv2.resize(image, (self.jpeg_width, max(1, int(height * scale))), interpolation=cv2.INTER_AREA)
        ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality])
        return buffer.tobytes() if ok else b""

    def _on_engine_event(self, event: Any) -> None:
        self.emit("engine.event", {"deviceId": self.device_id, **event.to_dict()})

    # ------------------------------------------------------------------ #
    # 运行控制
    # ------------------------------------------------------------------ #

    # ------------------------------------------------------------------ #
    # 手动控制（画面栏直接操作设备）
    # ------------------------------------------------------------------ #

    def touch(self, phase: str, x: float, y: float) -> None:
        """实时触控（画面栏拖动时逐事件转发）。

        move 不写事件（拖动一次会来上百个），只在 down/up 留痕。
        """
        if phase not in ("down", "move", "up"):
            # 在会话层统一校验：各控制器（真机/Mock）行为保持一致
            raise ValueError(f"phase 必须是 down/move/up，收到: {phase}")
        with self.lock:
            controller = self.controller
            if hasattr(controller, "touch"):
                controller.touch(phase, x, y)
            elif phase == "down" or phase == "up":
                controller.click(x, y)
            else:
                return
        if phase == "down":
            self._touch_from = (x, y)
            self._input_seq += 1
            self.emit(
                "engine.event",
                {
                    "deviceId": self.device_id,
                    "seq": self._input_seq,
                    "ts": time.time(),
                    "type": "manual_input",
                    "node": self.engine.current,
                    "edge": None,
                    "message": f"手动触控 按下 ({x:.3f}, {y:.3f})",
                },
            )
        elif phase == "up":
            start = getattr(self, "_touch_from", None)
            detail = (
                f"({x:.3f}, {y:.3f})" if start is None else f"({start[0]:.3f}, {start[1]:.3f}) → ({x:.3f}, {y:.3f})"
            )
            self._input_seq += 1
            self.emit(
                "engine.event",
                {
                    "deviceId": self.device_id,
                    "seq": self._input_seq,
                    "ts": time.time(),
                    "type": "manual_input",
                    "node": self.engine.current,
                    "edge": None,
                    "message": f"手动触控 {detail}",
                },
            )

    def tap(self, x: float, y: float) -> None:
        """归一化坐标轻触。"""
        started = time.perf_counter()
        with self.lock:
            self.controller.click(x, y)
        self._emit_input("手动点击", f"({x:.3f}, {y:.3f})", started)

    def swipe(self, x1: float, y1: float, x2: float, y2: float, duration: float) -> None:
        """归一化坐标滑动。"""
        started = time.perf_counter()
        with self.lock:
            self.controller.swipe(x1, y1, x2, y2, duration=duration)
        self._emit_input("手动滑动", f"({x1:.2f}, {y1:.2f}) → ({x2:.2f}, {y2:.2f}) {duration * 1000:.0f}ms", started)

    def press(self, name: str) -> None:
        """功能键（back/home/recents/power/volume_*）。"""
        started = time.perf_counter()
        with self.lock:
            controller = self.controller
            if hasattr(controller, "press"):
                controller.press(name)
            else:
                controller.key(name)
        self._emit_input("手动按键", name, started)

    def _emit_input(self, title: str, detail: str, started: float) -> None:
        cost_ms = (time.perf_counter() - started) * 1000
        with self.lock:
            self._input_seq += 1
        self.emit(
            "engine.event",
            {
                "deviceId": self.device_id,
                "seq": self._input_seq,
                "ts": time.time(),
                "type": "manual_input",
                "node": self.engine.current,
                "edge": None,
                "message": f"{title} {detail}（{cost_ms:.1f}ms）",
            },
        )

    def start_run(self) -> None:
        with self.lock:
            if not self.graph.nodes:
                raise RuntimeError("状态图还没有节点：先在画面上框选录制一个界面")
            # 每次开始运行都把变量恢复成默认值（上次跑完的残留不该带进来）
            self.engine.reset_variables()
            self.running = True
        self.emit("run.started", {"deviceId": self.device_id})

    def stop_run(self) -> None:
        with self.lock:
            self.running = False
            self.engine.pending = None
        self.emit("run.stopped", {"deviceId": self.device_id})

    # ------------------------------------------------------------------ #
    # 录制与调参
    # ------------------------------------------------------------------ #

    def record_action(self, action: dict[str, Any], *, to: str | None = None) -> dict[str, Any]:
        """把手动操作录成脚本里的一步（一条边）。

        语义：在当前所处界面上做这个动作 —— 所以条件默认是"当前节点的进入识别器"，
        没有识别器就退化成"无条件（进节点就做）"。
        录下来的边会记住 id，下一次录新界面（record_template 建节点）时自动接上，
        形成 A --点一下--> B 的完整流程。
        """
        with self.lock:
            parsed = Action.parse(action)
            # 这一步挂在哪个界面上？按"能录就录"的顺序找：
            #   ① 当前帧能确认在哪个界面（最准）
            #   ② 本会话内最近录过的界面（刚录完模板就点一下的常见场景）
            #   ③ 脚本里最后一个界面（应用重启后 _last_node_id 会丢，但 graph.json 还在）
            #   ④ 一个都没有 → 自动用当前画面建一个界面，别让用户卡在"录不了"
            # 刚录过模板（2 分钟内）时，用户下一步的意图就是"在这个界面上做"，
            # 优先用它：否则自动建的界面（模板就取自当前画面，必然匹配）会把归属抢走
            recent_node = self._last_node_id if self._last_node_id and time.time() - self._last_node_at < 120 else None
            source = recent_node or self.engine.locate() or self._latest_node_id()
            created_for_recording = None
            if source is None:
                source, created_for_recording = self._auto_create_node_for_recording()
            if created_for_recording:
                self.emit(
                    "engine.event",
                    {
                        "deviceId": self.device_id,
                        "seq": self._input_seq,
                        "ts": time.time(),
                        "type": "node_auto_created",
                        "node": created_for_recording,
                        "message": f"脚本里还没有界面，已用当前画面自动建了「{created_for_recording}」",
                    },
                )
            when = ""
            if source and source in self.graph.nodes:
                enter = self.graph.nodes[source].enter
                if enter:
                    when = enter[0]
            condition = {"all_of": [when]} if when else {"always": True}
            edge_id = f"e_rec_{len(self.graph.edges) + 1}"
            while any(edge.id == edge_id for edge in self.graph.edges):
                edge_id = f"{edge_id}_x"
            edge = Edge.from_dict(
                {
                    "id": edge_id,
                    "when": when or ALWAYS_LABEL,
                    "from": source,
                    "to": to,
                    # 一步只做一次：进入节点后 600ms 内不重复（避免 14fps 下连点）
                    "cooldown_ms": 600,
                    "condition": condition,
                    "action": parsed.to_dict(),
                }
            )
            self.graph.add_edge(edge)
            self.graph.validate()
            self.graph.save()
            self.reload_graph()
            self._pending_edge_id = edge_id
            self.emit(
                "engine.event",
                {
                    "deviceId": self.device_id,
                    "seq": self._input_seq,
                    "ts": time.time(),
                    "type": "action_recorded",
                    "node": source,
                    "edge": edge_id,
                    "message": f"录制步骤 {edge_id}: {parsed.describe()}",
                },
            )
            return {"edgeId": edge_id, "graph": self.graph.to_dict()}

    def _latest_node_id(self) -> str | None:
        """脚本里最后一个界面（dict 保序，所以就是最后加进去的那个）。"""
        return next(reversed(self.graph.nodes), None) if self.graph.nodes else None

    def _auto_create_node_for_recording(self) -> tuple[str, str | None]:
        """当前画面还没对应界面时，自动建一个（顺手用画面中部做模板，好让状态机能认出它）。"""
        if self.last_frame is None:
            raise RuntimeError("还没有可用画面：先连接设备、等到画面出来，再开「录操作」")
        index = len(self.graph.nodes) + 1
        node_id = f"n_{index}"
        while node_id in self.graph.nodes:
            index += 1
            node_id = f"n_{index}"
        name = f"界面{index}"

        # 用画面中部 60% 当模板：避开状态栏时钟/通知这类一直在变的地方
        height, width = self.last_frame.shape[:2]
        crop = self.last_frame[int(height * 0.2) : int(height * 0.8), int(width * 0.2) : int(width * 0.8)]
        label = f"{node_id}_screen"
        filename = f"{label}.png"
        cv2.imwrite(f"{self.project.templates_dir}/{filename}", crop)
        self.graph.add_recognizer(
            label,
            {
                "type": "template",
                "template": f"templates/{filename}",
                "threshold": 0.8,
                "roi": [0.2, 0.2, 0.6, 0.6],
            },
        )
        self.graph.upsert_node(Node(id=node_id, name=name, enter=[label]))
        self._last_node_id = node_id
        self._last_node_at = time.time()
        return node_id, name

    def graph_node_add(self, node_id: str | None, name: str | None, enter: list[str] | None) -> dict[str, Any]:
        with self.lock:
            identifier = node_id or f"n_{len(self.graph.nodes) + 1}"
            node = self.graph.nodes.get(identifier) or Node(id=identifier, name=name or identifier, enter=[])
            if name:
                node.name = name
            for label in enter or []:
                if label not in self.graph.recognizers:
                    raise ValueError(f"未定义的识别器: {label}")
                if label not in node.enter:
                    node.enter.append(label)
            self.graph.upsert_node(node)
            self.graph.validate()
            self.graph.save()
            self.reload_graph()
            return {"nodeId": node.id, "graph": self.graph.to_dict()}

    def graph_node_update(self, node_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            node = self.graph.nodes.get(node_id)
            if node is None:
                raise ValueError(f"没有这个节点: {node_id}")
            if isinstance(patch.get("name"), str):
                node.name = str(patch["name"])
            if "enter" in patch:
                enter = [str(item) for item in patch["enter"] or []]
                for label in enter:
                    if label not in self.graph.recognizers:
                        raise ValueError(f"未定义的识别器: {label}")
                node.enter = enter
            if patch.get("timeout_ms") is not None:
                node.timeout_ms = int(patch["timeout_ms"])
            self.graph.upsert_node(node)
            self.graph.validate()
            self.graph.save()
            self.reload_graph()
            return {"nodeId": node.id, "graph": self.graph.to_dict()}

    def graph_node_remove(self, node_id: str) -> dict[str, Any]:
        with self.lock:
            if node_id not in self.graph.nodes:
                raise ValueError(f"没有这个节点: {node_id}")
            del self.graph.nodes[node_id]
            # 引用了这个节点的边一并删掉（否则图就不合法了）
            self.graph.edges = [edge for edge in self.graph.edges if edge.src != node_id and edge.dst != node_id]
            self.graph.save()
            self.reload_graph()
            return {"removed": node_id, "graph": self.graph.to_dict()}

    def graph_edge_add(
        self, *, src: str | None, dst: str | None, when: str | None = None, action: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        with self.lock:
            label = when or ""
            if not label and src and src in self.graph.nodes and self.graph.nodes[src].enter:
                label = self.graph.nodes[src].enter[0]
            edge_id = f"e_{label or 'new'}_{len(self.graph.edges) + 1}"
            while any(edge.id == edge_id for edge in self.graph.edges):
                edge_id = f"{edge_id}_x"
            default_action = action or (
                {"type": "click", "target": label} if label else {"type": "wait", "seconds": 0.5}
            )
            edge = Edge.from_dict(
                {
                    "id": edge_id,
                    "when": label or ALWAYS_LABEL,
                    "from": src,
                    "to": dst,
                    "cooldown_ms": 600,
                    "condition": {"all_of": [label]} if label else {"always": True},
                    "action": default_action,
                }
            )
            self.graph.add_edge(edge)
            self.graph.validate()
            self.graph.save()
            self.reload_graph()
            return {"edgeId": edge_id, "graph": self.graph.to_dict()}

    def record_template(
        self,
        rect: Rect,
        label: str,
        threshold: float = 0.82,
        *,
        as_enter: bool = True,
        as_action_target: bool = True,
        node_id: str | None = None,
        node_name: str | None = None,
    ) -> dict[str, Any]:
        """从当前帧裁剪模板 → 落盘 → 注册识别器（并按需建节点/边）。"""
        with self.lock:
            if self.last_frame is None:
                raise RuntimeError("还没有可用画面，请先连接设备并等待首帧")
            x, y, w, h = rect.clamp().to_pixels(self.last_frame.shape[1::-1])
            crop = self.last_frame[y : y + h, x : x + w]
            if crop.size == 0:
                raise RuntimeError("框选区域为空")

            filename = f"{label}.png"
            cv2.imwrite(f"{self.project.templates_dir}/{filename}", crop)

            # 纯色区域用模板匹配没有判别力（NCC 退化），自动改用颜色识别器
            std = float(crop.std())
            if std < 2.0:
                mean = crop.reshape(-1, 3).mean(axis=0)
                spec: dict[str, Any] = {
                    "type": "color",
                    "target_bgr": [round(float(value)) for value in mean],
                    "tolerance": 30,
                    "min_pixels": max(20, int(0.3 * crop.shape[0] * crop.shape[1])),
                    "roi": rect.clamp().to_list(),
                }
                mode = "color"
            else:
                spec = {
                    "type": "template",
                    "template": f"templates/{filename}",
                    "threshold": round(float(threshold), 4),
                    "roi": rect.clamp().to_list(),
                }
                mode = "template"
            self.graph.add_recognizer(label, spec)

            created_node = None
            if as_enter and node_id:
                node = self.graph.nodes.get(node_id) or Node(id=node_id, name=node_name or node_id, enter=[])
                if label not in node.enter:
                    node.enter.append(label)
                self.graph.upsert_node(node)
                created_node = node.id
                self._last_node_id = node.id
                self._last_node_at = time.time()
            # 录制流程自动接链：上一步录的动作边 → 指向这个新界面
            if created_node and self._pending_edge_id:
                for item in self.graph.edges:
                    if item.id == self._pending_edge_id and not item.dst:
                        item.dst = created_node
                self._pending_edge_id = None
            if as_action_target and self.engine.current and created_node and created_node != self.engine.current:
                self.graph.add_edge(
                    Edge(
                        id=f"e_{label}",
                        when=label,
                        src=self.engine.current,
                        dst=created_node,
                        action={"type": "click", "target": label},
                    )
                )
            self.graph.save()
            self.reload_graph()
            return {
                "label": label,
                "mode": mode,  # template | color（纯色区域会自动降级成颜色识别器）
                "template": f"templates/{filename}",
                "rect": rect.clamp().to_list(),
                "graph": self.graph.to_dict(),
            }

    def set_threshold(self, label: str, threshold: float) -> dict[str, Any]:
        with self.lock:
            self.graph.set_threshold(label, threshold)
            self.graph.save()
            self.reload_graph()
            return {"label": label, "threshold": threshold}

    def save_graph(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            graph = Graph.from_dict(payload, base_dir=self.project.root, path=self.project.graph_path)
            graph.save()
            self.reload_graph()
            return graph.to_dict()

    def reload_graph(self) -> None:
        """换一份状态图但保留当前节点与运行态（录制完不该打断运行）。"""
        current = self.engine.current
        running = self.running
        self.graph = Graph.load(self.project.graph_path)
        self.engine = Engine(
            self.graph, self.controller, trace=self.trace, on_event=self._on_engine_event, start_node=current
        )
        self.engine.reset_variables()
        self.running = running

    # ------------------------------------------------------------------ #
    # 状态
    # ------------------------------------------------------------------ #

    def status(self) -> dict[str, Any]:
        with self.lock:
            orientation = getattr(self.controller, "orientation", None)
            orientation_code = orientation if isinstance(orientation, int) else None
            return {
                "deviceId": self.device_id,
                "uri": getattr(self.controller, "options", {}),
                "resolution": list(self.controller.resolution) if self.started else None,
                "running": self.running,
                "index": self.index,
                "fps": round(self.fps, 1),
                "captureMs": round(self.capture_ms, 1),
                "channel": getattr(self.controller, "channel", "unknown"),
                "streamFps": round(self.stream_fps, 1),
                # iOS 会变：界面方向（横屏坐标变换靠它，排错时一眼能看到）
                "variables": self.engine.variables.snapshot(),
                "orientation": orientation_code,
                "orientationName": ORIENTATION_LABELS.get(orientation_code, None) if orientation_code else None,
                "linkNote": getattr(self.controller, "link_note", ""),
                "linkFps": round(float(getattr(self.controller, "link_fps", 0.0)), 1),
                "node": self.engine.current,
                "pending": self.engine.pending.edge.id if self.engine.pending else None,
                "tick": self.engine.stats["ticks"],
                "stats": dict(self.engine.stats),
                "graph": json.loads(json.dumps(self.graph.to_dict())),
            }

    def timeline(self, limit: int = 60) -> dict[str, Any]:
        return {"frames": self.trace.recent_frames(limit), "events": self.trace.recent_events(limit)}
