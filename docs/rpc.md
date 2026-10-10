# RPC 契约（前端 ⇄ 引擎）

> 契约实现：`engine/src/gamepilot/rpc/`（服务端）· `apps/desktop/src-tauri/src/engine.rs`（桥）· `apps/desktop/src/lib/rpc.ts`（客户端）
> 契约常量：`engine/src/gamepilot/protocol.py`
>
> **改这里之前先读** [`CONVENTIONS.md` §5](./CONVENTIONS.md#5-契约与版本)。

## 1. 传输与分帧

| 项 | 值 |
|---|---|
| 传输 | 子进程 stdin/stdout（Tauri sidecar） |
| 分帧 | **NDJSON**：一行一个 JSON 对象，UTF-8，行尾 `\n` |
| 协议 | JSON-RPC 2.0 子集 |
| 当前版本 | `PROTOCOL_VERSION = 1` |

**铁律**：引擎 stdout 只能出现协议帧；所有日志走 stderr。

Rust 桥的调度规则：

- 帧里带 `id` → 视为响应，按 `id` 路由给等待的调用方（等待上限 10s，超时报错）
- 帧里不带 `id` → 视为通知，转成 Tauri 事件 `engine://event` 发给前端

## 2. 信封

请求（前端 → 引擎）：

```json
{ "jsonrpc": "2.0", "id": 1, "method": "engine.ping", "params": {} }
```

成功响应：

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "pong": true } }
```

失败响应：

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "未知方法: foo", "data": { "known": ["engine.ping"] } } }
```

通知（引擎 → 前端，无 `id`）：

```json
{ "jsonrpc": "2.0", "method": "engine.ready", "params": { "version": "0.0.1", "protocol": 1 } }
```

约定：`params` 必须是对象（没有参数就传 `{}`），数组或裸值一律拒绝（`-32600`）。

## 3. 方法表（前端 → 引擎）

### `engine.ping`

连通性自检。前端「骨架自检」按钮走的就是它。

- params：`{}`
- result：`{ "pong": true, "version": "0.0.1", "protocol": 1, "ts": 1730000000.123 }`

### `engine.info`

运行时信息，用于「关于」面板与问题排查。

- params：`{}`
- result：

```json
{
  "name": "gamepilot-engine",
  "version": "0.0.1",
  "protocol": 1,
  "python": "3.11.15",
  "platform": "macOS-15.0-arm64",
  "pid": 12345,
  "methods": ["engine.info", "engine.ping", "engine.shutdown"]
}
```

### `device.list`

扫描可用设备（adb 真机/模拟器 + Mock）。**第 1 块已实现**。

- params：`{ "scan": true }`（`false` 时只返回 Mock，用于快速首屏）
- result：

```json
{
  "devices": [
    {
      "id": "android:3387980",
      "uri": "Android:///?serial=3387980",
      "name": "OPPO A57",
      "kind": "android",
      "status": "discovered",
      "serial": "3387980",
      "model": "OPPO_A57",
      "product": "A57",
      "resolution": [720, 1280],
      "error": null,
      "suggestedFix": null
    }
  ],
  "errors": [{ "provider": "android", "message": "adb 列表获取失败: ..." }]
}
```

约定：

- `kind`：`android` / `emulator` / `windows` / `mock` / `remote`（模拟器按串口名与型号特征判定）
- `status`：`discovered` / `connected` / `failed`；**不可用设备也要返回**，
  并带上 `error` + `suggestedFix`（UI 要显示"能照做"的修复建议）
- `resolution` 可能为 `null`（未授权/离线设备读不到），UI 必须能显示 `—`
- **绝不抛异常**：单个来源失败只进 `errors`，其它来源照常返回
- `id` 只由平台 + serial 决定，跨扫描稳定（UI 靠它做选中与记忆）

### `engine.shutdown`

优雅退出。返回后进程会结束；前端通常在 `engine_stop` 之前调用它。

- params：`{}`
- result：`{ "ok": true }`

