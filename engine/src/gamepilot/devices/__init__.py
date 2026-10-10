"""Devices 层：把「设备」抽象成 截图 + 输入 + 生命周期（骨架占位，M1 起实现）。

规划模块：
    base.py     Controller 抽象（归一化输入接口 + URI scheme 注册表）
    mock.py     离线合成游戏画面，供无设备端到端验证（M1 的第一个设备）
    android.py  adb 后备 → scrcpy（H.264 投屏 + control socket 精确触控，M4）
    windows.py  DXGI 截屏 + 虚拟 HID（M4，先只承诺前台 SendInput）

依赖方向：只能 import gamepilot.core，不得 import gamepilot.rpc。
"""

from __future__ import annotations

__all__: list[str] = []
