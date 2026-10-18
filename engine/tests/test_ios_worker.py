"""iOS 子进程（多台 iPhone 靠它）：父进程那侧代理的协议。

不用真机：写一个**假 worker**（说同一套协议）来验三件事：

- 握手：`worker.ready` 里的分辨率/方向进到代理
- 帧通道：`[len u32 BE][截图字节]` → 解码成 ndarray（`screenshot()` 拿得到）
- 控制：归一化坐标原样送到子进程（方向变换在子进程里做，见 `ios_worker.py`）

外加两条：**两台代理能同时在跑**（拆进程就是为了这个），以及引擎在
"进程内那条隧道被占了"时确实换成了子进程实现。
"""

from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from typing import Any, cast

import pytest

from gamepilot.devices import ios, ios_worker

#: 说同一套协议的假子进程：连帧通道 → 报 ready → 逐条应答命令（收到的命令写进日志文件）
FAKE_WORKER = """
import json, os, socket, struct, sys

import cv2
import numpy as np

args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
port = int(args["--frame-port"])
log = os.environ["GAMEPILOT_FAKE_WORKER_LOG"]

image = np.zeros((2, 4, 3), np.uint8)
image[:, :] = (10, 20, 30)
ok, buffer = cv2.imencode(".jpg", image)
sock = socket.create_connection(("127.0.0.1", port))
sock.sendall(struct.pack(">I", len(buffer)) + buffer.tobytes())


def send(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\\n")
    sys.stdout.flush()


send({"method": "worker.ready", "params": {"resolution": [4, 2], "orientation": 3}})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    if request.get("method") == "worker.stop":
        break
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(request, ensure_ascii=False) + "\\n")
    send({"jsonrpc": "2.0", "id": request.get("id"), "result": {"ok": True}})

sock.close()
"""


def _controller(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, udid: str) -> ios_worker.IosWorkerController:
    """造一个指向**假 worker** 的代理（真 worker 要真机，这里验的是协议）。"""
    script = tmp_path / "fake_ios_worker.py"
    script.write_text(FAKE_WORKER, encoding="utf-8")
    monkeypatch.setenv("GAMEPILOT_FAKE_WORKER_LOG", str(tmp_path / f"commands-{udid}.jsonl"))
    monkeypatch.setattr(
        ios_worker,
        "list_devices",
        lambda: [ios.IosDevice(udid=udid, name=f"iPhone {udid}", version="26.6")],
    )
    monkeypatch.setattr(ios_worker.IosWorkerController, "_report_usb_config", lambda self: None)
    return ios_worker.IosWorkerController(udid=udid, worker_command=[sys.executable, str(script)])


def test_proxy_handshake_frames_and_commands(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    controller = _controller(tmp_path, monkeypatch, "UDID-W1")
    try:
        controller.connect()

        assert controller.resolution == (4, 2)
        assert controller.orientation == 3
        assert controller.display_name == "iPhone UDID-W1 (iOS 26.6)"
        assert controller.screenshot().shape == (2, 4, 3)

        controller.touch("down", 0.25, 0.75)
        controller.press("home")
        controller.text("abc")

        sent = [
            json.loads(line) for line in (tmp_path / "commands-UDID-W1.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        assert [item["method"] for item in sent] == ["hid.touch", "hid.press", "hid.text"]
        assert sent[0]["params"] == {"phase": "down", "x": 0.25, "y": 0.75}
        assert sent[1]["params"] == {"name": "home"}
        assert sent[2]["params"] == {"value": "abc"}
    finally:
        controller.close()
    assert not controller.is_alive()


def test_two_proxies_run_at_the_same_time(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """拆进程就是为了这个：两台 iPhone 各自一条隧道，同时带。"""
    first = _controller(tmp_path, monkeypatch, "UDID-W2")
    first.connect()
    second = _controller(tmp_path, monkeypatch, "UDID-W3")
    second.connect()
    try:
        assert first.is_alive() and second.is_alive()
        assert first.screenshot().shape == (2, 4, 3)
        assert second.screenshot().shape == (2, 4, 3)
        first.touch("down", 0.1, 0.1)
        second.press("home")
        assert first.display_name != second.display_name
    finally:
        first.close()
        second.close()


def test_bad_command_reports_the_worker_message(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """子进程回了 error → 代理抛可读错误（不是静默丢弃）。"""
    controller = _controller(tmp_path, monkeypatch, "UDID-W4")
    controller.connect()
    try:
        controller.close()  # 子进程没了：后续命令必须明确报错，而不是假装成功
        with pytest.raises(RuntimeError, match="子进程"):
            controller.touch("down", 0.5, 0.5)
    finally:
        controller.close()


def test_concurrent_commands_all_get_an_answer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """拖动时 `move` 是**高频并发**的：多个线程同时发命令，子进程不能收到插花的 NDJSON 行。

    未串行化写入时子进程可能丢命令并超时：
    界面上就是"手势断在半路"。
    """
    controller = _controller(tmp_path, monkeypatch, "UDID-W5")
    controller.connect()
    failures: list[str] = []

    def hammer(column: int) -> None:
        try:
            for _ in range(20):
                controller.touch("move", 0.1 * column, 0.5)
        except Exception as exc:  # 收集起来一次断言，别在子线程里 raise
            failures.append(f"{type(exc).__name__}: {exc}")

    threads = [threading.Thread(target=hammer, args=(column + 1,)) for column in range(6)]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert failures == [], failures
        sent = [
            json.loads(line) for line in (tmp_path / "commands-UDID-W5.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        assert len(sent) == 120, "6 个线程 × 20 条：一条都不能丢"
        assert all(item["params"]["phase"] == "move" for item in sent)
    finally:
        controller.close()


class _FakeSession:
    """只给 `_ios_slot_taken` 用的假会话（只看 started）。"""

    def __init__(self, started: bool) -> None:
        self.started = started


def test_create_controller_switches_to_the_worker_when_the_slot_is_taken(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """第一台 iPhone 走进程内；第二台起换子进程（引擎进程只能带一条用户态隧道）。"""
    from gamepilot.rpc import session as rpc_session

    built: list[str] = []

    class InProcess:
        kind = "ios"

        def __init__(self, device_id: str = "", **options: object) -> None:
            built.append(f"in-process:{device_id}")

    class Worker:
        kind = "ios"

        def __init__(self, device_id: str = "", **options: object) -> None:
            built.append(f"worker:{device_id}")

    monkeypatch.setattr(rpc_session, "controller_for_scheme", lambda scheme: InProcess)
    monkeypatch.setattr(ios_worker, "IosWorkerController", Worker)

    busy: Any = {"ios:A": _FakeSession(started=True)}
    idle: Any = {"ios:A": _FakeSession(started=False)}

    rpc_session._create_controller("ios", "ios:B", {}, sessions=cast(Any, busy))
    assert built == ["worker:ios:B"], "进程内额度被占 → 换子进程"

    built.clear()
    rpc_session._create_controller("ios", "ios:B", {}, sessions=cast(Any, idle))
    rpc_session._create_controller("ios", "ios:A", {}, sessions=cast(Any, busy))
    assert built == ["in-process:ios:B", "in-process:ios:A"], "没被占（或就是自己那台）→ 走进程内"
