"""拟人滑动轨迹：贝塞尔曲线 + 变速采样。

思路来自常见的「人手滑动」模拟（高阶贝塞尔控制点 + 缓动），但按路径方向参数化，
竖滑/斜滑都能用；原始实现按 X 轴取样，竖滑会除零。
"""

from __future__ import annotations

import logging
import math
import random
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

Point = tuple[float, float]
TouchFn = Callable[[str, float, float], None]

logger = logging.getLogger(__name__)

EASING_LINEAR = "linear"
EASING_IN = "ease_in"
EASING_OUT = "ease_out"
EASING_IN_OUT = "ease_in_out"

EASING_ALIASES: dict[object, str] = {
    0: EASING_LINEAR,
    1: EASING_IN,
    2: EASING_OUT,
    3: EASING_IN_OUT,
    "0": EASING_LINEAR,
    "1": EASING_IN,
    "2": EASING_OUT,
    "3": EASING_IN_OUT,
    "linear": EASING_LINEAR,
    "ease_in": EASING_IN,
    "ease_out": EASING_OUT,
    "ease_in_out": EASING_IN_OUT,
}


@dataclass(frozen=True)
class SwipeBezierConfig:
    enabled: bool = True
    order: int = 3
    deviation_px: float = 6.0
    bias: float = 0.5
    easing: str = EASING_IN_OUT
    end_wobble: int = 0
    end_wobble_px: float = 12.0


DEFAULT_SWIPE_BEZIER = SwipeBezierConfig()


@dataclass(frozen=True)
class ClickHumanConfig:
    jitter_px: float = 3.0
    duration_ms: int = 50
    micro_px: float = 2.0
    delay_jitter_ms: int = 30


DEFAULT_CLICK_HUMAN = ClickHumanConfig()

# 与 click_jitter_px 同一套：按 1000px 屏宽把像素换成归一化坐标
_PX_BASE = 1000.0


