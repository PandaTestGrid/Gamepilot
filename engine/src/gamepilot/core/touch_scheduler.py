"""One timestamp-driven touch owner per controller, independent of capture frames.

Only short controller sends occur under the condition. No gesture sleeps while
holding it; cancellation invalidates queued events before releasing owned fingers.
"""

from __future__ import annotations

import contextlib
import heapq
import itertools
import math
import threading
import time
from dataclasses import dataclass, field
from typing import Any


class TouchOwner(str):
    """Cancellation lifetime travels with the owner, not an unbounded registry."""

    cancelled: threading.Event

    def __new__(cls, value: str) -> TouchOwner:
        instance = super().__new__(cls, value)
        instance.cancelled = threading.Event()
        return instance


@dataclass
class TouchHandle:
    owner: str
    finger: int
    done: threading.Event = field(default_factory=threading.Event)
    cancelled: bool = False
    error: BaseException | None = None


class TouchScheduler:
    def __init__(self, controller: Any) -> None:
        self.controller = controller
        self._condition = threading.Condition()
        self._queue: list[tuple[float, int, TouchHandle, str, float, float, bool]] = []
        self._counter = itertools.count()
        self._owners: dict[int, str] = {}
        self._positions: dict[int, tuple[float, float]] = {}
        self._handles: dict[int, TouchHandle] = {}
        self._closed = False
        self._thread = threading.Thread(target=self._run, name="touch-scheduler", daemon=True)
        self._thread.start()

    def submit(self, owner: str, finger: int, events: list[tuple[float, str, float, float]]) -> TouchHandle:
        """Events are relative monotonic seconds, with down/move/up phases.

        A down without up is a persistent contact. Its completed handle does not
        relinquish ownership: only an explicit up or cancel_owner may do that.
        """
        capacity = getattr(self.controller, "max_touch_points", 0)
        if not isinstance(finger, int) or isinstance(finger, bool) or not 1 <= finger <= min(10, capacity):
            raise ValueError(f"设备不支持手指 {finger}（最多 {capacity} 指）")
        if not events:
            raise ValueError("触控轨迹不能为空")
        for delay, phase, x, y in events:
            if phase not in ("down", "move", "up") or not all(math.isfinite(v) for v in (delay, x, y)) or delay < 0:
                raise ValueError("触控轨迹参数无效")
            if not (0 <= x <= 1 and 0 <= y <= 1):
                raise ValueError("触控坐标必须在 0..1")
        with self._condition:
            if self._closed or (isinstance(owner, TouchOwner) and owner.cancelled.is_set()):
                raise RuntimeError("触控调度器或触控 owner 已关闭")
            occupied = self._owners.get(finger)
            if occupied is not None and occupied != owner:
                raise ValueError(f"手指 {finger} 已被另一并行分支占用")
            pending = self._handles.get(finger)
            if pending is not None and not pending.done.is_set():
                raise ValueError(f"手指 {finger} 仍在执行前一个动作")
            first = events[0][1]
            if first == "down" and finger in self._positions:
                raise ValueError(f"手指 {finger} 已按下，请先释放")
            if first != "down" and occupied != owner:
                raise ValueError(f"手指 {finger} 尚未由当前分支按下")
            handle = TouchHandle(owner, finger)
            self._owners[finger] = owner
            self._handles[finger] = handle
            now = time.monotonic()
            ordered = sorted(events, key=lambda item: item[0])
            for index, (delay, phase, x, y) in enumerate(ordered):
                heapq.heappush(
                    self._queue, (now + delay, next(self._counter), handle, phase, x, y, index == len(ordered) - 1)
                )
            self._condition.notify_all()
            return handle

    def allocate_finger(self, owner: str, preferred: int = 1) -> int:
        with self._condition:
            if self._closed or (isinstance(owner, TouchOwner) and owner.cancelled.is_set()):
                raise RuntimeError("触控 owner 已关闭")
            for finger, current in self._owners.items():
                if current == owner:
                    return finger
            capacity = min(10, getattr(self.controller, "max_touch_points", 0))
            for finger in [preferred, *range(1, capacity + 1)]:
                if 1 <= finger <= capacity and finger not in self._owners:
                    self._owners[finger] = owner
                    return int(finger)
            raise ValueError("设备无可用触控手指")

    def has_contacts(self, owner: str) -> bool:
        with self._condition:
            return any(current == owner and finger in self._positions for finger, current in self._owners.items())

    def position(self, owner: str, finger: int) -> tuple[float, float]:
        with self._condition:
            if self._owners.get(finger) != owner or finger not in self._positions:
                raise ValueError(f"手指 {finger} 尚未由当前分支按下")
            return self._positions[finger]

    def cancel_owner(self, owner: str) -> None:
        with self._condition:
            if isinstance(owner, TouchOwner):
                owner.cancelled.set()
            for finger, handle in list(self._handles.items()):
                if handle.owner == owner:
                    handle.cancelled = True
                    handle.done.set()
                    self._handles.pop(finger, None)
            self._queue = [item for item in self._queue if item[2].owner != owner]
            heapq.heapify(self._queue)
            try:
                self.controller.release_touches(owner=owner)
            finally:
                for finger, current in list(self._owners.items()):
                    if current == owner:
                        self._owners.pop(finger, None)
                        self._positions.pop(finger, None)
                self._condition.notify_all()

    def close(self) -> None:
        with self._condition:
            if self._closed:
                return
            self._closed = True
            owners = set(self._owners.values())
        for owner in owners:
            with contextlib.suppress(Exception):
                self.cancel_owner(owner)
        with self._condition:
            self._condition.notify_all()
        if threading.current_thread() is not self._thread:
            self._thread.join(timeout=1)

    def _run(self) -> None:
        with self._condition:
            while not self._closed:
                if not self._queue:
                    self._condition.wait()
                    continue
                deadline, _, handle, phase, x, y, last = self._queue[0]
                delay = deadline - time.monotonic()
                if delay > 0:
                    self._condition.wait(delay)
                    continue
                heapq.heappop(self._queue)
                if handle.cancelled or self._handles.get(handle.finger) is not handle:
                    continue
                try:
                    if phase == "up":
                        self.controller.touch_up(pointer_id=handle.finger, owner=handle.owner)
                        self._owners.pop(handle.finger, None)
                        self._positions.pop(handle.finger, None)
                    else:
                        send = self.controller.touch_down if phase == "down" else self.controller.touch_move
                        send(x, y, pointer_id=handle.finger, owner=handle.owner)
                        self._positions[handle.finger] = (x, y)
                    if last:
                        handle.done.set()
                        self._condition.notify_all()
                except BaseException as error:
                    handle.error = error
                    handle.done.set()
                    with contextlib.suppress(Exception):
                        self.cancel_owner(handle.owner)


_registry_lock = threading.Lock()
_registry: dict[int, TouchScheduler] = {}


def get_touch_scheduler(controller: Any, *, create: bool = True) -> TouchScheduler | None:
    with _registry_lock:
        scheduler = _registry.get(id(controller))
        if scheduler is None or scheduler._closed:
            if not create:
                return None
            scheduler = TouchScheduler(controller)
            _registry[id(controller)] = scheduler
        return scheduler


def close_touch_scheduler(controller: Any) -> None:
    with _registry_lock:
        scheduler = _registry.pop(id(controller), None)
    if scheduler is not None:
        scheduler.close()
