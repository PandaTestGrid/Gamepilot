"""设备连接只在拿到第一张画面后才成功；截图异常时不留下假连接。"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from gamepilot.project import Project
from gamepilot.rpc import session as rpc_session


class FakeController:
    channel = "scrcpy"
    link_note = "scrcpy 100×200"
    display_name = "测试屏"
    kind = "emulator"
    resolution = (100, 200)

    def __init__(self) -> None:
        self.closed = False

    def connect(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True


class FakeSession:
    next_frame: np.ndarray | None = None
    next_error: str | None = None

    def __init__(self, _id: str, controller: FakeController, _project: Project, _emit: Any, **_kwargs: Any) -> None:
        self.controller = controller
        self.last_frame = self.next_frame
        self.capture_error = self.next_error
        self.graph = SimpleNamespace(to_dict=lambda: {"nodes": []})
        self.started = False
        self.stopped = False

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.stopped = True
        self.started = False
        self.controller.close()


def _manager(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> tuple[Any, list[tuple[str, dict[str, Any]]], FakeController]:
    messages: list[tuple[str, dict[str, Any]]] = []
    manager = rpc_session.SessionManager.__new__(rpc_session.SessionManager)
    manager.emit = lambda method, params: messages.append((method, params))
    manager.project = Project(root=str(tmp_path)).ensure()
    manager.sessions = {}
    controller = FakeController()
    monkeypatch.setattr(rpc_session, "_create_controller", lambda *_args, **_kwargs: controller)
    monkeypatch.setattr(rpc_session, "DeviceSession", FakeSession)
    return manager, messages, controller


def test_no_first_frame_emits_failed_but_never_connected(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    manager, messages, controller = _manager(monkeypatch, tmp_path)
    FakeSession.next_frame = None
    FakeSession.next_error = "截图失败: 屏幕没有画面"

    with pytest.raises(RuntimeError, match="屏幕没有画面"):
        manager._connect_locked("android:emu:42", "Android:///?serial=emu&display=2&physical=42", "android", {})

    assert controller.closed
    assert manager.sessions == {}
    assert [method for method, _ in messages].count("device.failed") == 1
    assert not any(method == "device.connected" for method, _ in messages)


def test_connected_event_only_after_first_frame(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    manager, messages, controller = _manager(monkeypatch, tmp_path)
    FakeSession.next_frame = np.zeros((200, 100, 3), dtype=np.uint8)
    FakeSession.next_error = None

    session = manager._connect_locked("android:emu:42", "Android:///?serial=emu&display=2&physical=42", "android", {})

    assert session.started
    assert not controller.closed
    assert manager.sessions["android:emu:42"] is session
    method, payload = messages[-1]
    assert method == "device.connected"
    assert payload["channel"] == "scrcpy"
    assert payload["resolution"] == [100, 200]
