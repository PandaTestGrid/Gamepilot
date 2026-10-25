"""把「录操作」的动作 spec 转成 flow.steps 里的一步（与 FlowEngine._spec_for 字段对齐）。"""

from __future__ import annotations

import secrets
from typing import Any

from .actions import Action


def new_record_step_id() -> str:
    return f"s_rec_{secrets.token_hex(4)}"


def action_to_flow_step(action: Action, *, step_id: str | None = None) -> dict[str, Any]:
    sid = step_id or new_record_step_id()
    if action.type == "click":
        if action.target:
            params: dict[str, Any] = {"by": "recognizer", "rec": action.target}
        else:
            params = {
                "by": "coord",
                "x": action.x if action.x is not None else 0.5,
                "y": action.y if action.y is not None else 0.5,
            }
        return {"id": sid, "type": "click", "params": params}
    if action.type == "long_press":
        return {
            "id": sid,
            "type": "hold",
            "params": {
                "x": action.x if action.x is not None else 0.5,
                "y": action.y if action.y is not None else 0.5,
                "duration_ms": action.duration_ms,
            },
        }
    if action.type == "swipe":
        params = {
            "x": action.x if action.x is not None else 0.5,
            "y": action.y if action.y is not None else 0.5,
            "to_x": action.to_x if action.to_x is not None else 0.5,
            "to_y": action.to_y if action.to_y is not None else 0.5,
            "duration_ms": action.duration_ms,
        }
        if action.target:
            params["rec"] = action.target
        if action.path:
            params["path"] = [[x, y] for x, y in action.path]
        if action.hold_ms:
            params["hold_ms"] = action.hold_ms
        return {"id": sid, "type": "swipe", "params": params}
    if action.type == "wait":
        return {"id": sid, "type": "delay", "params": {"ms": max(1, int(action.seconds * 1000))}}
    if action.type == "key":
        return {"id": sid, "type": "key", "params": {"value": action.value}}
    if action.type == "text":
        return {"id": sid, "type": "text", "params": {"value": action.value}}
    raise ValueError(f"无法录成步骤链: {action.type}")
