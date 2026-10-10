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

from .core.frame import Frame
from .core.geometry import Rect
from .core.graph import Edge, Graph, Node
from .core.state_machine import Engine
from .core.trace import TraceBuffer
from .devices.base import Controller
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
        jpeg_width: int = 960,
        jpeg_quality: int = 70,
    ) -> None:
        self.device_id = device_id
        self.controller = controller
        self.project = project
        self.emit = emit
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
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------ #
    # 生命周期
    # ------------------------------------------------------------------ #

    def start(self) -> None:
        if self.started:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name=f"capture-{self.device_id}", daemon=True)
        self._thread.start()
        self.started = True
        logger.info("会话启动: %s", self.device_id)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
        self._thread = None
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
            self._emit_frame(frame, detections)

            elapsed = time.perf_counter() - started
            self.fps = 1.0 / elapsed if elapsed > 0 else 0.0
            time.sleep(max(0.0, interval - elapsed))

    def _emit_frame(self, frame: Frame, detections: list[dict[str, Any]]) -> None:
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
            "jpeg": self._encode(frame.image),
        }
        self.emit("engine.frame", payload)

    def _encode(self, image: np.ndarray) -> str:
        height, width = image.shape[:2]
        if width > self.jpeg_width:
            scale = self.jpeg_width / float(width)
            image = cv2.resize(image, (self.jpeg_width, max(1, int(height * scale))), interpolation=cv2.INTER_AREA)
        ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality])
        return base64.b64encode(buffer.tobytes()).decode("ascii") if ok else ""

    def _on_engine_event(self, event: Any) -> None:
        self.emit("engine.event", {"deviceId": self.device_id, **event.to_dict()})

    # ------------------------------------------------------------------ #
    # 运行控制
    # ------------------------------------------------------------------ #

    def start_run(self) -> None:
        with self.lock:
            if not self.graph.nodes:
                raise RuntimeError("状态图还没有节点：先在画面上框选录制一个界面")
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
        self.running = running

    # ------------------------------------------------------------------ #
    # 状态
    # ------------------------------------------------------------------ #

    def status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "deviceId": self.device_id,
                "uri": getattr(self.controller, "options", {}),
                "resolution": list(self.controller.resolution) if self.started else None,
                "running": self.running,
                "index": self.index,
                "fps": round(self.fps, 1),
                "captureMs": round(self.capture_ms, 1),
                "node": self.engine.current,
                "pending": self.engine.pending.edge.id if self.engine.pending else None,
                "tick": self.engine.stats["ticks"],
                "stats": dict(self.engine.stats),
                "graph": json.loads(json.dumps(self.graph.to_dict())),
            }

    def timeline(self, limit: int = 60) -> dict[str, Any]:
        return {"frames": self.trace.recent_frames(limit), "events": self.trace.recent_events(limit)}
