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

### `engine.shutdown`

优雅退出。返回后进程会结束；前端通常在 `engine_stop` 之前调用它。

- params：`{}`
- result：`{ "ok": true }`

## 4. 通知表（引擎 → 前端）

| 方法 | 状态 | 说明 |
|---|---|---|
| `engine.ready` | ✅ 已实现 | 引擎启动完成（握手）。params：`version` / `protocol` / `pid` / `methods` |
| `engine.log` | ⬜ 计划 M1 | 引擎侧结构化日志（避免前端只能读 stderr） |
| `engine.event` | ⬜ 计划 M3 | 状态机事件（`node_entered` / `edge_matched` / `recovery_done` / `transition_failed` …） |
| `engine.frame` | ⬜ 计划 M1 | 帧推送：base64 JPEG + 当帧识别结果 + 节点状态（会限频，约 8~15fps） |

高频通知的约定（CONVENTIONS §11.4）：必须限频或聚合，禁止把每一帧原样推给 UI。

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

## 7. 手工调试

不启动 GUI 也能验证引擎（stdout 就是协议流）：

```bash
cd engine
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"engine.ping","params":{}}' | uv run python -m gamepilot.rpc
```

期望输出两行：先 `engine.ready` 通知，再 `id=1` 的响应。

Rust 桥的往返也有测试守着：`cd apps/desktop/src-tauri && cargo test`。
