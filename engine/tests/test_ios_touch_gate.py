"""HID 触摸的 auth gate 约束（iOS 27 之前不可用）。"""
from __future__ import annotations

from gamepilot.devices import ios


def test_touch_gate_blocked_message_is_actionable() -> None:
    """必须说明"为什么触摸不生效"和"哪些能力还在"，不能只报错。"""
    text = ios.TOUCH_GATE_BLOCKED
    assert "9021" in text
    assert "auth gate" in text
    assert "Indigo" in text, "要告诉用户硬件按键仍然可用"
    assert "截图" in text


def test_controller_exposes_touch_gate_when_created() -> None:
    ctrl = ios.IosController(udid="UDID-X")
    assert ctrl.touch_gate_note == ""
    assert ctrl.to_dict()["touchGate"] is None
