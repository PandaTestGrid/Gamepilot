"""`python -m gamepilot.rpc` = 以 stdio JSON-RPC 模式启动引擎。"""

from __future__ import annotations

from .stdio import main

if __name__ == "__main__":
    raise SystemExit(main())
