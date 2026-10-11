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
NOTIFY_DEVICE_CONNECTING = "device.connecting"
NOTIFY_DEVICE_CONNECTED = "device.connected"
# 脚本目录切换（界面顶栏跟着变）
NOTIFY_PROJECT_CHANGED = "project.changed"
NOTIFY_DEVICE_DISCONNECTED = "device.disconnected"
NOTIFY_DEVICE_FAILED = "device.failed"
NOTIFY_LOG = "engine.log"
NOTIFY_EVENT = "engine.event"
NOTIFY_FRAME = "engine.frame"

# 前端 → 引擎 的请求方法（完整清单见 docs/rpc.md）
METHOD_PING = "engine.ping"
METHOD_INFO = "engine.info"
METHOD_SHUTDOWN = "engine.shutdown"

# 设备（多设备：所有设备相关方法与通知都带 deviceId，见 docs/rpc.md）
METHOD_DEVICE_LIST = "device.list"
METHOD_DEVICE_CONNECT = "device.connect"
METHOD_DEVICE_DISCONNECT = "device.disconnect"
METHOD_DEVICE_STATUS = "device.status"
# UI 告知引擎"这台设备我只看 N fps"（0 = 不推帧，识别与状态机照常跑）
METHOD_DEVICE_STREAM = "device.stream"
# 手动控制（画面栏直接操作设备）
METHOD_DEVICE_TOUCH = "device.touch"  # 实时触控：phase=down/move/up
METHOD_DEVICE_TAP = "device.tap"
METHOD_DEVICE_SWIPE = "device.swipe"
METHOD_DEVICE_KEY = "device.key"

# 状态图
# 工程（脚本目录）与素材
METHOD_PROJECT_GET = "project.get"
METHOD_PROJECT_SET = "project.set"
METHOD_PROJECT_LIST = "project.list"
METHOD_TEMPLATE_IMAGE = "template.image"
# 录制：把手动操作变成脚本里的一步
METHOD_RECORD_ACTION = "record.action"
# 图编辑器：加/改/删节点与边
METHOD_GRAPH_NODE_ADD = "graph.node.add"
METHOD_GRAPH_NODE_UPDATE = "graph.node.update"
METHOD_GRAPH_NODE_REMOVE = "graph.node.remove"
METHOD_GRAPH_EDGE_ADD = "graph.edge.add"
METHOD_GRAPH_GET = "graph.get"
METHOD_GRAPH_SAVE = "graph.save"

# 录制与调参
METHOD_RECORD_TEMPLATE = "record.template"
METHOD_RECOGNIZER_THRESHOLD = "recognizer.threshold"

# 运行控制
METHOD_RUN_START = "run.start"
METHOD_RUN_STOP = "run.stop"
METHOD_TIMELINE = "timeline.get"
