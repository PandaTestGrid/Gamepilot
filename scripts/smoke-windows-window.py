#!/usr/bin/env python3
"""端到端冒烟：**真实引擎子进程 + 真实 Windows 窗口**，验证"选窗口 → 绑定句柄 → 抓图 → 点击"。

这是 Windows 窗口自动化（`Windows:///?hwnd=<句柄>`）的手工验收工具，不跑在 CI 里
（CI 没有可交互桌面）。它不依赖前端：直接按 `docs/rpc.md` 打 stdio JSON-RPC。

用法（Windows 桌面上执行，会短暂把测试窗口切到前台并点击一下，鼠标会回到原处）：

    engine/.venv/Scripts/python.exe scripts/smoke-windows-window.py

退出码 0 = 全过。验证内容：
  1. `window.list` 能枚举到本脚本开的窗口，并返回可直接连接的 `uri` / `deviceId`
  2. `device.connect` 绑定句柄成功：`channel=win32`、首帧非全黑（抓图链路真的通）
  3. `post=global`（SendInput）点击：Tk 画布收到真实鼠标事件
  4. 断开后换 `post=message`（PostMessage，不抢焦点）能重新绑定并出帧
  5. `post=sync`（后台同步 SendMessage）在**原生 WinForms 按钮**上真的触发点击
     —— 这是 UE/Unity 这类"只处理送进来的消息"的游戏的后台控制通道
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

ENGINE_SRC = Path(__file__).resolve().parent.parent / "engine" / "src"
WINDOW_TITLE = "GamePilot Windows Smoke"

FAILURES: list[str] = []
CHECKS = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if condition:
        print(f"  \033[32mPASS\033[0m {label}")
        return
    FAILURES.append(label)
    print(f"  \033[31mFAIL\033[0m {label}" + (f" —— {detail}" if detail else ""))


class Engine:
    """一个真实的引擎子进程（工作区 / 配置都指向临时目录，不碰用户数据）。"""

    def __init__(self, config_dir: Path) -> None:
        env = {
            **os.environ,
            "PYTHONPATH": str(ENGINE_SRC),
            "GAMEPILOT_CONFIG_DIR": str(config_dir),
            "GAMEPILOT_WORKSPACE_DIR": str(config_dir / "workspace"),
            "GAMEPILOT_LOG_LEVEL": "ERROR",
        }
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "gamepilot.rpc"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            env=env,
        )
        self._id = 0
        self.methods: set[str] = set()
        self._wait_ready()

    def _wait_ready(self, timeout: float = 20.0) -> None:
        assert self.proc.stdout is not None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                break
            frame = json.loads(line)
            if frame.get("method") == "engine.ready":
                self.methods = set(frame.get("params", {}).get("methods", []))
                return
        raise RuntimeError("引擎没有发 engine.ready")

    def call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 30.0) -> dict[str, Any]:
        request_id = self.send(method, params)
        return self.wait_for(lambda frame: frame.get("id") == request_id, timeout=timeout)

    def send(self, method: str, params: dict[str, Any] | None = None) -> int:
        assert self.proc.stdin is not None
        self._id += 1
        request = {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}}
        self.proc.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        return self._id

    def wait_for(self, predicate: Any, timeout: float = 30.0) -> dict[str, Any]:
        assert self.proc.stdout is not None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("引擎没回话（进程挂了？）")
            frame = json.loads(line)
            if predicate(frame):
                if "error" in frame:
                    raise RuntimeError(frame["error"].get("message", "引擎报错"))
                return frame.get("result", frame)
        raise RuntimeError(f"等待超时（{timeout}s）")

    def close(self) -> None:
        try:
            self.call("engine.shutdown", timeout=5)
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def run_sync_probe(engine: Engine) -> None:
    """后台同步通道（SendMessage）真点击测试：开一个原生 WinForms 按钮窗口，不激活它。

    为什么单独用 WinForms：Tk 会忽略一切消息注入（不适合当靶子）；WinForms 按钮是
    标准 Win32 子窗口，能证明 `_deepest_child` + `SendMessageTimeoutW` 这条链路真的把
    点击送到了控件上，而窗口始终不是前台。
    """
    import shutil

    work = Path(tempfile.mkdtemp(prefix="gamepilot-winforms-"))
    click_file = work / "clicks.txt"
    script = work / "probe.ps1"
    script.write_text(
        f"""Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$log = '{click_file}'
