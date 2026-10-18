"""PyInstaller 入口：与 `python -m gamepilot.rpc` 等价。"""

from __future__ import annotations

from gamepilot.rpc.stdio import main
from gamepilot.runtime_paths import configure_frozen_environment

if __name__ == "__main__":
    configure_frozen_environment()
    raise SystemExit(main())