def _as_bool(value: object, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("1", "true", "yes", "on"):
            return True
        if text in ("0", "false", "no", "off", ""):
            return False
    return fallback


def _as_number(value: object, fallback: float) -> float:
    if isinstance(value, bool) or value is None:
        return fallback
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except ValueError:
            return fallback
    return fallback


def _as_int(value: object, fallback: int) -> int:
    return round(_as_number(value, float(fallback)))


def normalize_easing(value: object, fallback: str = EASING_IN_OUT) -> str:
    if value is None:
        return fallback
    mapped = EASING_ALIASES.get(value)
    if mapped:
        return mapped
    if isinstance(value, str):
        mapped = EASING_ALIASES.get(value.strip().lower())
        if mapped:
            return mapped
    return fallback


def ease(t: float, kind: str) -> float:
    t = min(1.0, max(0.0, t))
    if kind == EASING_IN:
        return t * t
    if kind == EASING_OUT:
        return 1.0 - (1.0 - t) * (1.0 - t)
    if kind == EASING_IN_OUT:
        return t * t * (3.0 - 2.0 * t)
    return t


def _pick(defaults: dict[str, Any], key: str, fallback: object) -> object:
    """拟人参数只有一个来源：工作流的全局设置。

    节点/边上写的同名字段一律忽略（老 `graph.json` 里残留的也不再生效）——
    同一份工作流的拟人风格必须一致，不能这一步 3px、那一步 40px。
    """
    if key in defaults and defaults[key] is not None and defaults[key] != "":
        return defaults[key]
    return fallback


def resolve_swipe_bezier(step: dict[str, Any] | None, defaults: dict[str, Any] | None) -> SwipeBezierConfig:
    """只看 `graph.defaults`；`step` 参数保留只为兼容调用方（节点级值不生效）。"""
    global_cfg = defaults or {}
    enabled = _as_bool(
        _pick(global_cfg, "swipe_bezier", DEFAULT_SWIPE_BEZIER.enabled),
        DEFAULT_SWIPE_BEZIER.enabled,
    )
    order = max(
        1,
        min(
            8,
            _as_int(
                _pick(global_cfg, "swipe_bezier_order", DEFAULT_SWIPE_BEZIER.order),
                DEFAULT_SWIPE_BEZIER.order,
            ),
        ),
    )
    deviation_px = max(
        0.0,
        _as_number(
            _pick(global_cfg, "swipe_bezier_deviation_px", DEFAULT_SWIPE_BEZIER.deviation_px),
            DEFAULT_SWIPE_BEZIER.deviation_px,
        ),
    )
    bias = min(
        0.95,
        max(
            0.05,
            _as_number(
                _pick(global_cfg, "swipe_bezier_bias", DEFAULT_SWIPE_BEZIER.bias),
                DEFAULT_SWIPE_BEZIER.bias,
            ),
        ),
    )
    easing = normalize_easing(
        _pick(global_cfg, "swipe_easing", DEFAULT_SWIPE_BEZIER.easing),
        DEFAULT_SWIPE_BEZIER.easing,
    )
    end_wobble = max(
        0,
        min(
            8,
            _as_int(
                _pick(global_cfg, "swipe_end_wobble", DEFAULT_SWIPE_BEZIER.end_wobble),
                DEFAULT_SWIPE_BEZIER.end_wobble,
            ),
        ),
    )
    end_wobble_px = max(
        0.0,
        _as_number(
            _pick(global_cfg, "swipe_end_wobble_px", DEFAULT_SWIPE_BEZIER.end_wobble_px),
            DEFAULT_SWIPE_BEZIER.end_wobble_px,
        ),
    )
    return SwipeBezierConfig(
        enabled=enabled,
        order=order,
        deviation_px=deviation_px,
        bias=bias,
        easing=easing,
        end_wobble=end_wobble,
        end_wobble_px=end_wobble_px,
    )


def resolve_click_human(step: dict[str, Any] | None, defaults: dict[str, Any] | None) -> ClickHumanConfig:
    """点击拟人参数只看 `graph.defaults`；节点级值不再生效（见 `_pick`）。"""
    global_cfg = defaults or {}
    jitter_px = max(
        0.0,
        _as_number(
            _pick(global_cfg, "click_jitter_px", DEFAULT_CLICK_HUMAN.jitter_px),
            DEFAULT_CLICK_HUMAN.jitter_px,
        ),
    )
    duration_ms = max(
        10,
        _as_int(
            _pick(global_cfg, "tap_duration_ms", DEFAULT_CLICK_HUMAN.duration_ms),
            DEFAULT_CLICK_HUMAN.duration_ms,
        ),
    )
    micro_px = max(
        0.0,
        _as_number(
            _pick(global_cfg, "click_micro_px", DEFAULT_CLICK_HUMAN.micro_px),
            DEFAULT_CLICK_HUMAN.micro_px,
        ),
    )
    delay_jitter_ms = max(
        0,
        _as_int(
            _pick(global_cfg, "delay_jitter_ms", DEFAULT_CLICK_HUMAN.delay_jitter_ms),
            DEFAULT_CLICK_HUMAN.delay_jitter_ms,
        ),
    )
    return ClickHumanConfig(
        jitter_px=jitter_px,
        duration_ms=duration_ms,
        micro_px=micro_px,
        delay_jitter_ms=delay_jitter_ms,
    )


def apply_point_jitter(point: Point, jitter_px: float) -> Point:
    if jitter_px <= 0:
        return point
    delta = jitter_px / _PX_BASE
    return (
        _clamp_unit(point[0] + random.uniform(-delta, delta)),
        _clamp_unit(point[1] + random.uniform(-delta, delta)),
    )


def generate_tap_track(point: Point, *, duration: float, micro_px: float, order: int = 2) -> list[Point]:
    """按住期间触点微移：落点附近一小段闭合贝塞尔，走 scrcpy/HID 的 move。"""
    deviation = max(0.0, micro_px) / _PX_BASE
    if deviation <= 0:
        return [point]
    controls: list[Point] = [point]
    for _ in range(max(1, order)):
        angle = random.random() * math.tau
        mag = deviation * (0.35 + 0.65 * random.random())
        controls.append((_clamp_unit(point[0] + math.cos(angle) * mag), _clamp_unit(point[1] + math.sin(angle) * mag)))
    controls.append(point)
    count = max(4, int(max(0.03, duration) / 0.016))
    return _sample_curve(controls, count, EASING_IN_OUT)


def _clamp_unit(value: float) -> float:
    return min(1.0, max(0.0, value))


def _bezier_point(controls: Sequence[Point], t: float) -> Point:
    n = len(controls) - 1
    if n <= 0:
        return controls[0]
    t = min(1.0, max(0.0, t))
    x = 0.0
    y = 0.0
    one_minus = 1.0 - t
    for index, (px, py) in enumerate(controls):
        basis = math.comb(n, index) * (t**index) * (one_minus ** (n - index))
        x += px * basis
        y += py * basis
    return (x, y)


def _control_points(start: Point, end: Point, config: SwipeBezierConfig) -> list[Point]:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = math.hypot(dx, dy)
    if length <= 1e-9 or config.order <= 1:
        return [start, end]
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    deviation = config.deviation_px / _PX_BASE
    spans = config.order - 1
    width = max(0.04, (1.0 - config.bias) / spans)
    points: list[Point] = [start]
    sign = random.choice((-1.0, 1.0))
    for index in range(spans):
        lo = min(0.96, max(0.04, config.bias + width * index))
        hi = min(0.98, max(lo + 0.02, config.bias + width * (index + 1)))
        t = random.uniform(lo, hi)
        mag = deviation * (0.55 + 0.45 * random.random()) if deviation > 0 else 0.0
        points.append((start[0] + dx * t + sign * mag * px, start[1] + dy * t + sign * mag * py))
        if index % 2 == 1:
            sign = -sign
    points.append(end)
    return points


def _sample_curve(controls: Sequence[Point], count: int, easing_kind: str) -> list[Point]:
    count = max(2, count)
    out: list[Point] = []
    for index in range(count):
        t = ease(index / (count - 1), easing_kind)
        x, y = _bezier_point(controls, t)
        out.append((_clamp_unit(x), _clamp_unit(y)))
    out[0] = (_clamp_unit(controls[0][0]), _clamp_unit(controls[0][1]))
    out[-1] = (_clamp_unit(controls[-1][0]), _clamp_unit(controls[-1][1]))
    return out


def generate_swipe_track(
    start: Point,
    end: Point,
    *,
    duration: float,
    config: SwipeBezierConfig | None = None,
) -> list[Point]:
    cfg = config or DEFAULT_SWIPE_BEZIER
    duration = max(0.05, duration)
    total = max(8, int(duration / 0.016))
    track = _sample_curve(_control_points(start, end, cfg), total, cfg.easing)
    wobble_n = 0
    if cfg.end_wobble > 0 and cfg.end_wobble_px > 0:
        wobble_n = max(2, round(total * 0.2 / (cfg.end_wobble + 1)))
    if wobble_n <= 0:
        return track

    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = math.hypot(dx, dy) or 1.0
    ux, uy = dx / length, dy / length
    amp0 = cfg.end_wobble_px / _PX_BASE
    cursor = end
    for wave in range(cfg.end_wobble):
        amp = amp0 * (1.0 - wave / max(1, cfg.end_wobble))
        direction = 1.0 if wave % 2 == 0 else -1.0
        target = (_clamp_unit(end[0] + direction * amp * ux), _clamp_unit(end[1] + direction * amp * uy))
        track.extend(_sample_curve([cursor, target], wobble_n, EASING_LINEAR)[1:])
        cursor = target
    track.extend(_sample_curve([cursor, end], wobble_n, EASING_LINEAR)[1:])
    track[-1] = (_clamp_unit(end[0]), _clamp_unit(end[1]))
    return track


def resolve_swipe_points(
    start: Point,
    end: Point,
    duration: float,
    path: Sequence[Point] | None,
) -> list[Point]:
    if path and len(path) >= 2:
        return [(_clamp_unit(x), _clamp_unit(y)) for x, y in path]
    steps = max(4, int(max(0.05, duration) / 0.02))
    return [
        (start[0] + (end[0] - start[0]) * index / steps, start[1] + (end[1] - start[1]) * index / steps)
        for index in range(steps + 1)
    ]


def normalize_path(raw: object) -> list[Point] | None:
    """把 step/action 里的 `path` 收成归一化折线。

    接受 `[[x, y], …]` 或 `[{"x": …, "y": …}, …]`；坐标钳到 [0,1]、丢掉连续重复点。
    少于两个点（或格式不对）返回 `None` —— 调用方按"没给轨迹"处理，不抛。
    """
    if not isinstance(raw, (list, tuple)) or len(raw) < 2:
        return None
    points: list[Point] = []
    for item in raw:
        x: object | None = None
        y: object | None = None
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            x, y = item[0], item[1]
        elif isinstance(item, dict) and "x" in item and "y" in item:
            x, y = item["x"], item["y"]
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            return None
        if isinstance(x, bool) or isinstance(y, bool):
            return None
        point = (_clamp_unit(float(x)), _clamp_unit(float(y)))
        if not points or point != points[-1]:
            points.append(point)
    return points if len(points) >= 2 else None


def _resample_uniform(points: Sequence[Point], count: int) -> list[Point]:
    """按弧长等分重采样（保留首尾与形状，用于点数过多时降采样）。"""
    count = max(2, count)
    lengths: list[float] = []
    total = 0.0
    for index in range(1, len(points)):
        segment = math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1])
        lengths.append(segment)
        total += segment
    if total <= 1e-12:
        return [points[0], points[-1]]
    out = [points[0]]
    step = total / (count - 1)
    target = step
    walked = 0.0
    index = 0
    while len(out) < count - 1 and index < len(lengths):
        while index < len(lengths) and walked + lengths[index] < target:
            walked += lengths[index]
            index += 1
        if index >= len(lengths):
            break
        remain = target - walked
        ratio = remain / lengths[index] if lengths[index] > 0 else 0.0
        start, end = points[index], points[index + 1]
        out.append((start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio))
        target += step
    out.append(points[-1])
    return out


