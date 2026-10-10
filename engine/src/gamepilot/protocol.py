"""协议常量：前后端共享的契约版本与信封约定。

契约变更规则（docs/CONVENTIONS.md §5）：
- 新增可选字段 / 新增方法：向后兼容，不改 PROTOCOL_VERSION
- 删除字段 / 改字段语义 / 改事件名：破坏性变更，PROTOCOL_VERSION += 1，
  并同步更新 docs/rpc.md 与前端 TS 类型
"""

from __future__ import annotations

PROTOCOL_VERSION = 1

# stdio 分帧：NDJSON（每行一个 JSON 对象，UTF-8）
FRAMING = "ndjson"

# JSON-RPC 2.0 标准错误码
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# 引擎 → 前端 的通知方法（无 id，不期待响应）
NOTIFY_READY = "engine.ready"
NOTIFY_LOG = "engine.log"
NOTIFY_EVENT = "engine.event"
NOTIFY_FRAME = "engine.frame"

# 前端 → 引擎 的请求方法（完整清单见 docs/rpc.md）
METHOD_PING = "engine.ping"
METHOD_INFO = "engine.info"
METHOD_SHUTDOWN = "engine.shutdown"
