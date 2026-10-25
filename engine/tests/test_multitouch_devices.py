"""Owner-scoped Android/scrcpy multi-touch without changing legacy packets."""

from __future__ import annotations

import struct
import threading
from typing import Any

import pytest

from gamepilot.devices.android import AndroidController
from gamepilot.devices.base import Controller
from gamepilot.devices.scrcpy import ScrcpyChannel
from gamepilot.devices.synthetic_test import SyntheticController


class RecordingControl:
    def __init__(self) -> None:
        self.packets: list[bytes] = []
        self.closed = False
        self.fail = False

    def sendall(self, payload: bytes) -> None:
        if self.fail:
            raise BrokenPipeError("broken")
        self.packets.append(payload)

    def close(self) -> None:
        self.closed = True


def channel() -> tuple[ScrcpyChannel, RecordingControl]:
    result = ScrcpyChannel("test", "adb", "server.jar")
    result.video_size = (101, 201)
    control = RecordingControl()
    result._control = control  # type: ignore[assignment]
    return result, control


def decode(packet: bytes) -> tuple[int, ...]:
    return struct.unpack(">BBQIIHHHII", packet)


def test_two_fingers_keep_independent_positions_and_owners() -> None:
    device, control = channel()
    device.touch_down(0.2, 0.3, pointer_id=1, owner="move")
    device.touch_down(0.7, 0.8, pointer_id=2, owner="skill")
    device.touch_move(0.3, 0.4, pointer_id=1, owner="move")
    device.touch_up(pointer_id=2, owner="skill")
    assert device._active_touches == {1: ("move", 0.3, 0.4)}
    device.touch_up(pointer_id=1, owner="move")
    packets = [decode(packet) for packet in control.packets]
    assert [p[1] for p in packets] == [0, 0, 2, 1, 1]
    assert [p[2] for p in packets] == [17, 18, 17, 18, 17]
    assert packets[3][3:7] == (70, 160, 101, 201)
    assert packets[4][3:7] == (30, 80, 101, 201)
    assert [p[7] for p in packets] == [65535, 65535, 65535, 0, 0]
    assert all(p[8:] == (0, 0) for p in packets)
    assert not device._active_touches


@pytest.mark.parametrize("operation", ["down", "move", "up"])
def test_other_owner_cannot_steal_or_release_pointer(operation: str) -> None:
    device, control = channel()
    device.touch_down(0.2, 0.3, pointer_id=1, owner="first")
    with pytest.raises(ValueError, match="owner"):
        if operation == "up":
            device.touch_up(pointer_id=1, owner="other")
        else:
            getattr(device, f"touch_{operation}")(0.4, 0.5, pointer_id=1, owner="other")
    assert len(control.packets) == 1
    assert device._active_touches[1][0] == "first"


@pytest.mark.parametrize("pointer_id", [True, False, 0, 11, -1, 1.5, "1", None])
def test_pointer_identity_range_is_strict(pointer_id: Any) -> None:
    device, control = channel()
    with pytest.raises(ValueError, match="pointer_id"):
        device.touch_down(0.1, 0.2, pointer_id=pointer_id, owner="run")
    assert not control.packets


@pytest.mark.parametrize("owner", ["", " ", None, 42])
def test_owner_must_be_nonempty_string(owner: Any) -> None:
    device, control = channel()
    with pytest.raises(ValueError, match="owner"):
        device.touch_down(0.1, 0.2, pointer_id=1, owner=owner)
    assert not control.packets


@pytest.mark.parametrize("coordinate", [float("nan"), float("inf"), float("-inf"), True])
def test_invalid_coordinates_send_nothing(coordinate: float) -> None:
    device, control = channel()
    with pytest.raises(ValueError):
        device.touch_down(coordinate, 0.2, pointer_id=1, owner="run")
    assert not control.packets


def test_duplicate_down_unknown_move_and_idempotent_up() -> None:
    device, control = channel()
    device.touch_up(pointer_id=1, owner="run")
    with pytest.raises(ValueError, match="尚未"):
        device.touch_move(0.2, 0.3, pointer_id=1, owner="run")
    device.touch_down(0.2, 0.3, pointer_id=1, owner="run")
    with pytest.raises(ValueError, match="已按下"):
        device.touch_down(0.2, 0.3, pointer_id=1, owner="run")
    device.touch_up(pointer_id=1, owner="run")
    device.touch_up(pointer_id=1, owner="run")
    assert len(control.packets) == 2