class ActionDeferredError(RuntimeError):
    """输入通道暂被手动手势占用：下一帧重新感知后再尝试，不算失败。"""


class ActionCancelledError(RuntimeError):
    """协作取消：不是设备失败，调用方不应重试或继续发送输入。"""


def _check_cancelled(cancel_event: threading.Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise ActionCancelledError("设备动作已取消")


def _wait(seconds: float, cancel_event: threading.Event | None) -> None:
    if cancel_event is None:
        time.sleep(seconds)
    elif cancel_event.wait(seconds):
        raise ActionCancelledError("设备动作已取消")


def play_swipe_path(
    touch: TouchFn,
    points: Sequence[Point],
    duration: float,
    hold: float = 0.0,
    *,
    cancel_event: threading.Event | None = None,
) -> None:
    """逐点注入 `down → move… → up`。

    时序**按弧长分配**而不是每段均分：曲线采样点常在拐弯处变密，均分会让拐弯处莫名变慢。
    `hold` 是抬手前的按住时长（摇杆"推住"就靠它）。
    """
    _check_cancelled(cancel_event)
    if not points:
        return
    points = list(points)
    duration = max(0.05, duration)
    if len(points) == 1:
        play_tap(touch, points[0], duration + max(0.0, hold), cancel_event=cancel_event)
        return
    # 每段至少 2ms，点数超过这个预算就先按弧长降采样（形状不变，采样变稀）
    budget = max(2, int(duration / 0.002) + 1)
    if len(points) > budget:
        points = _resample_uniform(points, budget)
    segments = [
        math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1])
        for index in range(1, len(points))
    ]
    total = sum(segments)
    per_unit = duration / total if total > 1e-9 else 0.0
    _check_cancelled(cancel_event)
    last = points[0]
    try:
        touch("down", last[0], last[1])
        for index, point in enumerate(points[1:], start=1):
            _check_cancelled(cancel_event)
            last = point
            touch("move", point[0], point[1])
            _wait(segments[index - 1] * per_unit if total > 1e-9 else duration / (len(points) - 1), cancel_event)
        if hold > 0:
            _wait(hold, cancel_event)
        _check_cancelled(cancel_event)
    finally:
        touch("up", last[0], last[1])


