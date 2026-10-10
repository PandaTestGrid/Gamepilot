"""`python -m gamepilot` 打印版本与协议信息（排查环境问题时先跑这个）。"""

from __future__ import annotations

import json
import platform
import sys

from . import __version__
from .protocol import FRAMING, PROTOCOL_VERSION


def main() -> int:
    print(
        json.dumps(
            {
                "name": "gamepilot-engine",
                "version": __version__,
                "protocol": PROTOCOL_VERSION,
                "framing": FRAMING,
                "python": platform.python_version(),
                "executable": sys.executable,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
