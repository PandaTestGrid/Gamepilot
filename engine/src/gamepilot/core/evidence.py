"""执行证据：每步截图 + 事件流水，落到 `<工作流>/.runs/<时间戳>/`。

为什么要有它：`core/trace.py` 只在内存里存事件与识别分数摘要（环形缓冲，进程一退就没了），
排查"这一步到底看到了什么"时缺的就是**图**和**每一步的参数**。这里把两样东西落盘：

    <工作流>/.runs/20261018-201233/
        001_s1.jpg          <- 第 1 步开始执行时的画面
        004_s4.jpg          <- 第 4 步（失败的那一步）失败瞬间的画面
        trace.jsonl         <- 与界面事件流同构的事件（含 extra）

只保留最近 `keep` 次运行（默认 10）：截图很占地方，而排查通常只看最近几次。
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)

#: 落盘目录名（在工作流根下）
RUNS_DIR = ".runs"

#: 保留最近几次运行（多出来的按目录名（时间戳）从旧到新删）
DEFAULT_KEEP = 10

#: JPEG 质量：证据图是给人看的，80 足够了（再高只是把磁盘吃满）
JPEG_QUALITY = 80


class RunEvidence:
    """一次运行（一个工作流的一次执行）的证据目录。"""

    def __init__(self, root: str | Path, *, keep: int = DEFAULT_KEEP, stamp: str | None = None) -> None:
        self.root = Path(root)
        self.keep = max(1, keep)
        self.started_at = time.time()
        self.dir = self.root / RUNS_DIR / (stamp or time.strftime("%Y%m%d-%H%M%S"))
        self.dir.mkdir(parents=True, exist_ok=True)
        self._events = (self.dir / "trace.jsonl").open("a", encoding="utf-8")
        self._steps: list[dict[str, Any]] = []
        self._prune()

    # ---- 写 ----

    def event(self, payload: dict[str, Any]) -> None:
        """追加一条事件（和 `TraceEvent.to_dict()` 同构）。"""
        try:
            self._events.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
            self._events.flush()
        except (OSError, ValueError) as error:  # pragma: no cover - 磁盘满/路径被删
            logger.warning("证据事件写不进去: %s", error)

    def step(
        self,
        index: int,
        step_id: str,
        kind: str,
        image: np.ndarray | None = None,
        *,
        tag: str = "start",
        message: str = "",
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """记一步：写一张截图（可选）+ 一条步记录，返回到写进 `to_dict()["steps"]` 的那条。"""
        shot = ""
        if image is not None and image.size:
            name = f"{index:03d}_{tag}_{_safe_name(step_id)}.jpg"
            path = self.dir / name
            try:
                ok, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
                if ok:
                    path.write_bytes(buf.tobytes())
                    shot = name
            except (OSError, cv2.error) as error:  # pragma: no cover - 编码失败不致命
                logger.warning("证据截图写不进去: %s", error)
        record: dict[str, Any] = {
            "index": index,
            "stepId": step_id,
            "kind": kind,
            "ts": round(time.time(), 3),
            "screenshot": shot,
            "message": message,
            "params": params or None,
            # 这几个由 `merge()` 在动作真正执行 / 完成 / 失败时补上
            "result": "",
            "score": None,
            "matchedRect": None,
            "durationMs": None,
        }
        self._steps.append(record)
        return record

    def merge(self, index: int, fields: dict[str, Any]) -> None:
        """给最近一条同一步号的记录补字段（参数在开始拍、分数与耗时之后才有）。"""
        for record in reversed(self._steps):
            if record["index"] != index:
                continue
            record.update({key: value for key, value in fields.items() if value is not None})
            return

    def close(self) -> None:
        if not self._events.closed:
            self._events.close()

    # ---- 读 ----

    def to_dict(self) -> dict[str, Any]:
        return {
            "dir": self.rel_dir,
            "steps": list(self._steps),
        }

    @property
    def rel_dir(self) -> str:
        """相对工作流根目录的路径（前端显示用，不暴露本机绝对路径）。"""
        try:
            return str(self.dir.relative_to(self.root))
        except ValueError:  # pragma: no cover - 目录不在根下（测试里可能用别的目录）
            return self.dir.name

    def image_bytes(self, name: str) -> bytes | None:
        """按文件名取截图字节；名字只允许单层文件名（防目录穿越）。"""
        candidate = (self.dir / Path(name).name).resolve()
        if candidate.parent != self.dir.resolve() or candidate.suffix.lower() not in (".jpg", ".jpeg", ".png"):
            return None
        try:
            return candidate.read_bytes()
        except OSError:
            return None

    # ---- 内部 ----

    def _prune(self) -> None:
        try:
            runs = sorted(item for item in self.root.joinpath(RUNS_DIR).iterdir() if item.is_dir())
        except OSError:  # pragma: no cover - 目录刚建好
            return
        for old in runs[: max(0, len(runs) - self.keep)]:
            if old == self.dir:
                continue
            _remove_tree(old)


def _safe_name(text: str) -> str:
    """步骤 id 可能带 `/`、空格、中文：压成一个能当文件名的片段。"""
    cleaned = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in text.strip())
    return (cleaned or "step")[:40]


def _remove_tree(path: Path) -> None:
    try:
        for child in path.iterdir():
            if child.is_file():
                child.unlink()
        path.rmdir()
    except OSError as error:  # pragma: no cover - 被占用就下次再删
        logger.warning("清理旧证据目录失败 %s: %s", path, error)
