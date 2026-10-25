"""YoloService: extracted session responsibility; shared state belongs to DeviceSession."""

from __future__ import annotations

import base64
import binascii
import contextlib
import os
import shutil
import time
from typing import TYPE_CHECKING, Any

import cv2
import numpy as np

from ..core.geometry import Rect
from ..core.graph import GRAPH_WRITE_LOCK, Graph, validate_recognizer_label
from .models import _load_graph

if TYPE_CHECKING:
    from .device import DeviceSession


def sync_recognizer_update(session: DeviceSession, graph: Graph, old: str, new: str) -> None:
    """Patch only this material and references; live engine state stays intact."""
    with session.lock:
        targets = [session.graph] if session._same_root(session.project.root, graph.base_dir) else []
        targets.extend(
            runner.graph for runner in session.runners.values() if session._same_root(runner.root, graph.base_dir)
        )
        seen: set[int] = set()
        for live in targets:
            if id(live) in seen or old not in live.specs:
                continue
            seen.add(id(live))
            live.add_recognizer(old, graph.specs[new])
            live.rename_recognizer(old, new)
            live.add_recognizer(new, graph.specs[new])
        for engine in [session.engine, *(runner.engine for runner in session.runners.values())]:
            if id(engine.graph) not in seen:
                continue
            for label in (old, new):
                engine.detections.pop(label, None)
                vote = getattr(engine, "_vote", None) or getattr(engine, "vote", None)
                if vote is not None:
                    vote.update(label, False)
        if id(session.engine.graph) in seen:
            session._view_snapshot = None


def graph_recognizer_detail(graph: Graph, label: str) -> dict[str, Any]:
    """读取工作流里的 AI 配置和示例；磁盘素材预览不依赖设备连接。"""
    spec = dict(graph.specs.get(label) or {})
    if not spec:
        raise RuntimeError(f"识别器不存在: {label}")
    if spec.get("type") != "yolo":
        raise RuntimeError(f"{label} 不是 AI 识别器")
    examples: list[dict[str, Any]] = []
    for item in spec.get("examples") or []:
        if not isinstance(item, dict):
            continue
        template = str(item.get("template") or "")
        path = template if os.path.isabs(template) else os.path.join(graph.base_dir, template)
        payload = ""
        width = height = 0
        if template and os.path.isfile(path):
            image = cv2.imread(path)
            if image is not None:
                height, width = image.shape[:2]
                ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
                if ok:
                    payload = "data:image/jpeg;base64," + base64.b64encode(buffer.tobytes()).decode("ascii")
        examples.append(
            {
                "rect": item.get("rect"),
                "label": str(item.get("label") or label),
                "image": payload,
                "width": int(width),
                "height": int(height),
            }
        )
    raw_roi = spec.get("roi")
    roi = None
    if raw_roi is not None:
        try:
            roi = Rect.parse(raw_roi).clamp().to_list()
        except (TypeError, ValueError, KeyError):
            roi = None
    return {
        "label": label,
        "threshold": float(spec.get("threshold", 0.3)),
        "search": spec.get("search") if spec.get("search") in ("region", "full") else "region",
        "roi": roi,
        "imgsz": int(spec.get("imgsz") or 640),
        "tile": bool(spec.get("tile", False)),
        "tileSize": int(spec.get("tile_size") or 640),
        "tileOverlap": float(spec.get("tile_overlap", 0.2)),
        "examples": examples,
    }


def _decode_frame_data_url(data: object) -> np.ndarray | None:
    """把 "data:image/...;base64,..." 解码成 BGR 图（弹窗传上来的示例快照）。"""
    if not isinstance(data, str) or not data.startswith("data:"):
        return None
    _, _, payload = data.partition(",")
    if not payload:
        return None
    try:
        raw = base64.b64decode(payload)
    except (ValueError, binascii.Error, OSError):
        return None
    buffer = np.frombuffer(raw, dtype=np.uint8)
    if buffer.size == 0:
        return None
    try:
        return cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    except cv2.error:
        return None