def test_owner_release_does_not_touch_other_owner_or_legacy() -> None:
    device, control = channel()
    device.touch_down(0.2, 0.3, pointer_id=1, owner="a")
    device.touch_down(0.6, 0.7, pointer_id=2, owner="b")
    device.touch("down", 0.4, 0.5)
    device.release_touches(owner="a")
    assert device._active_touches == {2: ("b", 0.6, 0.7)}
    assert device._legacy_touch is not None
    device.release_touches(owner="a")
    assert len(control.packets) == 4
    device.release_touches()
    assert not device._active_touches
    assert device._legacy_touch is None
    assert [decode(p)[2] for p in control.packets[-2:]] == [18, 1]


@pytest.mark.parametrize("legacy_first", [True, False])
def test_capacity_includes_legacy_pointer(legacy_first: bool) -> None:
    device, control = channel()
    if legacy_first:
        device.touch("down", 0.1, 0.2)
    for pointer_id in range(1, 10 if legacy_first else 11):
        device.touch_down(0.2, 0.3, pointer_id=pointer_id, owner="run")
    assert len(control.packets) == 10
    with pytest.raises(ValueError, match="10"):
        if legacy_first:
            device.touch_down(0.2, 0.3, pointer_id=10, owner="run")
        else:
            device.touch("down", 0.1, 0.2)
    assert len(control.packets) == 10


def test_legacy_touch_packets_keep_original_wire_values() -> None:
    device, control = channel()
    for phase in ("down", "move", "up"):
        device.touch(phase, 0.5, 0.5)
    packets = [decode(p) for p in control.packets]
    assert [p[1] for p in packets] == [0, 2, 1]
    assert all(p[2:] == (1, 50, 100, 101, 201, 1, 1, 1) for p in packets)


def test_fault_clears_local_state_and_blocks_later_input() -> None:
    device, control = channel()
    device.touch_down(0.2, 0.3, pointer_id=1, owner="run")
    control.fail = True
    with pytest.raises(BrokenPipeError):
        device.touch_move(0.4, 0.5, pointer_id=1, owner="run")
    assert not device._active_touches
    assert device.max_touch_points == 0
    control.fail = False
    with pytest.raises(ConnectionError):
        device.touch_down(0.1, 0.2, pointer_id=2, owner="new")
    with pytest.raises(ConnectionError):
        device.touch("down", 0.1, 0.2)
    assert len(control.packets) == 1


def test_close_releases_before_socket_close_and_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    device, control = channel()
    monkeypatch.setattr(device, "_kill_remote_server", lambda: None)
    device.touch_down(0.2, 0.3, pointer_id=1, owner="a")
    device.touch_down(0.6, 0.7, pointer_id=2, owner="b")
    device.close()
    assert control.closed
    assert [decode(p)[1] for p in control.packets] == [0, 0, 1, 1]
    assert not device._active_touches
    assert device.max_touch_points == 0
    device.close()
    assert len(control.packets) == 4


def test_close_fault_still_clears_all_state(monkeypatch: pytest.MonkeyPatch) -> None:
    device, control = channel()
    monkeypatch.setattr(device, "_kill_remote_server", lambda: None)
    device.touch_down(0.2, 0.3, pointer_id=1, owner="run")
    control.fail = True
    device.close()
    assert control.closed
    assert not device._active_touches


def test_packets_are_atomic_across_multiple_senders() -> None:
    device, control = channel()
    barrier = threading.Barrier(3)
    failures: list[BaseException] = []
    sending = threading.Lock()
    original_send = control.sendall

    def checked_send(payload: bytes) -> None:
        assert sending.acquire(blocking=False), "整包sendall不得并发重叠"
        try:
            # 同线程再次取锁以外的sender无法进入，覆盖touch/text/key共用发送门。
            original_send(payload)
        finally:
            sending.release()

    control.sendall = checked_send  # type: ignore[method-assign]

    def finger(pointer_id: int) -> None:
        try:
            barrier.wait()
            for _ in range(10):
                device.touch_down(0.2, 0.3, pointer_id=pointer_id, owner=str(pointer_id))
                device.text("a" * 1000)
                device.key(4)
                device.touch_up(pointer_id=pointer_id, owner=str(pointer_id))
        except BaseException as exc:
            failures.append(exc)

    threads = [threading.Thread(target=finger, args=(index,)) for index in (1, 2)]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join(2)
        assert not thread.is_alive()
    assert not failures
    assert len(control.packets) == 100
    assert all(len(p) == {0: 14, 1: 1005, 2: 32}[p[0]] for p in control.packets)
    assert not device._active_touches


