"""帧通道：JPEG 必须以**原始字节**走 unix socket，不占用 stdout 控制通道。

背景：两台设备按 15fps 推 60~143KB 的 JPEG，base64 后是 2.4MB/s 的 JSON 行。
如果和控制消息共用 stdout，RPC 响应会排在几万行帧后面 —— 界面表现为
"卡在 connecting、一帧都收不到"，应用也会很卡。
"""

from __future__ import annotations

import contextlib
import json
import os
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

MODULE = "gamepilot.rpc"
DEVICE_URI = "Mock:///?width=320&height=180"
DEVICE_ID = "mock:mock-1"


def _read_exactly(sock: socket.socket, size: int) -> bytes:
    buffer = bytearray()
    while len(buffer) < size:
        chunk = sock.recv(size - len(buffer))
        if not chunk:
            raise AssertionError("帧通道提前关闭")
        buffer.extend(chunk)
    return bytes(buffer)


def test_frames_use_unix_socket_not_stdout(tmp_path: Path) -> None:
    # 短路径：AF_UNIX 地址长度有限（macOS ~104 字节），pytest 的 tmp_path 会超限
    socket_path = Path(f"/tmp/gp-frames-test-{os.getpid()}.sock")
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(socket_path))
    listener.listen(1)
    listener.settimeout(15)

    project = tmp_path / "project"
    env = {
        **os.environ,
        "GAMEPILOT_LOG_LEVEL": "ERROR",
        "GAMEPILOT_PROJECT_DIR": str(project),
        # 工作区也指到临时目录：子进程绝不能碰仓库里的 workspaces/
        "GAMEPILOT_WORKSPACE_DIR": str(tmp_path / "workspaces" / "默认"),
        "GAMEPILOT_CONFIG_DIR": str(tmp_path / "config"),
        "GAMEPILOT_FRAME_SOCKET": str(socket_path),
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", MODULE],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
        env=env,
    )
    next_id = 0

    def call(method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        nonlocal next_id
        next_id += 1
        assert proc.stdin is not None and proc.stdout is not None
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": next_id, "method": method, "params": params or {}}) + "\n")
        proc.stdin.flush()
        deadline = time.time() + 15
        while time.time() < deadline:
            message = json.loads(proc.stdout.readline())
            if message.get("id") == next_id:
                assert "error" not in message, message
                return dict(message["result"])
        raise AssertionError(f"{method} 超时")

    connection: socket.socket | None = None
    try:
        assert proc.stdout is not None
        assert json.loads(proc.stdout.readline())["method"] == "engine.ready"

        call("device.connect", {"uri": DEVICE_URI})
        call("device.stream", {"deviceId": DEVICE_ID, "fps": 20})

        # 引擎应当主动连上帧通道
        connection, _ = listener.accept()
        connection.settimeout(10)

        id_len = _read_exactly(connection, 1)[0]
        device_id = _read_exactly(connection, id_len).decode("utf-8")
        (size,) = struct.unpack(">I", _read_exactly(connection, 4))
        jpeg = _read_exactly(connection, size)

        assert device_id == DEVICE_ID
        assert jpeg[:2] == b"\xff\xd8", "帧通道里必须是真正的 JPEG（原始字节，不是 base64）"
        assert len(jpeg) > 500

        # 控制通道上只剩元数据：不再有 base64 的 jpeg 字段
        meta = _wait_for_frame_meta(proc)
        assert "jpeg" not in meta, "走帧通道时，通知里不该再塞 base64 JPEG"
        assert meta["deviceId"] == DEVICE_ID
        assert meta["resolution"] == [320, 180]
    finally:
        if proc.stdin is not None:
            with contextlib.suppress(Exception):
                call("engine.shutdown")
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=5)
        # 资源要显式关：项目开了 filterwarnings=error，未关闭的 socket/管道会直接判失败
        if connection is not None:
            with contextlib.suppress(OSError):
                connection.close()
        with contextlib.suppress(OSError):
            listener.close()
        with contextlib.suppress(OSError):
            socket_path.unlink()
        for stream in (proc.stdin, proc.stdout):
            if stream is not None:
                with contextlib.suppress(Exception):
                    stream.close()


def _wait_for_frame_meta(proc: subprocess.Popen[str]) -> dict[str, Any]:
    assert proc.stdout is not None
    deadline = time.time() + 10
    while time.time() < deadline:
        message = json.loads(proc.stdout.readline())
        if message.get("method") == "engine.frame":
            return dict(message["params"])
    raise AssertionError("没等到 engine.frame 元数据")
