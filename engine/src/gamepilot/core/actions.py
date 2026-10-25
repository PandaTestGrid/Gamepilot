"""基础操作（工作流里"点/滑/等"这些步骤）。

每一步是一个纯数据对象，`parse` 时就把参数校验清楚 —— 写错的工作流在**保存时**就报错，
而不是跑起来才在手机上点空。

支持的操作：

| type | 必填 | 说明 |
|---|---|---|
| `click` | `target` 或 `rect` 或 `x`+`y` | 轻触 |
| `long_press` | 同 click，可选 `duration_ms`（默认 800） | 长按 |
| `swipe` | 起点（target/rect/x+y）+ `to_x`+`to_y`，可选 `duration_ms` / `path` / `hold_ms` | 滑动（`path`=连续轨迹，`hold_ms`=末端按住，摇杆靠这两个） |
| `wait` | `seconds`（>0） | 等待（阻塞当前设备循环） |
| `key` | `value`（手机：back/home/recents/power/volume_up/volume_down/enter/delete；Windows 窗口另有 a-z/0-9/f1-f12/space/shift/ctrl/alt/tab/escape/方向键等） | 按键 |
| `text` | `value` | 输入文本 |

`wait` 之外都不阻塞：动作发出去就返回，是否切界面由边的条件在后续帧确认。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..devices.base import ACTION_KEYS
from .bezier_trajectory import normalize_path
from .selection import SELECTION_LABELS, normalize_index, normalize_strategy

ACTION_TYPES = ("click", "double_click", "long_press", "swipe", "wait", "key", "text")


# 界面上给每个动作类型的中文名（前端也用这份口径）
def _parse_action_rect(value: object) -> tuple[float, float, float, float] | None:
    raw: list[object] | None = None
    if isinstance(value, (list, tuple)) and len(value) == 4:
        raw = list(value)
    elif isinstance(value, dict) and all(key in value for key in ("x", "y", "w", "h")):
        raw = [value["x"], value["y"], value["w"], value["h"]]
    if raw is None:
        return None
    for item in raw:
        if not isinstance(item, (int, float)) or isinstance(item, bool):
            return None
    return (float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3]))  # type: ignore[arg-type]


ACTION_LABELS = {
    "click": "点击",
    "double_click": "双击",
    "long_press": "长按",
    "swipe": "滑动",
    "wait": "等待",
    "key": "按键",
    "text": "输入文本",
}


@dataclass
class Action:
    type: str = "click"
    # 定位方式（三选一）
    target: str | None = None  # 识别器标签：点它的中心
    rect: tuple[float, float, float, float] | None = None  # 归一化矩形中心
    x: float | None = None
    y: float | None = None
    # swipe 终点
    to_x: float | None = None
    to_y: float | None = None
    to_target: str | None = None
    # swipe 连续轨迹（归一化折线，≥2 点）：给了就按轨迹走，起点/终点取首尾
    path: tuple[tuple[float, float], ...] | None = None
    # swipe 到终点后保持按住的毫秒数（摇杆"推住"）
    hold_ms: int = 0
    # 参数
    duration_ms: int = 300
    seconds: float = 0.5
    value: str = ""
    random_in_rect: bool = False
    # 同一识别器命中多个目标时点哪一个（见 core/selection.py；默认 auto = 多个就报错）
    strategy: str = "auto"
    index: int = 1
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def parse(cls, spec: object, *, fallback_target: str | None = None) -> Action:
        if spec is None:
            spec = {}
        if isinstance(spec, str):
            spec = {"type": spec, "target": fallback_target}
        if not isinstance(spec, dict):
            raise ValueError(f"action 必须是对象，收到: {type(spec).__name__}")

        kind = str(spec.get("type") or "click")
        if kind in ("", "none", "noop"):
            kind = "click"
        if kind not in ACTION_TYPES:
            raise ValueError(f"未支持的动作类型: {kind}（可用: {', '.join(ACTION_TYPES)}）")

        def number(key: str, default: float | None = None) -> float | None:
            value = spec.get(key, default)
            if value is None:
                return None
            if not isinstance(value, (int, float)):
                raise ValueError(f"{kind}.{key} 必须是数字")
            return float(value)

        rect = _parse_action_rect(spec.get("rect"))
        path = normalize_path(spec.get("path"))
        hold_ms = _as_int(spec.get("hold_ms"), 0)
        if hold_ms < 0:
            raise ValueError("swipe.hold_ms 不能为负")

        # 兜底 target 仅在没有显式坐标/rect 时使用，避免坐标点击被改点识别器中心。
        positioned = (
            bool(spec.get("target")) or rect is not None or (spec.get("x") is not None and spec.get("y") is not None)
        )
        action = cls(
            type=kind,
            target=(str(spec["target"]) if spec.get("target") else (None if positioned else fallback_target)),
            rect=rect,
            x=number("x"),
            y=number("y"),
            to_x=number("to_x", spec.get("tx")),
            to_y=number("to_y", spec.get("ty")),
            to_target=str(spec["to_target"]) if spec.get("to_target") else None,
            path=tuple(path) if path else None,
            hold_ms=hold_ms,
            # 注意：默认值不能用 `or`（0 是合法值，会被顶掉）
            duration_ms=_as_int(spec.get("duration_ms"), 300),
            seconds=_as_number(spec.get("seconds"), 0.5),
            value=str(spec.get("value", "")),
            random_in_rect=bool(spec.get("random_in_rect")),
            strategy=str(spec.get("strategy") or "auto").strip().lower(),
            index=_as_int(spec.get("index"), 1),
        )
        # 有轨迹时，起点/终点就是轨迹首尾（显式给的 x/y/to_x/to_y 优先，方便手写时少写两个字段）
        if action.path:
            first, last = action.path[0], action.path[-1]
            if action.x is None or action.y is None:
                action.x, action.y = first
            if action.to_x is None or action.to_y is None:
                action.to_x, action.to_y = last
        action.validate()
        return action

    def validate(self) -> None:
        if self.type in ("click", "double_click", "long_press"):
            if not self._has_point():
                raise ValueError(f"{self.type} 需要 target / rect / x+y 之一作为点击位置")
            if self.type == "long_press" and self.duration_ms <= 0:
                raise ValueError("long_press.duration_ms 必须大于 0")
        elif self.type == "swipe":
            if not self._has_point():
                raise ValueError("swipe 需要起点：target / rect / x+y 之一")
            if self.path is None and self.to_target is None and (self.to_x is None or self.to_y is None):
                raise ValueError("swipe 需要终点：to_target 或 to_x + to_y（或给 path 轨迹）")
            if self.duration_ms <= 0:
                raise ValueError("swipe.duration_ms 必须大于 0")
        elif self.type == "wait":
            if self.seconds <= 0:
                raise ValueError("wait.seconds 必须大于 0")
        elif self.type == "key":
            if self.value not in ACTION_KEYS:
                raise ValueError(f"key.value 必须是: {', '.join(sorted(ACTION_KEYS))}")
        elif self.type == "text" and not self.value:
            raise ValueError("text.value 不能为空")
        if self.strategy != "auto":
            self.strategy = normalize_strategy(self.strategy)
            if self.strategy == "nth":
                self.index = normalize_index(self.index)
            elif self.index < 1:
                self.index = 1

    def _has_point(self) -> bool:
        if self.target:
            return True
        if self.rect is not None:
            return True
        return self.x is not None and self.y is not None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"type": self.type}
        if self.target:
            out["target"] = self.target
        if self.rect is not None:
            out["rect"] = list(self.rect)
        if self.x is not None:
            out["x"] = self.x
        if self.y is not None:
            out["y"] = self.y
        if self.to_target:
            out["to_target"] = self.to_target
        if self.to_x is not None:
            out["to_x"] = self.to_x
        if self.to_y is not None:
            out["to_y"] = self.to_y
        if self.path:
            out["path"] = [[x, y] for x, y in self.path]
        if self.hold_ms:
            out["hold_ms"] = self.hold_ms
        if self.type in ("click", "long_press", "swipe"):
            out["duration_ms"] = self.duration_ms
        if self.type == "wait":
            out["seconds"] = self.seconds
        if self.value:
            out["value"] = self.value
        if self.strategy and self.strategy != "auto":
            out["strategy"] = self.strategy
        if self.strategy == "nth":
            out["index"] = max(1, self.index)
        out.update(self.extra)
        return out

    def describe(self) -> str:
        if self.type == "wait":
            return f"等待 {self.seconds:g}s"
        if self.type == "key":
            return f"按键 {self.value}"
        if self.type == "text":
            return f"输入「{self.value}」"
        if self.target:
            start = self.target
            if self.strategy == "nth":
                start = f"{self.target}（第 {max(1, self.index)} 个）"
            elif self.strategy and self.strategy != "auto":
                start = f"{self.target}（{SELECTION_LABELS.get(self.strategy, self.strategy)}）"
        elif self.rect is not None:
            start = "范围内随机" if self.random_in_rect else "矩形中心"
        elif self.x is not None:
            start = f"({self.x:.2f}, {self.y:.2f})"
        else:
            start = "?"
        if self.type == "swipe":
            end = self.to_target or f"({self.to_x:.2f}, {self.to_y:.2f})"
            hold = f"，按住 {self.hold_ms}ms" if self.hold_ms else ""
            if self.path:
                return f"连续滑动 {len(self.path)} 点 {start} → {end}（{self.duration_ms}ms{hold}）"
            return f"滑动 {start} → {end}（{self.duration_ms}ms{hold}）"
        if self.type == "long_press":
            return f"长按 {start}（{self.duration_ms}ms）"
        if self.type == "double_click":
            return f"双击 {start}"
        return f"点击 {start}"


def _as_int(value: object, default: int) -> int:
    if value is None:
        return default
    if not isinstance(value, (int, float)):
        raise ValueError(f"动作参数必须是数字，收到: {value!r}")
    return int(value)


def _as_number(value: object, default: float) -> float:
    if value is None:
        return default
    if not isinstance(value, (int, float)):
        raise ValueError(f"动作参数必须是数字，收到: {value!r}")
    return float(value)
