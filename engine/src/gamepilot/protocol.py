"""协议常量：前后端共享的契约版本与信封约定。

契约变更规则（docs/CONVENTIONS.md §5）：
- 新增可选字段 / 新增方法：向后兼容，不改 PROTOCOL_VERSION
- 删除字段 / 改字段语义 / 改事件名：破坏性变更，PROTOCOL_VERSION += 1，
  并同步更新 docs/rpc.md 与前端 TS 类型
"""

from __future__ import annotations

# 2：删除不再走回收站（`workflow.delete` / `workspace.remove` 真删除）：响应字段
#    `trashed` → `removed`，并去掉 `trashRoot`（破坏性变更，见 docs/rpc.md §6）
PROTOCOL_VERSION = 2

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
NOTIFY_DEVICE_LIST_CHANGED = "device.list.changed"
# 只有拿到 scrcpy 的首帧才算连好（拿不到就报 failed，不再回退 ADB 截图）。
NOTIFY_DEVICE_CONNECTED = "device.connected"
# 当前工作流切换（界面顶栏跟着变）
NOTIFY_PROJECT_CHANGED = "project.changed"
NOTIFY_DEVICE_DISCONNECTED = "device.disconnected"
NOTIFY_DEVICE_FAILED = "device.failed"
NOTIFY_DEVICE_RECOVERED = "device.recovered"  # 视频恢复；可带 channel、linkNote
NOTIFY_LOG = "engine.log"
NOTIFY_EVENT = "engine.event"
NOTIFY_FRAME = "engine.frame"
NOTIFY_OCR_PROGRESS = "ocr.progress"
NOTIFY_OCR_RESULT = "ocr.result"
NOTIFY_YOLO_PROGRESS = "yolo.progress"

# 前端 → 引擎 的请求方法（完整清单见 docs/rpc.md）
METHOD_PING = "engine.ping"
METHOD_EVENTS_SUBSCRIBE = "engine.events.subscribe"  # 显式协商批量步骤事件
METHOD_INFO = "engine.info"
#: 这台机器的运行环境快照（adb 路径/版本、5037 占用、设备列表…）：跑不起来时先看它
METHOD_DIAGNOSTICS = "engine.diagnostics"
METHOD_SHUTDOWN = "engine.shutdown"

# 设备（多设备：所有设备相关方法与通知都带 deviceId，见 docs/rpc.md）
METHOD_DEVICE_LIST = "device.list"
# macOS 本机窗口枚举（界面上的窗口选择器用；也可手动输句柄）
METHOD_MAC_WINDOWS = "mac.windows"
# 本机窗口枚举（统一入口：Windows 用 EnumWindows，macOS 用 CGWindowList）。界面上的
# 窗口选择器用它列出可以**绑定**的窗口；选中后按返回的 uri 连接（Windows://?hwnd=… / Mac://?window=…）
METHOD_WINDOW_LIST = "window.list"
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

# 工作区层（= 项目，同一个东西；可以有多个，用户自己选文件夹，最近使用列表 + 显示名
# 持久化在 config.json）：工作区 › 工作流，契约见 docs/WORKSPACE-CONTRACT.md v4
METHOD_WORKSPACE_LIST = "workspace.list"
METHOD_WORKSPACE_ADD = "workspace.add"
METHOD_WORKSPACE_REMOVE = "workspace.remove"
METHOD_WORKSPACE_TREE = "workspace.tree"
# 工作流层：工作流 = 一张状态图（工作区根下的直接子目录）
METHOD_WORKFLOW_CREATE = "workflow.create"
METHOD_WORKFLOW_DUPLICATE = "workflow.duplicate"
METHOD_WORKFLOW_RENAME = "workflow.rename"
METHOD_WORKFLOW_DELETE = "workflow.delete"
# 当前工作流的读取 / 切换（RPC 名字按契约保留 project.*，跟已取消的「项目」层级无关）
METHOD_PROJECT_GET = "project.get"
METHOD_PROJECT_SET = "project.set"
METHOD_TEMPLATE_IMAGE = "template.image"
# 录制：把手动操作变成工作流里的一步
METHOD_RECORD_ACTION = "record.action"
# 图编辑器（legacy）：加/改/删 nodes/edges；flow.steps 非空时引擎会拒绝
METHOD_GRAPH_NODE_ADD = "graph.node.add"
METHOD_GRAPH_NODE_UPDATE = "graph.node.update"
METHOD_GRAPH_NODE_REMOVE = "graph.node.remove"
METHOD_GRAPH_EDGE_ADD = "graph.edge.add"
METHOD_GRAPH_GET = "graph.get"
METHOD_GRAPH_SAVE = "graph.save"