## 3.5 帧通道（不走 stdio）

`engine.frame` 的 **JPEG 不在 JSON 里**：引擎把它以原始字节写进一个 unix socket
（环境变量 `GAMEPILOT_FRAME_SOCKET`，由 Rust 桥创建并传入），host 侧读取后缓存，
前端用命令 `engine_frame` 按需取原始字节。

为什么这么做：两台设备按 15fps 推 60~143KB 的 JPEG，base64 后是 **2.4MB/s 的 JSON 行**。
和控制消息共用 stdout 时，RPC 响应会排在几万行帧后面 —— 实测表现为
"界面卡在 connecting、一帧都收不到"，应用整体卡顿。

改造后实测：控制通道流量 2400KB/s → **17KB/5s**，RPC 往返 0ms。

帧格式（unix socket，循环）：

```
[idLen u8][deviceId][jpegLen u32 BE][jpeg bytes]
```

- 引擎侧队列满时**丢帧**而不是阻塞截图/识别循环（状态机不能因为界面慢而停）
- 没有这条通道时（单测、非 unix）自动退回"base64 塞在 `engine.frame` 通知里"

## 4. 通知表（引擎 → 前端）

| 方法 | 状态 | 说明 |
|---|---|---|
| `engine.ready` | ✅ | 引擎启动完成（握手）。params：`version` / `protocol` / `pid` / `methods` |
| `device.connecting` | ✅ | 连接阶段变化：`deviceId, uri, phase`（`adb 连接中…` / `读取分辨率…`） |
| `device.connected` | ✅ | 连接成功：`deviceId, uri, resolution, graph` |
| `device.disconnected` | ✅ | 主动断开：`deviceId` |
| `device.failed` | ✅ | 连接失败 / 截图失败：`deviceId, error` |
| `engine.frame` | ✅ | 每帧画面：`deviceId, index, ts, resolution, node, pending, tick, fps, captureMs, detections[], jpeg(base64)`。fps 是实际交付节奏；scrcpy 静止画面会复用上一帧与上次的 JPEG 编码 |
| `engine.event` | ✅ | 状态机事件：`deviceId, seq, ts, type, node, edge, message` |
| `run.started` / `run.stopped` | ✅ | 运行控制：`deviceId` |
| `engine.log` | ⬜ 计划 | 引擎侧结构化日志（当前日志走 stderr） |

> 帧推送是**限频**的，且受设备截图耗时限制（adb 通道实测 ~550ms/帧 → ~1.8fps）。
> UI 不要假设固定帧率。真实时投屏要等 scrcpy 通道（H.264，目标 30~60ms）。

高频通知的约定（CONVENTIONS §11.4）：必须限频或聚合，禁止把每一帧原样推给 UI。

### `device.connect`

连接设备并启动截图循环（**已实现**）。

- params：`{ "uri": "Android:///?serial=3387980" }`；无真机时用 `Mock:///?width=640&height=360`
- result：`{ "deviceId", "resolution", "channel", "linkNote", "graph" }`
  - `channel`：`scrcpy`（H.264，解码 ~28fps / 交付 ~14fps、点击 0.1ms）
    或 `screencap`（adb 截图回退，~1.8fps、点击 ~1s）
  - `linkNote`：通道说明（含回退原因），界面底栏直接显示
- 响应返回前会**等首帧**（最多 3s），所以拿到响应时画面里已经有内容
- URI 规则：scheme 大小写不敏感；**`serial` 始终按字符串处理**
  （纯数字序列号被转成 int 会进到 subprocess 的 argv 抛 TypeError，表现为截图静默回退、慢 3 倍）

### `device.disconnect` / `device.status`

- `device.disconnect`：`{ deviceId }` → `{ ok: true }`（停止截图循环并释放设备）
- `device.status`：`{ deviceId }` →

