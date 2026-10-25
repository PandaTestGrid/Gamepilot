"""MaterialRecordingService: extracted session responsibility; shared state belongs to DeviceSession."""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

import cv2

from ..core.geometry import Rect
from ..core.graph import GRAPH_WRITE_LOCK, Edge, Node
from ..core.recognizer import normalize_search

if TYPE_CHECKING:
    from .device import DeviceSession

from .graph_ops import (
    next_node_id,
)
from .models import _load_graph


class MaterialRecordingService:
    def __init__(self, session: DeviceSession) -> None:
        self.session = session

    def _finish_record(
        self,
        *,
        label: str,
        spec: dict[str, Any],
        mode: str,
        search_mode: str,
        filename: str,
        rect: Rect,
        as_enter: bool,
        as_action_target: bool,
        node_id: str | None,
        node_name: str | None,
        allocate_node_id: bool,
    ) -> dict[str, Any]:
        """录制收尾（模板/颜色/OCR 共用）：注册识别器 + 建界面/边 + 落盘 + 热重载。"""
        self.session.graph.add_recognizer(label, spec)

        created_node = None
        # 步骤链工作流（含空 steps）：只落识别器 + 素材，不再建 nodes/edges
        if self.session.graph.flow is not None:
            self.session.graph.save()
            self.session.reload_graph()
            return {
                "label": label,
                "mode": mode,
                "search": search_mode,
                "template": f"templates/{filename}",
                "rect": rect.clamp().to_list(),
                "nodeId": None,
                "graph": self.session.graph.to_dict(),
            }

        if as_enter:
            if allocate_node_id:
                # "新建界面"：id 由引擎分配，绝不复用还活着的界面（见 record_template）
                node_id = next_node_id(self.session.graph)
            if node_id:
                node = self.session.graph.nodes.get(node_id) or Node(id=node_id, name=node_name or node_id, enter=[])
                if label not in node.enter:
                    node.enter.append(label)
                self.session.graph.upsert_node(node)
                created_node = node.id
                self.session._last_node_id = node.id
                self.session._last_node_at = time.time()
        # 录制流程自动接链：上一步录的动作边 → 指向这个新界面
        if created_node and self.session._pending_edge_id:
            for item in self.session.graph.edges:
                if item.id == self.session._pending_edge_id and not item.dst:
                    item.dst = created_node
            self.session._pending_edge_id = None
        # 建"动作目标"边：源必须是**图里现存的**节点。
        # `engine.current` 可能是一个已经被删掉的界面 —— 删节点不会让引擎游标回退，
        # 拿它当 from 会写出一条"from 指向不存在节点"的边，那份 graph.json 下次读就崩
        # （用户看到的是"这个工作流打不开了"）。
        source = self.session.engine.current
        if (
            as_action_target
            and source
            and source in self.session.graph.nodes
            and created_node
            and created_node != source
        ):
            self.session.graph.add_edge(
                Edge(
                    id=f"e_{label}",
                    when=label,
                    src=source,
                    dst=created_node,
                    action={"type": "click", "target": label},
                )
            )
        self.session.graph.save()
        self.session.reload_graph()
        return {
            "label": label,
            "mode": mode,  # template | color | ocr
            "search": search_mode,  # region | full（color 永远是 region）
            "template": f"templates/{filename}",
            "rect": rect.clamp().to_list(),
            # 这次挂到哪个界面上了（可能是引擎刚分配的）：界面拿它去选中/提示，
            # 不用自己猜"我传的 id 生效了没"
            "nodeId": created_node,
            "graph": self.session.graph.to_dict(),
        }

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
        allocate_node_id: bool = False,
        search: str = "region",
    ) -> dict[str, Any]:
        """从当前帧裁剪模板 → 落盘 → 注册识别器（并按需建节点/边）。

        `search`：`region`（默认）只在框选区域里找；`full` 是「这个目标可能出现在屏幕任意位置」，
        整帧搜索（命中后 rect 是它**当前**位置，所以点击仍然准）。
        纯色区域会降级成颜色识别器 —— 颜色识别不支持整帧搜索，`search` 对它无效。

        `allocate_node_id`：「这是**新**界面，id 由引擎分配」。
        界面上的 `nodeId` 是本地序号（`node_1`、`node_2`…），应用一重启就从 1 重新数，
        传下来必然撞上**上一次会话**建的界面 —— 引擎按 id 取到那个老节点，于是"我新录的界面"
        变成了老界面（用户看到的"换脸"）。所以"新建"这条路只能让引擎分配。
        """
        self.session._require_workflow()
        search_mode = normalize_search(search)
        if self.session._root_busy(self.session.project.root):
            raise ValueError("运行中不能修改流程图，请先停止")
        with self.session.lock, GRAPH_WRITE_LOCK:
            self.session.graph = _load_graph(self.session.project)
            if self.session.last_frame is None:
                raise RuntimeError("还没有可用画面，请先连接设备并等待首帧")
            x, y, w, h = rect.clamp().to_pixels(self.session.last_frame.shape[1::-1])
            crop = self.session.last_frame[y : y + h, x : x + w]
            if crop.size == 0:
                raise RuntimeError("框选区域为空")

            filename = f"{label}.png"
            # 每次录制都把裁下来的那一块存成素材（按识别器名），`templates/` 就是"录过什么"的台账；
            # 纯色区域虽然会降级成颜色识别器（用不上这张图），也照样留着 ——
            # 它是那次录制的实物证据，删除识别器时一起清掉（见 remove_recognizer）
            path = f"{self.session.project.templates_dir}/{filename}"
            if not cv2.imwrite(path, crop):
                raise RuntimeError(f"模板图写入失败：{path}")

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
                # 颜色识别不支持整帧搜索：保持原区域，不写 search
                search_mode = "region"
            else:
                spec = {
                    "type": "template",
                    "template": f"templates/{filename}",
                    "threshold": round(float(threshold), 4),
                    "roi": rect.clamp().to_list(),
                    # 录制时的像素尺寸：换分辨率（同一台设备改了投屏尺寸、或换台机器）时，
                    # 识别器按这个比例自动缩放模板，不用重新录
                    "recorded_size": [int(self.session.last_frame.shape[1]), int(self.session.last_frame.shape[0])],
                }
                if search_mode == "full":
                    # roi 保留（切回 region 时要用），搜索时由 search 决定是否忽略它
                    spec["search"] = "full"
                mode = "template"
            return self.session._finish_record(
                label=label,
                spec=spec,
                mode=mode,
                search_mode=search_mode,
                filename=filename,
                rect=rect,
                as_enter=as_enter,
                as_action_target=as_action_target,
                node_id=node_id,
                node_name=node_name,
                allocate_node_id=allocate_node_id,
            )

    def record_ocr(
        self,
        rect: Rect,
        label: str,
        text: str,
        *,
        mode: str = "contains",
        threshold: float = 0.6,
        as_enter: bool = True,
        as_action_target: bool = True,
        node_id: str | None = None,
        node_name: str | None = None,
        allocate_node_id: bool = False,
        search: str = "region",
    ) -> dict[str, Any]:
        """框一块区域 + 填要认的字 → 注册 OCR 识别器（不再只录一张图）。

        和 `record_template` 的区别：模板匹配问"这块区域长得像不像我录的那张图"，OCR 问
        "这块区域里的字是不是/包含我写的这段"。所以 OCR 不需要模板文件 —— 但**照样存一张
        截图**进 `templates/`，作为"这段识别对应屏幕哪块"的实物证据（删识别器时一起清）。

        `mode`：`contains`（默认，包含就算）/ `equals`（完全相等）/ `regex`（正则，高级用法）；
        `threshold` 是 OCR 置信度下限（默认 0.6，比模板的 0.82 低 —— 识别模型自带噪声）。
        """
        self.session._require_workflow()
        search_mode = normalize_search(search)
        if self.session._root_busy(self.session.project.root):
            raise ValueError("运行中不能修改流程图，请先停止")
        if not str(text).strip():
            raise ValueError("OCR 识别器要填写「要识别的文字」")
        with self.session.lock, GRAPH_WRITE_LOCK:
            self.session.graph = _load_graph(self.session.project)
            if self.session.last_frame is None:
                raise RuntimeError("还没有可用画面，请先连接设备并等待首帧")
            x, y, w, h = rect.clamp().to_pixels(self.session.last_frame.shape[1::-1])
            crop = self.session.last_frame[y : y + h, x : x + w]
            if crop.size == 0:
                raise RuntimeError("框选区域为空")

            filename = f"{label}.png"
            path = f"{self.session.project.templates_dir}/{filename}"
            if not cv2.imwrite(path, crop):
                raise RuntimeError(f"模板图写入失败：{path}")
            spec: dict[str, Any] = {
                "type": "ocr",
                "text": str(text),
                "mode": mode,
                "threshold": round(float(threshold), 4),
                "roi": rect.clamp().to_list(),
                # 证据截图登记成 template：界面取缩略图（`template.image`）和删识别器清文件
                # 都走同一条路。OCR 匹配不看这张图，它只负责回答"这段字对应屏幕哪块"。
                "template": f"templates/{filename}",
            }
            if search_mode == "full":
                spec["search"] = "full"
            return self.session._finish_record(
                label=label,
                spec=spec,
                mode="ocr",
                search_mode=search_mode,
                filename=filename,
                rect=rect,
                as_enter=as_enter,
                as_action_target=as_action_target,
                node_id=node_id,
                node_name=node_name,
                allocate_node_id=allocate_node_id,
            )