class YoloService:
    def __init__(self, session: DeviceSession) -> None:
        self.session = session

    def add_recognizer(self, label: str, spec: dict[str, Any]) -> dict[str, Any]:
        """新建识别器（不录模板）：AI 识别等"语义型"识别器用。

        与录制流程共用同一套落盘 + 热重载；label 唯一性在这里校验。
        """
        self.session._require_workflow()
        with self.session.lock:
            clean = validate_recognizer_label(label)
            if clean in self.session.graph.recognizers:
                raise RuntimeError(f"已经有同名识别器: {clean}")
            prepared = dict(spec)
            raw_examples = prepared.get("examples") or []
            if raw_examples:
                materialized = []
                for index, item in enumerate(raw_examples):
                    if not isinstance(item, dict):
                        continue
                    # 每个示例都可以带自己的冻结帧（快照）；没带才退回当前画面
                    source = _decode_frame_data_url(item.get("image"))
                    if source is None:
                        source = self.session.last_frame
                    if source is None:
                        raise RuntimeError("还没有可用画面：先连接设备、等画面出来再框选示例")
                    filename = f"{clean}_ai{index}.png"
                    path = os.path.join(self.session.project.templates_dir, filename)
                    if not cv2.imwrite(path, source):
                        raise RuntimeError(f"示例参考图保存失败：{path}")
                    materialized.append(
                        {
                            "template": f"templates/{filename}",
                            "rect": item.get("rect"),
                            "label": item.get("label") or clean,
                        }
                    )
                prepared["examples"] = materialized
            if "roi" in prepared and prepared["roi"] is None:
                prepared.pop("roi")
            self.session.graph.add_recognizer(clean, prepared)
            self.session.graph.save()
            self.session.reload_graph()
            return {"label": clean, "graph": self.session.graph.to_dict()}

    def add_example(self, label: str, rect: list[float], image: object = None) -> dict[str, Any]:
        """给已有的 AI 识别器追加一个示例框（可带示例自己的快照）。"""
        self.session._require_workflow()
        with self.session.lock:
            spec = dict(self.session.graph.specs.get(label) or {})
            if spec.get("type") != "yolo":
                raise RuntimeError(f"识别器 {label} 不是 AI 识别器")
            source = _decode_frame_data_url(image)
            if source is None:
                source = self.session.last_frame
            if source is None:
                raise RuntimeError("还没有可用画面：先连接设备、等画面出来再框选示例")
            examples = list(spec.get("examples") or [])
            index = len(examples)
            filename = f"{label}_ai{index}.png"
            path = os.path.join(self.session.project.templates_dir, filename)
            if not cv2.imwrite(path, source):
                raise RuntimeError(f"示例参考图保存失败：{path}")
            examples.append({"template": f"templates/{filename}", "rect": list(rect), "label": label})
            spec["examples"] = examples
            self.session.graph.add_recognizer(label, spec)
            self.session.graph.save()
            self.session.reload_graph()
            return {"label": label, "examples": len(examples), "graph": self.session.graph.to_dict()}

    def recognizer_detail(self, label: str) -> dict[str, Any]:
        """读取一个 AI 识别器的配置 + 示例（参考图转 JPEG 回传，供编辑弹窗预览）。"""
        self.session._require_workflow()
        with self.session.lock:
            return graph_recognizer_detail(self.session.graph, label)

    def recognizer_update(self, label: str, spec: dict[str, Any], new_label: str | None = None) -> dict[str, Any]:
        """一次保存配置与可选新名称；素材路径不随纯改名而失效。"""
        self.session._require_workflow()
        with self.session.lock, GRAPH_WRITE_LOCK:
            graph = _load_graph(self.session.project)
            existing = dict(graph.specs.get(label) or {})
            if not existing:
                raise RuntimeError(f"识别器不存在: {label}")
            if existing.get("type") != "yolo":
                raise RuntimeError(f"{label} 不是 AI 识别器")
            final_label = validate_recognizer_label(new_label) if new_label is not None else label
            if final_label != label and final_label in graph.specs:
                raise ValueError(f"已经有同名识别器: {final_label}")
            raw_examples = spec.get("examples") or []
            if not raw_examples:
                raise RuntimeError("至少要保留一个示例")
            prepared = dict(spec)
            materialized = []
            writes = []
            old_examples = existing.get("examples") or []
            for index, item in enumerate(raw_examples):
                if not isinstance(item, dict):
                    continue
                image = _decode_frame_data_url(item.get("image"))
                if image is not None:
                    template = f"templates/{final_label}_ai{index}.png"
                    path = os.path.join(self.session.project.root, template)
                    writes.append((path, image))
                else:
                    old = old_examples[index] if index < len(old_examples) else {}
                    template = str(old.get("template") or "")
                    path = os.path.join(self.session.project.root, template)
                    if not template or not os.path.isfile(path):
                        raise RuntimeError("示例参考图缺失，请重新框选")
                materialized.append(
                    {"template": template, "rect": item.get("rect"), "label": item.get("label") or label}
                )
            if not materialized:
                raise RuntimeError("至少要保留一个示例")
            prepared["examples"] = materialized
            existing.update(prepared)
            # roi 传 null = 用户点了「清除 ROI」：把旧值删掉，否则会残留成全屏的局部区域
            if "roi" in prepared and prepared["roi"] is None:
                existing.pop("roi", None)
            graph.add_recognizer(label, existing)
            refs = graph.rename_recognizer(label, final_label)
            for path, image in writes:
                if not cv2.imwrite(path, image):
                    raise RuntimeError(f"示例参考图保存失败：{path}")
            graph.save()
            referenced = {
                os.path.realpath(os.path.join(self.session.project.root, str(example.get("template") or "")))
                for value in graph.specs.values()
                for example in value.get("examples", [])
                if isinstance(example, dict)
            }
            for index, old_example in enumerate(old_examples):
                if not isinstance(old_example, dict):
                    continue
                # Preserve reused files; same-name shrinking keeps legacy cleanup.
                if final_label != label and (
                    index >= len(raw_examples) or _decode_frame_data_url(raw_examples[index].get("image")) is None
                ):
                    continue
                old_path = os.path.realpath(
                    os.path.join(self.session.project.root, str(old_example.get("template") or ""))
                )
                if old_path not in referenced:
                    with contextlib.suppress(OSError):
                        os.remove(old_path)
            sync_recognizer_update(self.session, graph, label, final_label)
            return {"label": final_label, "graph": graph.to_dict(), "refs": refs}

    def preview_yolo(
        self,
        preview_id: str,
        examples: list[dict[str, Any]],
        *,
        conf: float = 0.3,
        iou: float = 0.45,
        imgsz: int = 640,
        tile: bool = False,
        tile_size: int = 640,
        tile_overlap: float = 0.2,
        freeze: bool = True,
        roi: list[float] | tuple[float, float, float, float] | None = None,
    ) -> dict[str, Any]:
        """弹窗「实时检测」预览：用示例框在画面上跑一次检测。

        `freeze=True`（默认）时，同一个 previewId 只取一次帧：之后标注/调参/检测都
        基于这张静态图，画面不会动、框也不会闪；`freeze=False` 才用实时帧。
        """
        from ..core.yolo import YOLO_MANAGER

        if self.session.last_frame is None:
            raise RuntimeError("还没有可用画面：先连接设备、等画面出来")
        if not examples:
            raise RuntimeError("先框一个示例")
        safe = "".join(ch for ch in preview_id if ch.isalnum() or ch in "-_")[:64] or "default"
        base = os.path.join(self.session.project.templates_dir, ".ai-preview")
        target = os.path.join(base, safe)
        fresh = not os.path.isdir(target)
        os.makedirs(target, exist_ok=True)
        # 冻结帧：同一会话里复用第一次的帧；开新会话（previewId 变了）就整批换掉
        if freeze:
            frame = self.session._preview_frames.get(safe)
            if frame is None or fresh:
                frame = self.session.last_frame.copy()
                self.session._preview_frames = {safe: frame}
        else:
            frame = self.session.last_frame.copy()
            self.session._preview_frames.pop(safe, None)
        if fresh:
            # 一次只开一个弹窗：新会话开始时清掉旧的参考图
            for entry in os.listdir(base):
                stale = os.path.join(base, entry)
                if entry != safe and os.path.isdir(stale):
                    with contextlib.suppress(OSError):
                        shutil.rmtree(stale)
        prepared: list[dict[str, Any]] = []
        for index, item in enumerate(examples):
            rect = item.get("rect")
            if not isinstance(rect, (list, tuple)) or len(rect) != 4:
                continue
            path = os.path.join(target, f"{index}.png")
            example_image = _decode_frame_data_url(item.get("image"))
            if example_image is not None:
                # 每个示例自己的快照：逐帧覆盖写，保证换框后参考图跟着换
                cv2.imwrite(path, example_image)
            elif not os.path.exists(path) and not cv2.imwrite(path, frame):
                raise RuntimeError("预览参考图保存失败")
            prepared.append({"path": path, "rect": [float(v) for v in rect], "label": str(item.get("label") or "目标")})
        if not prepared:
            raise RuntimeError("示例框不合法")
        height, width = frame.shape[:2]
        region = None
        if roi is not None:
            try:
                region = Rect.parse(roi).clamp()
            except (TypeError, ValueError, KeyError):
                raise RuntimeError("ROI 必须是 [x, y, w, h] 数组") from None
            if region.w <= 0 or region.h <= 0:
                raise RuntimeError("ROI 搜索区域为空")
        # 示例框和 YOLOE 视觉提示都是整帧归一化坐标；预览也必须整帧推理，
        # 不能裁 ROI 后继续传原坐标，否则预览框与保存后的运行时坐标系不一致。
        started = time.perf_counter()
        dets, queue_ms, infer_ms = YOLO_MANAGER.preview(
            frame, 
            prepared,
            conf=float(conf),
            iou=float(iou),
            imgsz=int(imgsz),
            tile=bool(tile),
            tile_size=int(tile_size),
            tile_overlap=float(tile_overlap),
        )
        if region is not None:
            x0, y0, rw, rh = region.to_pixels((width, height))
            filtered: list[dict[str, Any]] = []
            for det in dets:
                box = det.get("bbox")
                if not isinstance(box, list) or len(box) != 4:
                    continue
                cx = (float(box[0]) + float(box[2])) / 2
                cy = (float(box[1]) + float(box[3])) / 2
                if x0 <= cx <= x0 + rw and y0 <= cy <= y0 + rh:
                    filtered.append(det)
            dets = filtered
        return {
            "dets": dets,
            "ms": round((time.perf_counter() - started) * 1000, 1),
            "inferMs": round(infer_ms, 1),
            "queueMs": round(queue_ms, 1),
            "device": YOLO_MANAGER.device,
            "width": width,
            "height": height,
        }