def execute_drag(
    controller: object,
    points: Sequence[Point],
    duration: float,
    hold_ms: int = 0,
    *,
    cancel_event: threading.Event | None = None,
) -> None:
    """按显式轨迹连续拖动（连续滑动 / 摇杆）。

    优先走实时触控通道（`controller.touch`：scrcpy/HID/CGEvent），这样"按住"是真的按住；
    只有合成通道的设备退回一次 `swipe(path=…)`，按住时间会被并进滑动时长（并告警）。
    """
    _check_cancelled(cancel_event)
    normalized = normalize_path(list(points)) or list(points)
    if len(normalized) < 2:
        raise ValueError("连续滑动至少需要两个轨迹点")
    duration = max(0.05, duration)
    hold = max(0, hold_ms) / 1000.0
    touch = getattr(controller, "touch", None)
    if callable(touch):
        play_swipe_path(touch, normalized, duration, hold, cancel_event=cancel_event)
        return
    swipe = getattr(controller, "swipe", None)
    if not callable(swipe):
        raise RuntimeError("这个设备不支持滑动")
    if hold > 0:
        logger.warning("设备没有实时触控通道，hold_ms 被并入滑动时长（不是真按住）")
    start, end = normalized[0], normalized[-1]
    kwargs: dict[str, Any] = {"duration": duration + hold, "path": list(normalized)}
    _check_cancelled(cancel_event)
    try:
        swipe(start[0], start[1], end[0], end[1], **kwargs)
    except TypeError:
        _check_cancelled(cancel_event)
        swipe(start[0], start[1], end[0], end[1], duration=duration + hold)
    _check_cancelled(cancel_event)


