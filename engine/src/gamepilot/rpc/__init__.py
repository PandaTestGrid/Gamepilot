"""RPC 层：与 Tauri 壳的通信边界。"""

from .stdio import RpcServer, main

__all__ = ["RpcServer", "main"]