def test_android_delegates_owner_and_loses_failed_channel(monkeypatch: pytest.MonkeyPatch) -> None:
    controller = AndroidController(serial="test")
    device, control = channel()
    controller._scrcpy = device
    controller._connected = True
    checks: list[bool] = []
    monkeypatch.setattr(controller, "_validate_scrcpy_target", lambda *, force=False: checks.append(force))
    monkeypatch.setattr(device, "_kill_remote_server", lambda: None)
    assert controller.to_dict()["capabilities"] == {"multiTouch": True, "maxTouchPoints": 10}
    controller.touch_down(0.2, 0.3, pointer_id=1, owner="run")
    controller.touch_move(0.4, 0.5, pointer_id=1, owner="run")
    assert checks == [True, False]
    control.fail = True
    with pytest.raises(RuntimeError, match="控制通道断开"):
        controller.touch_up(pointer_id=1, owner="run")
    assert controller._scrcpy is None
    assert control.closed
    assert controller.max_touch_points == 0


def test_android_releases_only_requested_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    controller = AndroidController(serial="test")
    device, _control = channel()
    controller._scrcpy = device
    controller._connected = True
    monkeypatch.setattr(controller, "_validate_scrcpy_target", lambda *, force=False: None)
    controller.touch_down(0.2, 0.3, pointer_id=1, owner="a")
    controller.touch_down(0.6, 0.7, pointer_id=2, owner="b")
    controller.release_touches(owner="a")
    assert device._active_touches == {2: ("b", 0.6, 0.7)}
    controller.touch_up(pointer_id=2, owner="b")
    assert device._active_touches == {}


@pytest.mark.parametrize("unavailable", ["missing", "closed", "faulted", "video_stopped", "disconnected"])
def test_android_capability_tracks_live_control(unavailable: str) -> None:
    controller = AndroidController(serial="test")
    device, _control = channel()
    controller._scrcpy = device
    controller._connected = True
    assert controller.max_touch_points == 10
    if unavailable == "missing":
        device._control = None
    elif unavailable == "closed":
        device._control_closed = True
    elif unavailable == "faulted":
        device._control_error = "broken"
    elif unavailable == "video_stopped":
        device._stop.set()
    else:
        controller._connected = False
    assert controller.max_touch_points == 0
    assert controller.to_dict()["capabilities"] == {"multiTouch": False, "maxTouchPoints": 0}


def test_android_release_never_revalidates_or_reselects_display(monkeypatch: pytest.MonkeyPatch) -> None:
    controller = AndroidController(serial="test")
    device, control = channel()
    controller._scrcpy = device
    controller._connected = True
    device.touch_down(0.2, 0.3, pointer_id=1, owner="run")

    def reject_reselection(*, force: bool = False) -> None:
        raise AssertionError("释放只能发给原通道，不能重新枚举/选择屏幕")

    monkeypatch.setattr(controller, "_validate_scrcpy_target", reject_reselection)
    controller.release_touches(owner="run")
    assert [decode(p)[1] for p in control.packets] == [0, 1]
    controller._scrcpy = None
    controller.release_touches(owner="run")
    assert len(control.packets) == 2


def test_unsupported_controller_does_not_gain_legacy_touch() -> None:
    class Unsupported(Controller):
        def connect(self) -> None:
            self._connected = True

        @property
        def resolution(self) -> tuple[int, int]:
            return 100, 200

        def screenshot(self) -> Any:
            return None

    controller = Unsupported("unsupported")
    controller.connect()
    assert not hasattr(controller, "touch")
    assert controller.to_dict()["capabilities"] == {"multiTouch": False, "maxTouchPoints": 0}
    controller.release_touches(owner="run")
    with pytest.raises(NotImplementedError):
        controller.touch_down(0.2, 0.3, pointer_id=1, owner="run")


def test_synthetic_tracks_touch_owners_and_close() -> None:
    controller = SyntheticController()
    assert controller.max_touch_points == 0
    controller.connect()
    assert controller.to_dict()["capabilities"] == {"multiTouch": True, "maxTouchPoints": 10}
    controller.touch_down(0.2, 0.3, pointer_id=1, owner="a")
    controller.touch_down(0.6, 0.7, pointer_id=2, owner="b")
    controller.touch_move(0.3, 0.4, pointer_id=1, owner="a")
    with pytest.raises(ValueError):
        controller.touch_up(pointer_id=1, owner="b")
    controller.release_touches(owner="b")
    assert controller.active_touches == {1: ("a", 0.3, 0.4)}
    controller.close()
    assert controller.active_touches == {}
    assert controller.pointer_events[-1] == ("up", 1, "a", 0.3, 0.4)