def apply_controller_swipe(
    controller: object,
    start: Point,
    end: Point,
    duration: float,
    path: Sequence[Point] | None,
    *,
    cancel_event: threading.Event | None = None,
) -> None:
    _check_cancelled(cancel_event)
    swipe = getattr(controller, "swipe", None)
    if not callable(swipe):
        raise RuntimeError("这个设备不支持滑动")
    duration = max(0.05, duration)
    kwargs: dict[str, Any] = {"duration": duration}
    if path:
        kwargs["path"] = list(path)
    try:
        swipe(start[0], start[1], end[0], end[1], **kwargs)
    except TypeError:
        _check_cancelled(cancel_event)
        swipe(start[0], start[1], end[0], end[1], duration=duration)
    _check_cancelled(cancel_event)


def execute_swipe(
    controller: object,
    start: Point,
    end: Point,
    duration: float,
    spec: dict[str, Any] | None = None,
    defaults: dict[str, Any] | None = None,
    *,
    path: object | None = None,
    hold_ms: int = 0,
    cancel_event: threading.Event | None = None,
) -> None:
    """一次滑动；可选取消信号优先使用实时 touch，合成调用只能在返回后检查取消。"""
    _check_cancelled(cancel_event)
    explicit = normalize_path(path)
    if explicit is not None:
        execute_drag(controller, explicit, duration, hold_ms, cancel_event=cancel_event)
        return
    cfg = resolve_swipe_bezier(spec, defaults)
    track = generate_swipe_track(start, end, duration=duration, config=cfg) if cfg.enabled else None
    if hold_ms > 0 or (cancel_event is not None and callable(getattr(controller, "touch", None))):
        # 可取消路径不能困在同步 controller.swipe 内；无取消信号仍沿用原分发方式。
        points = track or ([start, end] if cancel_event is None else resolve_swipe_points(start, end, duration, None))
        execute_drag(controller, points, duration, hold_ms, cancel_event=cancel_event)
        return
    apply_controller_swipe(controller, start, end, duration, track, cancel_event=cancel_event)


def play_tap(
    touch: TouchFn,
    point: Point,
    duration: float,
    path: Sequence[Point] | None = None,
    *,
    cancel_event: threading.Event | None = None,
) -> None:
    """scrcpy / HID 点击：down →（可选微移）→ up，不用 adb/WDA。"""
    _check_cancelled(cancel_event)
    if path and len(path) >= 2:
        play_swipe_path(touch, path, duration, cancel_event=cancel_event)
        return
    try:
        touch("down", point[0], point[1])
        _wait(max(0.01, duration), cancel_event)
        _check_cancelled(cancel_event)
    finally:
        touch("up", point[0], point[1])


def apply_controller_click(
    controller: object,
    point: Point,
    duration: float,
    path: Sequence[Point] | None,
    *,
    cancel_event: threading.Event | None = None,
) -> None:
    _check_cancelled(cancel_event)
    touch = getattr(controller, "touch", None)
    if cancel_event is not None and callable(touch):
        play_tap(touch, point, duration, path, cancel_event=cancel_event)
        return
    click = getattr(controller, "click", None)
    if not callable(click):
        raise RuntimeError("这个设备不支持点击")
    duration = max(0.01, duration)
    kwargs: dict[str, Any] = {"duration": duration}
    if path:
        kwargs["path"] = list(path)
    try:
        click(point[0], point[1], **kwargs)
    except TypeError:
        _check_cancelled(cancel_event)
        click(point[0], point[1])
    _check_cancelled(cancel_event)


def execute_tap(
    controller: object,
    point: Point,
    spec: dict[str, Any] | None = None,
    defaults: dict[str, Any] | None = None,
    *,
    duration_ms: int | None = None,
    count: int = 1,
    cancel_event: threading.Event | None = None,
) -> None:
    _check_cancelled(cancel_event)
    cfg = resolve_click_human(spec, defaults)
    landed = apply_point_jitter(point, cfg.jitter_px)
    hold_ms = duration_ms if duration_ms is not None else cfg.duration_ms
    hold_ms = max(10, hold_ms)
    if cfg.delay_jitter_ms > 0:
        hold_ms = max(10, round(hold_ms + random.uniform(-cfg.delay_jitter_ms, cfg.delay_jitter_ms)))
    duration = hold_ms / 1000.0
    path = generate_tap_track(landed, duration=duration, micro_px=cfg.micro_px) if cfg.micro_px > 0 else None
    gap = max(0.03, min(0.08, duration))
    for index in range(max(1, count)):
        _check_cancelled(cancel_event)
        apply_controller_click(controller, landed, duration, path, cancel_event=cancel_event)
        if index + 1 < count:
            _wait(gap, cancel_event)
