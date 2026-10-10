"""设备相关 RPC 方法（第 1 块：device.list）。

新增方法的三步走（CONVENTIONS §11.3）：
1. 这里注册 handler；
2. `protocol.py` 加方法常量；
3. `docs/rpc.md` 补契约 + `apps/desktop/src/lib/rpc.ts` 加类型化封装。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..devices import scan
from ..protocol import METHOD_DEVICE_LIST

if TYPE_CHECKING:  # 避免与 stdio 循环导入
    from .stdio import RpcServer


def register(server: RpcServer) -> None:
    @server.method(METHOD_DEVICE_LIST)
    def _device_list(params: dict[str, Any]) -> dict[str, Any]:
        """扫描可用设备。

        params:
            scan: bool = True   是否真的去扫（false 时只返回 Mock/缓存，留给 UI 快速首屏）
        result:
            { "devices": [DeviceInfo...], "errors": [{provider, message}...] }
        """
        if params.get("scan", True) is False:
            from ..devices import mock

            return {"devices": [device.to_dict() for device in mock.discover()], "errors": []}
        return scan().to_dict()
