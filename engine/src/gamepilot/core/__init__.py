"""Core 层：与设备/UI 无关的纯逻辑（骨架占位，M1~M3 逐步实现）。

规划模块（对应 docs/DESIGN.md §3 与 §7）：
    geometry.py    归一化坐标 Rect/Point（像素只能出现在 devices 层）
    frame.py       Frame / Detection 数据协议
    recognizer.py  识别器协议 + 模板/颜色/OCR 实现 + 时序投票
    graph.py       状态图模型（Node/Edge/Recognizer）与 JSON DSL 读写
    engine.py      状态机运行时（pending 转换、recovery 边、事件流）
    trace.py       时间轴环形缓冲

依赖方向：本包**不得** import gamepilot.rpc / gamepilot.devices。
"""

from __future__ import annotations

__all__: list[str] = []
