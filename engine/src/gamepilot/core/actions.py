"""基础操作（脚本里"点/滑/等"这些步骤）。

每一步是一个纯数据对象，`parse` 时就把参数校验清楚 —— 写错的脚本在**保存时**就报错，
而不是跑起来才在手机上点空。

支持的操作：

| type | 必填 | 说明 |
|---|---|---|
| `click` | `target` 或 `rect` 或 `x`+`y` | 轻触 |
| `long_press` | 同 click，可选 `duration_ms`（默认 800） | 长按 |
| `swipe` | 起点（target/rect/x+y）+ `to_x`+`to_y`，可选 `duration_ms` | 滑动 |
| `wait` | `seconds`（>0） | 等待（阻塞当前设备循环） |
| `key` | `value`（back/home/recents/power/volume_up/volume_down/enter/delete） | 功能键 |
| `text` | `value` | 输入文本 |

`wait` 之外都不阻塞：动作发出去就返回，是否切界面由边的条件在后续帧确认。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..devices.base import SUPPORTED_KEYS

ACTION_TYPES = ("click", "long_press", "swipe", "wait", "key", "text")

# 界面上给每个动作类型的中文名（前端也用这份口径）
ACTION_LABELS = {
    "click": "点击",
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
    # 参数
    duration_ms: int = 300
    seconds: float = 0.5
    value: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    # ---------------------------------------------------------------- #

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

        rect_value = spec.get("rect")
        rect: tuple[float, float, float, float] | None = None
        if isinstance(rect_value, (list, tuple)) and len(rect_value) == 4:
            rect = tuple(float(item) for item in rect_value)  # type: ignore[assignment]

        # 兜底目标只在"动作完全没给位置"时才用。
        # 否则录下来的坐标点击会被塞一个 target，执行时去点识别器中心而不是你点的那个点（踩过）
        positioned = (
            bool(spec.get("target"))
            or spec.get("rect") is not None
            or (spec.get("x") is not None and spec.get("y") is not None)
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
            # 注意：默认值不能用 `or`（0 是合法值，会被顶掉）
            duration_ms=_as_int(spec.get("duration_ms"), 300),
            seconds=_as_number(spec.get("seconds"), 0.5),
            value=str(spec.get("value", "")),
        )
        action.validate()
        return action

    def validate(self) -> None:
        if self.type in ("click", "long_press"):
            if not self._has_point():
                raise ValueError(f"{self.type} 需要 target / rect / x+y 之一作为点击位置")
            if self.type == "long_press" and self.duration_ms <= 0:
                raise ValueError("long_press.duration_ms 必须大于 0")
        elif self.type == "swipe":
            if not self._has_point():
                raise ValueError("swipe 需要起点：target / rect / x+y 之一")
            if self.to_target is None and (self.to_x is None or self.to_y is None):
                raise ValueError("swipe 需要终点：to_target 或 to_x + to_y")
            if self.duration_ms <= 0:
                raise ValueError("swipe.duration_ms 必须大于 0")
        elif self.type == "wait":
            if self.seconds <= 0:
                raise ValueError("wait.seconds 必须大于 0")
        elif self.type == "key":
            if self.value not in SUPPORTED_KEYS:
                raise ValueError(f"key.value 必须是: {', '.join(sorted(SUPPORTED_KEYS))}")
        elif self.type == "text" and not self.value:
            raise ValueError("text.value 不能为空")

    def _has_point(self) -> bool:
        if self.target:
            return True
        if self.rect is not None:
            return True
        return self.x is not None and self.y is not None

    # ---------------------------------------------------------------- #

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
        if self.type in ("click", "long_press", "swipe"):
            out["duration_ms"] = self.duration_ms
        if self.type == "wait":
            out["seconds"] = self.seconds
        if self.value:
            out["value"] = self.value
        out.update(self.extra)
        return out

    def describe(self) -> str:
        if self.type == "wait":
            return f"等待 {self.seconds:g}s"
        if self.type == "key":
            return f"按键 {self.value}"
        if self.type == "text":
            return f"输入「{self.value}」"
        start = self.target or (
            "矩形中心" if self.rect else f"({self.x:.2f}, {self.y:.2f})" if self.x is not None else "?"
        )
        if self.type == "swipe":
            end = self.to_target or f"({self.to_x:.2f}, {self.to_y:.2f})"
            return f"滑动 {start} → {end}（{self.duration_ms}ms）"
        if self.type == "long_press":
            return f"长按 {start}（{self.duration_ms}ms）"
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