Remove-Item $log -ErrorAction SilentlyContinue
$form = New-Object System.Windows.Forms.Form
$form.Text = 'GamePilot WinForms Smoke'
$form.Size = New-Object System.Drawing.Size(520, 360)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(300, 240)
$btn = New-Object System.Windows.Forms.Button
$btn.Text = '点我'
$btn.Location = New-Object System.Drawing.Point(20, 20)
$btn.Size = New-Object System.Drawing.Size(220, 90)
$btn.Add_Click({{ Add-Content -Path $log -Value 'click' }})
$form.Controls.Add($btn)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 60000
$timer.Add_Tick({{ $timer.Stop(); $form.Close() }})
$timer.Start()
[void]$form.ShowDialog()
""",
        encoding="utf-8",
    )
    proc = subprocess.Popen(
        ["pwsh", "-NoProfile", "-WindowStyle", "Hidden", "-File", str(script)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        target: dict[str, Any] | None = None
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and target is None:
            listing = engine.call("window.list", {"includeOwn": True})
            target = next(
                (item for item in listing.get("windows", []) if item.get("title") == "GamePilot WinForms Smoke"),
                None,
            )
            if target is None:
                time.sleep(0.4)
        check("WinForms 靶子窗口已出现", target is not None)
        if target is None:
            return

        client_w = int(target.get("clientWidth") or 1)
        client_h = int(target.get("clientHeight") or 1)
        connected = engine.call("device.connect", {"uri": f"{target['uri']}&post=sync"})
        device_id = connected["deviceId"]
        check("post=sync 绑定成功", connected.get("channel") == "win32", str(connected.get("channel")))
        check("linkNote 写明后台同步", "输入=后台同步" in str(connected.get("linkNote")), str(connected.get("linkNote")))
        # 按钮在客户区 (20,20)-(240,110)，取中心点
        engine.call(
            "device.tap",
            {"deviceId": device_id, "x": 130 / client_w, "y": 65 / client_h},
        )
        clicked = False
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            if click_file.is_file() and "click" in click_file.read_text(encoding="utf-8"):
                clicked = True
                break
            time.sleep(0.1)
        check("后台同步点击真的触发了 WinForms 按钮", clicked, "clicks.txt 里没有 click 记录")
        engine.call("device.disconnect", {"deviceId": device_id})
    finally:
        proc.kill()
        proc.wait(timeout=5)
        shutil.rmtree(work, ignore_errors=True)


def main() -> int:
    if sys.platform != "win32":
        print("SKIP: 这个冒烟只在 Windows 上跑")
        return 0

    # 和引擎一样声明 DPI 感知：否则 125%/150% 缩放下 Tk 的坐标是逻辑像素，和引擎的物理像素对不上
    try:
        import ctypes

        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        pass

    import tkinter as tk

    import ctypes

    foreground_ok = int(ctypes.windll.user32.GetForegroundWindow() or 0) != 0
    if not foreground_ok:
        print("  \033[33mSKIP\033[0m 当前桌面没有前台窗口（锁屏/非交互桌面）→ 跳过 SendInput 点击验证")

    config = Path(tempfile.mkdtemp(prefix="gamepilot-win-smoke-"))
    engine = Engine(config)
    try:
        print("[1] 开一个测试窗口（Tk，标题 %r）" % WINDOW_TITLE)
        root = tk.Tk()
        root.title(WINDOW_TITLE)
        root.geometry("520x340+220+180")
        clicks: list[int] = []

        def on_click(event: Any) -> None:
            clicks.append(int(event.x))
            canvas.itemconfigure(hint, text=f"已点击 {len(clicks)} 次")

        canvas = tk.Canvas(root, bg="#1c2029", highlightthickness=0)
        canvas.pack(fill="both", expand=True)
        canvas.bind("<Button-1>", on_click)
        hint = canvas.create_text(260, 150, text="等待点击…", fill="#e6e9ef", font=("Microsoft YaHei UI", 16))
        canvas.create_rectangle(40, 40, 480, 300, outline="#4da3ff", width=2)
        root.update()

        # 按钮/画布中心 → 屏幕坐标（主线程取，再交给 worker 算归一化）
        canvas.update_idletasks()
        canvas_x = canvas.winfo_rootx()
        canvas_y = canvas.winfo_rooty()
        canvas_w = canvas.winfo_width()
        canvas_h = canvas.winfo_height()

        errors: list[str] = []
        result: dict[str, Any] = {}

        def worker() -> None:
            try:
                listing = engine.call("window.list")
                windows = listing.get("windows", [])
                target = next(
                    (item for item in windows if WINDOW_TITLE in str(item.get("title", ""))),
                    None,
                )
                check("window.list 是 win32", listing.get("platform") == "win32", repr(listing.get("platform")))
                check("枚举到测试窗口", target is not None, f"共 {len(windows)} 个窗口")
                if target is None:
                    return
                result["window"] = target
                handle = int(target.get("handle") or 0)
                check("句柄非 0", handle > 0, repr(handle))
                check("返回的 uri 可直接连接", target.get("uri") == f"Windows:///?hwnd={handle}", str(target.get("uri")))
                check("deviceId 与句柄一致", target.get("deviceId") == f"windows:{handle}", str(target.get("deviceId")))
                client_w = int(target.get("clientWidth") or 0)
                client_h = int(target.get("clientHeight") or 0)
                check("客户区尺寸合理", client_w >= 400 and client_h >= 260, f"{client_w}x{client_h}")

                uri = f"{target['uri']}&post=global"
                connected = engine.call("device.connect", {"uri": uri})
                device_id = connected["deviceId"]
                check("channel=win32", connected.get("channel") == "win32", str(connected.get("channel")))
                check("linkNote 写明前台输入", "输入=前台" in str(connected.get("linkNote")), str(connected.get("linkNote")))
                wgc_expected = importlib.util.find_spec("windows_capture") is not None
                check(
                    "抓图通道随可用性选择" if wgc_expected else "WGC 未安装（按预期回退 PrintWindow）",
                    ("抓图=wgc" in str(connected.get("linkNote"))) == wgc_expected,
                    str(connected.get("linkNote")),
                )
                resolution = list(connected.get("resolution") or [])
                check(
                    "首帧分辨率 = 客户区（抓图非黑才连得上）",
                    resolution[:2] == [client_w, client_h],
                    f"{resolution} vs {client_w}x{client_h}",
                )

                engine.call("device.stream", {"deviceId": device_id, "fps": 10})
                frame = engine.wait_for(lambda item: item.get("method") == "engine.frame", timeout=15)
                params = frame.get("params", {})
                jpeg = str(params.get("jpeg") or "")
                check("engine.frame 带画面", len(jpeg) > 1000, f"jpeg base64 长度 {len(jpeg)}")

                # 画布中心（屏幕坐标）→ 窗口客户区归一化坐标
                screen_x = canvas_x + canvas_w // 2
                screen_y = canvas_y + canvas_h // 2
                norm_x = (screen_x - int(target["clientX"])) / max(1, client_w)
                norm_y = (screen_y - int(target["clientY"])) / max(1, client_h)
                if foreground_ok:
                    engine.call("device.tap", {"deviceId": device_id, "x": norm_x, "y": norm_y})
                    result["norm"] = (round(norm_x, 3), round(norm_y, 3))
                    time.sleep(0.6)
                else:
                    print("  \033[33mSKIP\033[0m 当前桌面没有前台窗口（锁屏/非交互桌面），跳过 SendInput 点击验证")

                status = engine.call("device.status", {"deviceId": device_id})
                check(
                    "会话已启动且在出帧",
                    status.get("channel") == "win32" and int(status.get("index") or 0) >= 1,
                    f"index={status.get('index')} channel={status.get('channel')}",
                )

                engine.call("device.disconnect", {"deviceId": device_id})
                background = engine.call("device.connect", {"uri": f"{target['uri']}&post=message"})
                check("post=message 能重新绑定并出帧", list(background.get("resolution") or [])[:2] == [client_w, client_h], str(background.get("resolution")))
                check("linkNote 写明后台输入", "输入=后台" in str(background.get("linkNote")), str(background.get("linkNote")))
                engine.call("device.disconnect", {"deviceId": background["deviceId"]})
            except Exception as exc:  # noqa: BLE001 - 冒烟脚本把异常转成失败项
                errors.append(f"{type(exc).__name__}: {exc}")
            finally:
                result["done"] = True

        thread = threading.Thread(target=worker, name="win-smoke", daemon=True)
        thread.start()
        deadline = time.monotonic() + 90
        while not result.get("done") and time.monotonic() < deadline:
            root.update()
            time.sleep(0.02)

        # 再泵几轮事件，让点击真的派发到 Tk 回调
        for _ in range(30):
            root.update()
            time.sleep(0.02)

        if foreground_ok:
            check("SendInput 点击真的落到测试窗口", len(clicks) >= 1, f"clicks={clicks}")
            check("绑定的输入方式为前台（默认）", result.get("norm") is not None, str(result.get("norm")))
        if errors:
            check("RPC 全流程无异常", False, " ; ".join(errors))
        else:
            check("RPC 全流程无异常", True)
        root.destroy()

        print("[2] 后台同步通道（SendMessage）真点击（窗口保持非前台）")
        run_sync_probe(engine)
    finally:
        engine.close()

    print()
    if FAILURES:
        print(f"\033[31m{len(FAILURES)} 项失败 / {CHECKS} 项检查\033[0m")
        for item in FAILURES:
            print(f"  - {item}")
        return 1
    print(f"\033[32m全部通过（{CHECKS} 项检查）\033[0m")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
