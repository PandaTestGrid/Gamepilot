"""GamePilot 引擎包。

分层与依赖方向（铁律，见 docs/CONVENTIONS.md §1）：

    rpc  ──▶ core ◀── devices
    （rpc 可依赖 core；devices 只依赖 core；core 不依赖任何上层）

禁止反向 import：core 里出现 `from gamepilot.rpc import ...` 即为违规。
"""

__version__ = "0.0.1"
