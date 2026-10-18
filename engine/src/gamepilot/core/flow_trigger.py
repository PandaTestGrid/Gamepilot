"""触发器 → "下一次什么时候自动跑"（纯计算，好单测）。

步骤链的**第一步永远是触发器**（`flow_model.validate_flow` 卡的），但触发器只有真正
排期才有意义：

  - `manual`：靠界面上那个「运行」按钮，不排期；
  - `interval`（每隔一段）/ `schedule`（定时开始）：到点**自动** `start_run`。

这里只做"算下一次时刻"这一件纯计算的事；真正到点开跑在 `session._loop` 里
（它每拍问一次 `_maybe_auto_run`）。坏参数一律**不排期**，不抛异常 —— 一份写坏的
触发配置不该把整台设备的采集循环打死。
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, time, timedelta
from typing import Any

#: 会自动排期的触发器（`manual` 不排期）
AUTO_TRIGGERS = ("interval", "schedule")


def parse_hhmm(value: object) -> time | None:
    """`"06:30"` 或 `"06:30:15"` → `time`；格式/范围不对给 None。"""
    if not isinstance(value, str):
        return None
    parts = value.strip().split(":")
    if len(parts) not in (2, 3):
        return None
    try:
        hour = int(parts[0])
        minute = int(parts[1])
        second = int(parts[2]) if len(parts) == 3 else 0
    except ValueError:
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59 and 0 <= second <= 59):
        return None
    return time(hour, minute, second)


def parse_ymd(value: object) -> date | None:
    """`"2026-10-15"` → `date(2026, 10, 15)`；格式不对给 None。"""
    if not isinstance(value, str):
        return None
    parts = value.strip().split("-")
    if len(parts) != 3:
        return None
    try:
        return date(int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return None


def next_fire_at(kind: str, params: dict[str, Any], now: datetime) -> datetime | None:
    """下一次该跑的时刻；`manual` / 坏参数 / 未知类型都给 None（= 不排期）。"""
    if kind == "interval":
        every = params.get("every")
        if isinstance(every, bool) or not isinstance(every, int) or every < 1:
            return None
        unit = str(params.get("unit") or "minutes").strip().lower()
        if unit == "seconds":
            return now + timedelta(seconds=every)
        if unit == "hours":
            return now + timedelta(hours=every)
        return now + timedelta(minutes=every)

    if kind == "schedule":
        at = parse_hhmm(params.get("at"))
        if at is None:
            return None
        mode = str(params.get("mode") or "daily").strip().lower()

        if mode in ("once", "date"):
            target_date = parse_ymd(params.get("date"))
            if target_date is None:
                return None
            candidate = datetime.combine(target_date, at)
            return candidate if candidate > now else None

        if mode == "weekly":
            raw_days = params.get("weekdays")
            if not isinstance(raw_days, list):
                return None
            valid_days = {int(d) for d in raw_days if isinstance(d, int) and not isinstance(d, bool) and 1 <= d <= 7}
            if not valid_days:
                return None
            base = now.replace(hour=at.hour, minute=at.minute, second=at.second, microsecond=0)
            for offset in range(0, 8):
                candidate = base + timedelta(days=offset)
                if candidate.isoweekday() in valid_days and candidate > now:
                    return candidate
            return None

        if mode == "monthly":
            day_raw = params.get("dayOfMonth")
            if isinstance(day_raw, bool) or not isinstance(day_raw, int) or not (1 <= day_raw <= 31):
                return None
            year, month = now.year, now.month
            for _ in range(0, 13):
                max_day = calendar.monthrange(year, month)[1]
                clamped_day = min(day_raw, max_day)
                candidate = datetime(year, month, clamped_day, at.hour, at.minute, at.second)
                if candidate > now:
                    return candidate
                if month == 12:
                    year += 1
                    month = 1
                else:
                    month += 1
            return None

        # 默认 daily（每天）
        candidate = now.replace(hour=at.hour, minute=at.minute, second=at.second, microsecond=0)
        # 今天这个点已经过了就排到明天
        return candidate + timedelta(days=1) if candidate <= now else candidate
    return None


def auto_trigger(steps: list[dict[str, Any]]) -> dict[str, Any] | None:
    """步骤链第一步如果是**会自动排期**的触发器（且没被停用），就返回它；否则 None。"""
    if not steps:
        return None
    first = steps[0]
    if not isinstance(first, dict) or first.get("type") not in AUTO_TRIGGERS:
        return None
    if first.get("disabled"):
        return None  # 触发器被停用 = 不自动跑（还能点「运行」手动跑）
    return first


__all__ = ["AUTO_TRIGGERS", "auto_trigger", "next_fire_at", "parse_hhmm"]