```json
{
  "deviceId": "android:3387980",
  "running": true,
  "index": 128, "fps": 14.2, "captureMs": 0.3,
  "channel": "scrcpy", "linkNote": "scrcpy 720×1280", "linkFps": 27.8,
  "node": "home", "pending": null, "tick": 42,
  "stats": { "ticks": 42, "actions": 3, "transitions": 1, "failed": 0, "recoveries": 0 },
  "graph": { "…": "DESIGN.md §7 的状态图" }
}
```

### `graph.get` / `graph.save`

- `graph.get`：`{ deviceId }` → 状态图 JSON
- `graph.save`：`{ deviceId, graph }` → **校验后**写盘并热重载；
  校验失败返回 `-32603`，错误信息指明是哪个节点/边/识别器的问题

### `record.template`

从**当前帧**裁剪模板 → 落盘 `templates/<label>.png` → 注册识别器（可选建节点/边）→ 写回 `graph.json`。

```json
{
  "deviceId": "android:3387980",
  "rect": [0.35, 0.40, 0.30, 0.12],
  "label": "center",
  "threshold": 0.8,
  "nodeId": "home", "nodeName": "首页",
  "asEnter": true, "asActionTarget": true
}
```

- result：`{ "label", "mode": "template" | "color", "template", "rect", "graph" }`
- **纯色区域自动降级成颜色识别器**（`mode: "color"`）：纯色模板在归一化互相关里是退化的，
  会在画面任意位置给满分；宁可换算法也不报假命中
- 设备还没出帧时报「还没有可用画面」，不会写出空模板

### `recognizer.threshold`

`{ deviceId, label, threshold }` → 写回阈值并热重载（阈值滑块拖动时调用）。

### `run.start` / `run.stop`

`{ deviceId }` → `{ ok: true, running: boolean }`。
`run.start` 要求状态图里至少有一个节点，否则报「状态图还没有节点：先在画面上框选录制一个界面」。

### `device.stream`

`{ deviceId, fps }` → `{ ok, streamFps }`。界面告诉引擎"这台设备我只看 N fps"（**0 = 先别推帧**）。

- 引擎的截图、识别、状态机**照常跑**，只是不再编码 JPEG 推给界面
- 多设备同时投屏时这是最大的一笔开销：每帧 60~143KB，14fps 就是每台 1~2MB/s
- 界面的策略：单画面看的那台 10fps；多开每台 4~6fps；窗口不可见 0fps

### `timeline.get`

`{ deviceId, limit }` → `{ frames: [...], events: [...] }`（最近 N 帧摘要 + 事件，供时间轴回溯）。

## 5. 错误码

| 码 | 含义 | 触发场景 |
|---|---|---|
| `-32700` | 解析失败 | 不是合法 JSON |
| `-32600` | 请求非法 | 不是对象 / 缺 `method` / `params` 不是对象 |
| `-32601` | 方法不存在 | 方法名拼错（错误 `data.known` 会列出所有可用方法） |
| `-32602` | 参数非法 | 字段缺失或类型错误 |
| `-32603` | 引擎内部错误 | handler 抛异常（引擎不会因此退出） |
| `1000+` | 自定义错误 | 需要时在此登记 |

## 6. 版本与变更记录

规则（CONVENTIONS §5.1）：新增可选字段不改版本；删字段 / 改语义 / 改事件名 / 改分帧 = 破坏性变更，必须 `PROTOCOL_VERSION += 1` 并在此登记。

| PROTOCOL_VERSION | 日期 | 变更 |
|---|---|---|
| 1 | — | 初版：`engine.ping` / `engine.info` / `engine.shutdown` + `engine.ready` 通知；NDJSON 分帧 |
| 1 | — | 新增 `device.list`（Android 发现 + Mock），未新增版本号：纯新增方法，向后兼容 |

## 7. 手工调试

不启动 GUI 也能验证引擎（stdout 就是协议流）：

```bash
cd engine
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"engine.ping","params":{}}' | uv run python -m gamepilot.rpc
```

期望输出两行：先 `engine.ready` 通知，再 `id=1` 的响应。

Rust 桥的往返也有测试守着：`cd apps/desktop/src-tauri && cargo test`。
