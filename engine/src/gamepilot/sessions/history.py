"""HistoryService: extracted session responsibility; shared state belongs to DeviceSession."""

from __future__ import annotations

import base64
from typing import TYPE_CHECKING, Any

import cv2
import numpy as np

if TYPE_CHECKING:
    from .device import DeviceSession


class HistoryService:
    def __init__(self, session: DeviceSession) -> None:
        self.session = session

    def frame_meta(self) -> dict[str, Any]:
        """帧缓冲元信息（不传图像）：界面按 index 懒加载单帧。"""
        with self.session._history_lock:
            items = list(self.session._frame_history)
        if not items:
            return {"count": 0, "firstIndex": 0, "lastIndex": 0, "width": 0, "height": 0}
        first = items[0]
        last = items[-1]
        return {
            "count": len(items),
            "firstIndex": int(first[0]),
            "lastIndex": int(last[0]),
            "width": int(last[2]),
            "height": int(last[3]),
            # 帧号可能跳号（丢帧/重连），界面按这份真实序号列表映射进度条
            "indices": [int(item[0]) for item in items],
        }

    def frame_at(self, index: int, nearest: bool = False) -> dict[str, Any]:
        """取缓冲里的某一帧（按帧序号）。

        `nearest=False`（默认）保持原语义：精确命中，已被滚出时明确报错；
        `nearest=True` 时退回**帧号最接近**的一帧：比 first 还老 → first，比 last 新 → last，
        落在跳号空隙 → 绝对差最小的一帧（缓冲为空仍然报错）。
        """
        target = int(index)
        with self.session._history_lock:
            items = list(self.session._frame_history)
        for item in reversed(items):
            if int(item[0]) == target:
                return self.session._frame_payload(item, target)
        if not items:
            raise RuntimeError("还没有可用的历史帧")
        if not nearest:
            raise RuntimeError(f"第 {index} 帧已被滚出缓冲（当前保留 {items[0][0]}~{items[-1][0]}）")
        # 帧号可能跳号（丢帧/重连），所以按绝对差取最近的；并列时取缓冲里更早的那帧
        item = min(items, key=lambda candidate: abs(int(candidate[0]) - target))
        return self.session._frame_payload(item, target)

    @staticmethod
    def _frame_payload(item: tuple[int, bytes, int, int, float], requested: int) -> dict[str, Any]:
        """单帧返回体：`requestedIndex` 是调用方请求的帧号，`index` 是实际返回的帧号。"""
        return {
            "requestedIndex": int(requested),
            "index": int(item[0]),
            "jpeg": base64.b64encode(item[1]).decode("ascii"),
            "width": int(item[2]),
            "height": int(item[3]),
            "ts": round(item[4], 3),
        }

    def frame_history(self, count: int = 20) -> list[dict[str, Any]]:
        """最近的帧（时间顺序，旧→新）：AI 标注弹窗用来前后翻页挑一帧。"""
        with self.session._history_lock:
            items = list(self.session._frame_history)[-max(1, min(int(count), self.session._history_limit)) :]
        return [
            {
                "index": index,
                "jpeg": base64.b64encode(jpeg).decode("ascii"),
                "width": width,
                "height": height,
                "ts": round(ts, 3),
            }
            for index, jpeg, width, height, ts in items
        ]

    def _encode_jpeg(self, image: np.ndarray) -> bytes:
        """编码成 JPEG 原始字节（缩到 jpeg_width）。返回空 bytes 表示编码失败。"""
        height, width = image.shape[:2]
        if self.session.jpeg_width > 0 and width > self.session.jpeg_width:
            scale = self.session.jpeg_width / float(width)
            image = cv2.resize(
                image, (self.session.jpeg_width, max(1, int(height * scale))), interpolation=cv2.INTER_AREA
            )
        ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), self.session.jpeg_quality])
        return buffer.tobytes() if ok else b""
