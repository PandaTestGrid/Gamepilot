"""设备相关 RPC 方法（第 1 块：device.list）。

新增方法的三步走（CONVENTIONS §11.3）：
1. 这里注册 handler；
2. `protocol.py` 加方法常量；
3. `docs/rpc.md` 补契约 + `apps/desktop/src/lib/rpc.ts` 加类型化封装。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..devices.discovery import DeviceDiscovery
from ..protocol import METHOD_DEVICE_LIST, NOTIFY_DEVICE_LIST_CHANGED

if TYPE_CHECKING:  # 避免与 stdio 循环导入
    from .stdio import RpcServer


def register(server: RpcServer) -> DeviceDiscovery:
    discovery = DeviceDiscovery(lambda provider: server.notify(NOTIFY_DEVICE_LIST_CHANGED, {"provider": provider}))

    @server.method(METHOD_DEVICE_LIST)
    def _device_list(params: dict[str, Any]) -> dict[str, Any]:
        """扫描可用设备。

        params:
            scan: bool = True   是否真的去扫（false 时不碰任何设备来源，直接返回空列表）
        result:
            { "devices": [DeviceInfo...], "errors": [{provider, message}...] }

        `status` 是**引擎这边的真实状态**：会话还活着的设备报 `connected`（见 `_mark_connected`）。
        """
        if params.get("scan", True) is False:
            result: dict[str, Any] = {"devices": [], "errors": []}
        else:
            result = discovery.snapshot()
        return _mark_connected(server, result)

    return discovery


def _mark_connected(server: RpcServer, result: dict[str, Any]) -> dict[str, Any]:
    """把引擎这边已经在带的设备标成 `connected`（界面重载/重启后前端状态是空的）。

    不这么做的话，界面会在画面还在推的时候显示"未连接"：前端只在收到 `device.connected`
    时才知道连着，而重载后的那次连接通知早就发过了。
    """
    manager = getattr(server, "sessions", None)
    live = {
        device_id
        for device_id, session in getattr(manager, "sessions", {}).items()
        if getattr(session, "started", False)
    }
    if not live:
        return result
    for device in result.get("devices", []):
        if isinstance(device, dict) and device.get("id") in live:
            device["status"] = "connected"
    return result