# 录制与调参
METHOD_RECORD_TEMPLATE = "record.template"
#: 框一块区域 + 填要认的字 → 注册 OCR 识别器（"录一段文字"）
METHOD_RECORD_OCR = "record.ocr"
METHOD_RECOGNIZER_ENABLED = "recognizer.enabled"
METHOD_RECOGNIZER_THRESHOLD = "recognizer.threshold"
METHOD_RECOGNIZER_SEARCH = "recognizer.search"
#: 不录模板直接注册识别器（AI/语义型识别器用，例如 type: "yolo"）
METHOD_RECOGNIZER_CREATE = "recognizer.create"
#: 给 AI 识别器追加一个示例框（参考帧 = 当前画面）
METHOD_RECOGNIZER_EXAMPLE = "recognizer.example"
#: 读取/更新 AI 识别器（素材区编辑用）
METHOD_RECOGNIZER_DETAIL = "recognizer.detail"
METHOD_RECOGNIZER_UPDATE = "recognizer.update"
#: 弹窗「实时检测」预览：用示例框 + 调参在当前画面上跑一次
METHOD_RECOGNIZER_PREVIEW = "recognizer.preview"
#: 最近的帧（AI 标注弹窗前后翻帧挑参考）
METHOD_RECOGNIZER_FRAMES = "recognizer.frames"
#: 帧缓冲元信息 / 按帧号取单帧（1000 帧回放用，避免一次传千张图）
METHOD_RECOGNIZER_FRAME_META = "recognizer.frames.meta"
METHOD_RECOGNIZER_FRAME_AT = "recognizer.frame"
# AI 弹窗录制：磁盘持久化帧，不受实时预览的滚动缓冲限制。
METHOD_RECORDING_START = "recording.start"
METHOD_RECORDING_STOP = "recording.stop"
METHOD_RECORDING_META = "recording.meta"
METHOD_RECORDING_FRAME_AT = "recording.frameAt"
METHOD_RECORDING_DELETE = "recording.delete"
#: AI 模型列表/切换/导入（组件 models/ 里的 .pt）
METHOD_YOLO_MODELS = "yolo.models"
METHOD_YOLO_SET_MODEL = "yolo.model.set"
METHOD_YOLO_ADD_MODEL = "yolo.model.add"
METHOD_RECOGNIZER_REMOVE = "recognizer.remove"
METHOD_RECOGNIZER_RENAME = "recognizer.rename"

# 离线 OCR（PP-OCRv4 Mobile ONNX 按需下载、加载与框选/整屏文字识别）
METHOD_OCR_STATUS = "ocr.status"
METHOD_OCR_LOAD = "ocr.load"
METHOD_OCR_RECOGNIZE = "ocr.recognize"
METHOD_OCR_CANCEL = "ocr.cancel"

# YOLO 开放词汇检测组件（可选下载：独立 worker + torch + 模型）
METHOD_YOLO_STATUS = "yolo.status"
#: 后台预热 worker（加载模型，不跑推理）
METHOD_YOLO_WARMUP = "yolo.warmup"
METHOD_YOLO_INSTALL = "yolo.install"
METHOD_YOLO_REMOVE = "yolo.remove"

# 运行控制
# 变量（"黑板"）：改运行期变量值（不写回工作流）
METHOD_VARIABLE_SET = "variable.set"
# 调试：只执行一个动作（"单独跑这一步"），不影响状态机位置
METHOD_ACTION_RUN = "action.run"
METHOD_RUN_RESUME = "run.resume"  # 断点暂停后继续
METHOD_RUN_STEP = "run.step"  # 单步：执行完当前这一步再停
METHOD_BREAKPOINT = "run.breakpoint"  # 设/清断点（edgeId）
METHOD_RUN_START = "run.start"
METHOD_RUN_STOP = "run.stop"
METHOD_RUN_STATUS = "run.status"  # 重载后恢复权威运行列表
METHOD_TIMELINE = "timeline.get"
METHOD_RUN_EVIDENCE = "run.evidence"  # 最近一次运行的证据目录
METHOD_EVIDENCE_IMAGE = "evidence.image"  # 按文件名取一张证据截图
