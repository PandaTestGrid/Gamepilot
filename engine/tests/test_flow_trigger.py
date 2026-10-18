"""触发器排期（flow_trigger.py）：把"下一次什么时候跑"这件事钉死。

这里只测纯计算 —— 真正到点开跑是会话层的事（见 test_session_flow_trigger.py）。
"""

from __future__ import annotations

from datetime import datetime, timedelta

from gamepilot.core.flow_trigger import auto_trigger, next_fire_at, parse_hhmm


def test_parse_hhmm_accepts_valid_and_rejects_junk() -> None:
    parsed = parse_hhmm("06:30")
    assert parsed is not None
    assert (parsed.hour, parsed.minute) == (6, 30)
    assert parse_hhmm("23:59") is not None
    for junk in ("24:00", "6", "aa:bb", "", 6, None):
        assert parse_hhmm(junk) is None


def test_interval_fires_one_period_later() -> None:
    now = datetime(2026, 10, 13, 9, 0, 0)
    assert next_fire_at("interval", {"every": 30}, now) == now + timedelta(minutes=30)


def test_schedule_picks_today_when_still_ahead_else_tomorrow() -> None:
    ahead = datetime(2026, 10, 13, 5, 0, 0)
    assert next_fire_at("schedule", {"at": "06:00"}, ahead) == datetime(2026, 10, 13, 6, 0, 0)
    passed = datetime(2026, 10, 13, 7, 0, 0)
    assert next_fire_at("schedule", {"at": "06:00"}, passed) == datetime(2026, 10, 14, 6, 0, 0)


def test_manual_and_bad_params_never_schedule() -> None:
    now = datetime(2026, 10, 13, 9, 0, 0)
    assert next_fire_at("manual", {}, now) is None
    assert next_fire_at("interval", {"every": 0}, now) is None
    assert next_fire_at("interval", {"every": "30"}, now) is None
    assert next_fire_at("schedule", {"at": "99:99"}, now) is None
    assert next_fire_at("schedule", {}, now) is None


def test_auto_trigger_only_matches_auto_kinds() -> None:
    assert auto_trigger([{"id": "t", "type": "manual", "params": {}}]) is None
    assert auto_trigger([{"id": "t", "type": "interval", "params": {"every": 5}}]) is not None
    assert auto_trigger([]) is None


def test_disabled_trigger_does_not_schedule() -> None:
    """触发器被停用 = 不自动跑（手动「运行」仍然可以）。"""
    assert auto_trigger([{"id": "t", "type": "interval", "params": {"every": 5}, "disabled": True}]) is None
    assert auto_trigger([{"id": "t", "type": "interval", "params": {"every": 5}}]) is not None


def test_schedule_once_date_and_weekly_and_monthly_and_interval_units() -> None:
    now = datetime(2026, 10, 14, 10, 0, 0)  # Wednesday (isoweekday = 3)
    assert next_fire_at("schedule", {"mode": "once", "date": "2026-10-15", "at": "08:30"}, now) == datetime(
        2026, 10, 15, 8, 30, 0
    )
    assert next_fire_at("schedule", {"mode": "once", "date": "2026-10-13", "at": "08:30"}, now) is None
    assert next_fire_at("schedule", {"mode": "weekly", "weekdays": [5], "at": "09:00"}, now) == datetime(
        2026, 10, 16, 9, 0, 0
    )
    assert next_fire_at("schedule", {"mode": "monthly", "dayOfMonth": 20, "at": "12:00"}, now) == datetime(
        2026, 10, 20, 12, 0, 0
    )
    assert next_fire_at("interval", {"every": 45, "unit": "seconds"}, now) == now + timedelta(seconds=45)
    assert next_fire_at("interval", {"every": 2, "unit": "hours"}, now) == now + timedelta(hours=2)
