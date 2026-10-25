# RPC 契约（前端 ⇄ 引擎）

> 契约实现：`engine/src/gamepilot/rpc/`（服务端）· `apps/desktop/src-tauri/src/engine.rs`（桥）· `apps/desktop/src/lib/rpc.ts`（客户端）
> 契约常量：`engine/src/gamepilot/protocol.py`
>
> **改这里之前先读** [`CONVENTIONS.md` §5](./CONVENTIONS.md#5-契约与版本)。

## 手动映射输入与映射方案

- 流程忙时拒绝手动映射事件，不暂停流程；启动流程、断开设备会结束所有手动映射会话并释放触点。设备必须支持多指输入。单设备至多保留 256 个会话 ID（含已结束 ID），超限明确报错，重连重置，避免无限增长。

## 1. 传输与分帧

| 项 | 值 |
|---|---|
| 传输 | 子进程 stdin/stdout（Tauri sidecar） |
| 分帧 | **NDJSON**：一行一个 JSON 对象，UTF-8，行尾 `\n` |
| 协议 | JSON-RPC 2.0 子集 |
| 当前版本 | `PROTOCOL_VERSION = 2` |

**铁律**：引擎 stdout 只能出现协议帧；所有日志走 stderr。

引擎入口显式把 stdin / stdout / stderr 设为 UTF-8，不依赖 Windows 系统代码页（GBK 等）或终端设置。
Rust 读取 stdout 时记录并跳过编码错误的整行，继续接收后续响应；stderr 按字节分行并容错解码，避免一条第三方日志截断后续诊断。

Rust 桥的调度规则：

- 帧里带 `id` → 视为响应，按 `id` 路由给等待的调用方（普通请求 10s、设备扫描 30s、连接等首帧 45s）
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

**错误文案到界面**：

- 引擎的 `error.message` 是 `f"{异常类名}: {原因}"`（例如 `RuntimeError: 『相机』还在被使用，先改掉再删：…`），
  `data` 是给排查用的附加信息，**都不该原样糊到界面上**；
- Rust 桥只取 `error.message` 拼成 `引擎返回错误: …`（`src-tauri/src/engine.rs`）；
- 前端 `lib/rpc.ts: rpc()` 是**唯一出口**：把 reject 值统一成 message 清理过的 `Error`
  （拆信封 → 去掉 Python 异常类名前缀 → 去掉 `KeyError` 的引号，原始值挂在 `cause` 上）。
  所以调用方只管 `error.message`，不用各自拆信封；文案规则的单测在 `lib/rpc.test.ts`。

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

### `engine.diagnostics`

**这台机器的运行环境快照**：引擎自己（版本 / Python / 打包态 / 解压目录 / 可执行文件大小与时间）+ `adb` 的真实处境
（路径 / 版本 / 5037 端口被谁听着 / `adb devices -l` 的原始输出与 stderr）+ 各资源路径。

为什么有它：打包版自带依赖，所以"在别人电脑上跑不起来"几乎不是 Python 问题，而是 adb 那一层
（自带的 `adb.exe` 被杀软拦、5037 上蹲着模拟器/Android Studio 的另一个 adb、手机没授权、没装 USB 驱动）。
界面上出错时红条右边有 **「复制诊断」**（走的就是这个方法），点一下就能把这段发给开发者。

- params：`{}`
- result：

```json
{
  "engine": { "version": "0.0.1", "python": "3.13.5", "frozen": true,
              "bundleRoot": "C:\\Users\\me\\AppData\\Local\\Temp\\_MEI0000e5a02",
              "exePath": "…\\GamePilot\\gamepilot-engine.exe", "exeSize": 201678509, "exeMtime": "2026-10-19T20:31:08" },
  "adb": { "adbPath": "…\\_MEI0000e5a02\\adb\\adb.exe", "adbExists": true,
           "adbVersion": "Android Debug Bridge version 1.0.41", "adbVersionError": null,
           "devices": ["List of devices attached", "…\\tdevice product:vermeer model:23113RKC6C"],
           "devicesError": null, "devicesExit": 0,
           "port5037Owner": "adb.exe (PID 11308)", "adbFromEnv": "…\\adb\\adb.exe" },
  "paths": { "adbDir": "…", "scrcpyServer": "…", "ocrModelDir": "…", "tempDir": "…", "cwd": "…" }
}
```

`exeSize` / `exeMtime` 那一对是给"装了新版却还跑着旧引擎"准备的：安装时旧引擎进程还占着
`gamepilot-engine.exe`，静默安装会跳过它（重装了还是老毛病）—— 拿这两个值跟刚装的那份对一下就知道。

日志里也有对应的一行（首次扫设备时自动写，不用点任何东西）：

```text
INFO gamepilot.rpc: 引擎启动: …\\gamepilot-engine.exe（201678509, 2026-10-19T20:31:08）
INFO gamepilot.devices.env: adb 环境: adb=…\\_MEI0000e5a02\\adb\\adb.exe · version=Android Debug Bridge version 1.0.41 · 5037=adb.exe (PID 11308) · 设备=1 台
```

### `device.list`

扫描可用设备（adb 真机/模拟器 + iOS + macOS / Windows 本机窗口；**不再包含 Mock**）。**第 1 块已实现**。
本机 MuMu / 雷电 / 夜神等模拟器不会自动出现在 `adb devices`，扫描时会对已在监听的常见 adb 端口
（16384 系 / 7555 / 5555 / 62001 …）补一次 `adb connect`。

Android 列表来自常驻 `adb track-devices` 监听（优先 `host:track-devices-l`，保留型号信息）。
RPC 立即读取各来源的当前快照；分辨率、多屏 `dumpsys`、模拟器补连与 iOS/macOS 扫描均在后台执行，
完成后推 `device.list.changed`。
首次快照到达前列表可以暂时为空；未授权/离线状态会照常显示。手动刷新或切回窗口会请求后台更新多屏详情，
因为 MuMu 标签页的增删不会产生设备上下线事件。同一设备的并发详情查询合并，短时间重复刷新复用结果。
`pendingAndroidSerials` 列出首次多屏详情尚未就绪的设备；这些设备暂未列出附屏时，界面保留活会话，
等后台详情完成的通知后再判断窗口是否关闭。

- params：`{ "scan": true }`（`false` 时不扫描，直接返回空列表）
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
  "errors": [{ "provider": "android", "message": "adb 列表获取失败: ..." }],
  "pendingAndroidSerials": []
}
```

约定：

- `kind`：`android` / `emulator` / `windows` / `mock` / `remote`（模拟器按串口名与型号特征判定）
- `status`：`discovered` / `connected` / `failed`；**不可用设备也要返回**，
  并带上 `error` + `suggestedFix`（UI 要显示"能照做"的修复建议）
- `resolution` 可能为 `null`（未授权/离线设备读不到），UI 必须能显示 `—`
- **绝不抛异常**：单个来源失败只进 `errors`，其它来源照常返回
- `id` 只由平台 + serial 决定，跨扫描稳定（UI 靠它做选中与记忆）；
  **多屏设备**的附屏再加物理屏 id（`android:<serial>:<physical-id>`，见下面「Android 多屏」）

### `engine.shutdown`

优雅退出。返回后进程会结束；前端通常在 `engine_stop` 之前调用它。

- params：`{}`
- result：`{ "ok": true }`

## 3.5 帧通道（不走 stdio）

`engine.frame` 的 **JPEG 不在 JSON 里**：引擎把它以原始字节写进一个 unix socket
（环境变量 `GAMEPILOT_FRAME_SOCKET`，由 Rust 桥创建并传入），host 侧读取后缓存，
前端用命令 `engine_frame` 按需取原始字节。

为什么这么做：两台设备按 15fps 推 60~143KB 的 JPEG，base64 后是 **2.4MB/s 的 JSON 行**。
和控制消息共用 stdout 时，RPC 响应会排在几万行帧后面，表现为
"界面卡在 connecting、一帧都收不到"，应用整体卡顿。

改造后：控制通道约 **17KB/5s**，RPC 往返 ~0ms。

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
| `device.list.changed` | ✅ | 设备上下线、授权状态或后台详情变化：`provider: "android" / "ios" / "macos" / "windows"`。界面重新读取列表；扫描中收到的变化合并成下一次刷新。 |
| `device.connected` | ✅ | **拿到首帧后**连接成功：`deviceId, uri, resolution, graph`，可带 `channel, linkNote, name, kind` |
| `device.disconnected` | ✅ | 主动断开：`deviceId` |
| `device.failed` | ✅ | 连接失败 / 连续三次截图失败：`deviceId, error`；截图失败可带 `channel, linkNote`，同一原因只通知一次 |
| `device.recovered` | ✅ | 截图恢复或视频转 ADB 截图后出帧：`deviceId`，可带 `channel, linkNote` |
| `engine.frame` | ✅ | 每帧画面：`deviceId, index, ts, resolution, node, pending, tick, fps, captureMs, detections[], jpeg(base64)`。fps 是实际交付节奏；scrcpy 静止画面会复用上一帧与上次的 JPEG 编码。`detections[]` 每项：`label, rect[4], score, source, state, ambiguous, candidates?`（`ambiguous=true` = 有多个同分候选；`candidates` = 同一识别器的全部不同命中，只有一个命中时不出现） |
| `engine.event` | ✅ | 状态机事件：`deviceId, seq, ts, type, node, edge, message`；旧客户端单事件模式 |
| `engine.events` | ✅ | 显式协商后的批量事件：`{ events: [engine.event 的完整 payload, …] }`；保持设备/工作流字段及顺序，每批最多 64 条，普通事件最多等待约 25ms；断点、错误、结束及生命周期通知唤醒发布器。 |
| `run.started` / `run.stopped` | ✅ | 运行控制：`deviceId` |
| `run.resumed` | ✅ | 断点暂停后继续 / 单步（`run.resume` / `run.step` 之后发）：`deviceId` |
| `engine.log` | ✅ | 引擎侧结构化日志：`level`（DEBUG/INFO/WARNING/ERROR）、`logger`、`message`、`ts`。日志仍然照旧进 stderr；这条通知是给界面的「日志」抽屉用的（**限频**：同一条消息 200ms 内只发一次） |

> 帧推送限频；adb PNG 通道约 ~550ms/帧（~1.8fps）。
> UI 不要假设固定帧率。真实时投屏要等 scrcpy 通道（H.264，目标 30~60ms）。

高频通知的约定（CONVENTIONS §11.4）：必须限频或聚合，禁止把每一帧原样推给 UI。

`engine.events.subscribe` `{}` → `{ ok: true }`：客户端订阅完成后显式开启上述批量事件。未协商时仍发送 `engine.event`，旧客户端无需改动。事件发布器与执行线程分离，最多缓存 4096 条事件；持续积压达到上限时优先省略旧普通展示通知，并通过 `engine.log` 的 `droppedEvents` 明确告警（极端全关键事件洪水也维持容量并告警）；完整事件证据仍由独立 trace.jsonl 写入路径保存。停止不能等待 GUI 事件队列腾出空间。前端把普通步骤事件按约 50ms 一次批量写入最近 500 条事件缓冲，只发布最新高亮与循环进度；错误、断点、结束及停止状态不等待该视觉批次。

### `device.connect`

连接设备并启动截图循环（**已实现**）。

- params：`{ "uri": "Android:///?serial=3387980" }`；无真机时用 `Mock:///?width=640&height=360`
- result：`{ "deviceId", "resolution", "channel", "linkNote", "graph" }`
  - `channel`：`scrcpy`（H.264，解码 ~28fps，交付按界面需要、点击 0.1ms）。
    Android **只有这一条通道**：首帧拿不到、断流、控制 socket 断开都直接报错，
    由会话层报 `device.failed` 让界面重连，不降级到 adb 截图
  - `linkNote`：通道说明（含尺寸/屏号），界面底栏直接显示
- 响应与 `device.connected` 通知都在**真正拿到首帧后**才发；截屏循环最多等 20s，空屏不会先报成功
- URI 规则：scheme 大小写不敏感；**`serial` 始终按字符串处理**
  （纯数字序列号被转成 int 会进到 subprocess 的 argv 抛 TypeError，表现为截图静默回退、慢 3 倍）

### `device.disconnect` / `device.status`

- `device.disconnect`：`{ deviceId }` → `{ ok: true }`（停止截图循环并释放设备）
- `device.status`：`{ deviceId }` →

```json
{
  "deviceId": "android:3387980",
  "running": true,
  "index": 128, "fps": 14.2, "fpsLimit": 8.0, "captureMs": 0.3,
  "channel": "scrcpy", "linkNote": "scrcpy 720×1280", "linkFps": 27.8,
  "node": "home", "pending": null, "tick": 42,
  "stats": { "ticks": 42, "actions": 3, "transitions": 1, "failed": 0, "recoveries": 0 },
  "graph": { "…": "DESIGN.md §7 的状态图" }
}
```

- `fpsLimit`：引擎截图/识别循环的**目标上限**（Android 等默认 8fps；Windows 窗口设备 20fps —
  WGC 单帧约 3ms，8fps 会白等）。界面实际收多少帧仍由 `device.stream` 决定。

### `graph.get` / `graph.save`

**状态图属于项目（脚本），不属于设备**：`deviceId` 一律**可选**。

- `graph.get`：`{}` → 项目里 `graph.json` 的内容（**没连设备也能读**，画布就用它）；
  `{ deviceId }` → 那台设备会话里的那份（带它的运行态），老调用方仍然可用
- `graph.save`：`{ graph }` → **校验后**写盘，并让**所有已连接会话热重载**
  （各自当前节点与运行态保留）—— 所以在 A 设备上录的流程，B 设备连上就能跑；
  `{ deviceId, graph }` → 只写那台设备会话那份（兼容旧路径）
- 校验失败返回 `-32603`，错误信息指明是哪个节点/边/识别器的问题
- 没有当前脚本时报「还没有选择脚本（工作流）」，不会悄悄写到引擎的 cwd

### `record.template`

从**当前帧**裁剪模板 → 落盘 `templates/<label>.png` → 注册识别器（可选建节点/边）→ 写回 `graph.json`。

```json
{
  "deviceId": "android:3387980",
  "rect": [0.35, 0.40, 0.30, 0.12],
  "label": "center",
  "threshold": 0.8,
  "nodeId": "home", "nodeName": "首页",
  "allocateNodeId": false,
  "asEnter": true, "asActionTarget": true,
  "search": "region"
}
```

- `search`（可选，恒为 `region`）：模板只记录录制区域。
  - 搜索范围**不挂在模板上**，由步骤的 `params.search` 决定（见 `recognizer.search` 一节）。
  - 新录制不再写 `"search": "full"`；老 `graph.json` 里残留的该字段也不再参与识别，
    一律按步骤配置（没配就是 `region`）。
- `allocateNodeId: true` = 「这是**新**界面，id 由引擎分配」：界面上的 `nodeId` 是本地序号
  （`node_1`、`node_2`…），应用一重启就从 1 重新数，传下来必然撞上**上一次会话**建的界面 ——
  引擎按 id 取到那个老节点，用户看到的是"我新录的界面变成了老界面"。走这条路时忽略传下来的 `nodeId`
- result：`{ "label", "mode": "template" | "color", "search": "region" | "full", "template", "rect", "nodeId", "graph" }`
  （`nodeId` = 这次模板挂到了哪个界面上，可能是引擎刚分配的；纯色降级时 `search` 恒为 `region`）
- **纯色区域自动降级成颜色识别器**（`mode: "color"`）：纯色模板在归一化互相关里是退化的，
  会在画面任意位置给满分；宁可换算法也不报假命中。颜色识别不支持整帧搜索，`search` 被忽略
- 设备还没出帧时报「还没有可用画面」，不会写出空模板

### `record.ocr`

框一块区域 + 填要认的字 → 注册 OCR 识别器（可选建节点/边）。**不裁模板图**，但照样存一张
`templates/<label>.png` 作证据（"这段文字对应屏幕哪块"），删识别器时一起清。

```json
{
  "deviceId": "android:3387980",
  "rect": [0.72, 0.08, 0.22, 0.05],
  "label": "金币",
  "text": "金币",
  "mode": "contains",
  "threshold": 0.6,
  "nodeId": "home", "nodeName": "首页",
  "asEnter": true, "asActionTarget": true,
  "search": "region"
}
```

- `text`（必填）：要识别的文字；空字符串报「OCR 识别器要填写「要识别的文字」」
- `mode`（可选，默认 `contains`）：`contains` 包含即命中 / `equals` 整段完全相等 / `regex` 正则
  （正则只给脚本手改 `graph.json` 用，界面只暴露前两种；正则写错在加载时报错）
- `threshold`（可选，默认 `0.6`）：OCR 置信度下限。比模板的 0.82 低 —— 识别模型自带噪声
- `search`：恒为 `region`（OCR 只在 `roi` 里读字，不支持整帧）
- result：`{ "label", "mode": "ocr", "search", "template", "rect", "nodeId", "graph" }`
- 写进 spec 的形状：

```json
{ "金币": { "type": "ocr", "text": "金币", "mode": "contains", "threshold": 0.6, "roi": [0.72, 0.08, 0.22, 0.05] } }
```

**运行时怎么工作（重要）**：OCR 一次要 100ms~1s，采集循环只有 8~28fps，所以识别器是
「提交一次推理 → 先用上一帧的结果」。同一时刻只有一个任务在跑；结果超过 `max_age_frames`
（默认 3 帧）就丢弃（屏幕上那行字可能已经变了）。模型没下载/子进程失败时该识别器
**不命中**，错误会出现在 `last_error` 里，并作为等待超时的原因报出来：
`等待「金币」超时（20000ms）· 识别器报错：OCR 模型未就绪`。

### `recognizer.threshold`

`{ deviceId, label, threshold }` → 写回阈值并热重载（阈值滑块拖动时调用）。

### 多目标：同一识别器命中多个时点哪一个

模板在「全屏」搜索时经常一次命中一排相同目标（剑、金币、列表项）。步骤上的
`params.strategy` 决定点哪一个，缺省 `auto` 保持老行为：只有一个就点，同分歧义就失败、不猜。

| `strategy` | 语义 |
|---|---|
| `auto`（默认） | 最高分；出现同分歧义（`ambiguous`）时直接失败 |
| `nearest` | 离识别器 `roi` 中心最近 |
| `first` / `last` | 按「从上到下、从左到右」的第一个 / 最后一个 |
| `nth` | 阅读顺序第 N 个，N 写在 `params.index`（1 开始） |
| `leftmost` / `rightmost` / `topmost` / `bottommost` | 按屏幕坐标取极值 |
| `random` | 候选里随机一个 |
| `all` | 依次点击**这一帧**的全部候选（每个之间留 ~120ms 间隔）。候选来自同一帧：点完会消失或重排的界面（列表、网格）请改用「循环 + `nearest`」，否则后面的点会落在旧位置 |

适用于 `click` / `hold` 的图像定位；`wait` / `cond` 仍然只看"有没有命中"，不参与选点。
`engine.frame` 的 `detections[].candidates` 会给出全部候选框，界面按它画多个识别框；
动作事件的 `extra` 带 `strategy / candidates / picked`，排查"点到了第几个"直接看这三个字段。

### `recognizer.search`

`{ deviceId, label, search: "region" | "full" }` → `{ label, search }`

- 兼容旧引擎/旧脚本的遗留接口：仍然写 spec 的 `"search"` 字段，但**运行时不再读取**。
- 唯一生效的配置是步骤上的 `params.search`：`click` / `hold` / `wait` / `cond` 写
  `"region" | "full"`；不写就是 `region`。
- 引擎按当前步骤把范围传给 `perceive()`，同一拍里跨到范围不同的下一步会按需重识别。

### `recognizer.enabled`

`{ deviceId?, workflowRoot?, label, enabled: boolean }` → `{ label, enabled, graph }`。

- 素材列表每行的识别开关；`enabled` 写入对应识别器 spec，旧素材未写时默认启用。
- 关闭后不调用该识别器，不再产生命中，清除此标签已有的识别分数和确认状态；重新启用后使用新识别结果，不复用关闭前的缓存命中。
- 保留素材、示例图和步骤引用。运行中切换不重置执行指针或停止其他识别器；引用它的等待/点击会按原有未命中、超时规则处理，而不是跳过步骤。
- 无设备连接时仍可设置工作流的磁盘素材。界面传入点击时的 `workflowRoot`，避免切换工作流期间误改另一个同名素材；省略时兼容当前工作流。请求失败保留原开关状态并报错。

### `recognizer.create`

`{ deviceId, label, spec }` → `{ label, graph }`

- 不录模板、直接注册一个识别器（目前用于 `type: "yolo"` 的 AI 识别器）；
- `spec` 与 graph.json 里的识别器 spec 同构，**示例优先**：
  `{ "type": "yolo", "examples": [{ "rect": [0.1,0.2,0.3,0.4], "label": "精英怪" }],
     "threshold": 0.3, "search": "region" }`
  - `rect` 是归一化坐标；引擎会把**当前画面**存成参考帧（`templates/<label>_aiN.png`），
    从示例算特征向量，之后找同类目标；
  - 文字类别（`classes`）是可选融合项，不需要时传空数组。
- 名称校验与 `recognizer.rename` 同一套；重名会被拒绝（`已经有同名识别器: ...`）。
- 落盘 + 热重载与录制流程一致，返回完整 graph，界面直接替换。

### `recognizer.detail` / `recognizer.update`

- `recognizer.detail` `{ deviceId?, label }` → `{ label, threshold, search, imgsz, tile, tileSize, tileOverlap,
  examples: [{ rect, label, image(dataURL jpeg), width, height }] }`
  素材区预览/编辑用：读回 AI 识别器的参数和示例参考图。`deviceId` 对应已连接会话时读取该会话；
  省略、为空或设备未连接时读取当前工作流的磁盘素材，无需连接设备，不修改工作流。
- `recognizer.update` `{ deviceId, label, spec, newLabel? }` → `{ label, graph, refs? }`
  更新已有 AI 识别器：示例图有 `image` 就重写 `templates/<label>_aiN.png`，
  示例减少时清掉多余旧文件，随后落盘 + 热重载。
  - 可选 `newLabel` 在同一次保存里改名并级联更新步骤/节点引用（返回 `label` 是最终名字）。
    新名字冲突时在写模板前直接报错，磁盘和运行图都不改。
  - 示例没有 `image` 时按索引复用原有的模板路径，不按新名字重拼；改名不会移动模板文件。
  - 运行中允许修改：同一工作流的运行图原地更新识别器与引用，不重置执行指针或重新加载工作流。

### `recognizer.example`

`{ deviceId, label, rect }` → `{ label, examples, graph }`

- 给已有的 AI 识别器**追加一个示例框**（同一类多个示例取平均，比单框稳）；
- `rect` 是归一化框；`image`（可选，data URL）是**这个示例自己的冻结帧**，
  引擎按它存 `templates/<label>_aiN.png`（不传才用当前画面）；
- 只对 `type: "yolo"` 生效；每加一个示例都会重算一次类向量（下一帧生效）。
- 多个 `yolo` 识别器共用一个 worker：引擎把**最近活跃识别器**（`CONFIG_TTL_S`=120s 内提交过）
  的词表+示例取并集，一次性配置后长期复用；不会每帧在不同识别器的示例之间来回切换
  （那样每个示例都要重跑一次视觉向量，实测 14s 切换 8 次、CPU 版能慢到秒级）。
  每个识别器只取自己 `classes`/示例 `label` 命中的检测框。

### `yolo.warmup`

`{ }` → 同 `yolo.status` 的状态（后台拉起 worker、加载模型，不跑推理）。
界面打开 AI 识别弹窗时调用，让「未启动」尽快变成 `GPU` / `CPU`；失败只记进 `error`，不抛错。

### `yolo.models` / `yolo.model.set` / `yolo.model.add`

- `yolo.models` → `{ models: [文件名], model, dir }`：当前生效模型目录里的 `.pt` 列表
  （装了组件就是组件 `models/`，开发态是引擎模型目录）。
- `yolo.model.set` `{ model }` → `{ models, model, dir, reloading: true }`：切换默认权重；
  会**重启 worker**，下一次推理时加载新模型（约 3–10 秒）；选择持久化在组件根目录 `model.json`。
- `yolo.model.add` `{ path }` → `{ added: [文件名], models }`：把本机 `.pt` 或
  **内含 `.pt` 的 `.zip`** 导入模型目录（zip 里的权重会平铺解压；只传路径，不走大文件上传）。

### `recognizer.frames`

`{ deviceId, count? }` → `{ frames: [{ index, jpeg, width, height, ts }] }`

- 最近帧缓冲（旧 → 新，最多 20 帧，`jpeg` 是 base64）：AI 标注弹窗用来**前后翻帧**挑一帧最清楚的当参考；
- 只用于标注挑帧，**不参与实时检测**；实时检测永远用当前帧。

### `recognizer.frames.meta` / `recognizer.frame`

- `recognizer.frames.meta` `{ deviceId }` → `{ count, firstIndex, lastIndex, width, height, indices }`
  帧缓冲元信息（引擎默认保留 30 帧，可用 `GAMEPILOT_FRAME_HISTORY` 调整，
  总字节上限 `GAMEPILOT_FRAME_HISTORY_BYTES` 默认 512MB）；`indices` 是真实帧号列表（可能跳号），界面据此做进度条。
- `recognizer.frame` `{ deviceId, index, nearest? }` → `{ requestedIndex, index, jpeg(base64), width, height, ts }`
  按帧序号取单帧（回放用）。`nearest` 默认 `false`，保持精确匹配语义：帧已被滚出缓冲时报错；
  传 `true` 时退回缓冲里**帧号最接近**的一帧（比 `firstIndex` 还老 → `firstIndex`，比 `lastIndex`
  还新 → `lastIndex`，落在跳号空隙 → 绝对差最小的一帧），缓冲为空仍然报错。`requestedIndex`
  是调用方请求的帧号，`index` 是实际返回的帧号（精确命中时两者相等），界面据此容错播放。

### AI 弹窗录制（不受滚动预览缓冲限制）

- `recording.start` `{ deviceId }` → `{ recordingId, active, count, firstIndex, lastIndex }`：启动本次录制，每台设备同一时刻只能录制一段。
- `recording.stop` `{ deviceId, recordingId? }` → 同上：停止写入，录制仍可回放。
- `recording.meta` `{ deviceId, recordingId, afterIndex?, limit? }` → `{ recordingId, active, count, firstIndex, lastIndex, indices, nextAfterIndex, hasMore }`：按帧号游标分页读取完整录制，不向 UI 一次传回整段视频。
- `recording.frameAt` `{ deviceId, recordingId, index }` → `{ requestedIndex, index, jpeg(base64), width, height, ts }`：严格返回这段录制中对应的帧，**不使用 nearest 替换画面**。
- `recording.delete` `{ deviceId, recordingId }` → `{ ok: true }`：删除录制及临时磁盘数据。录制帧持续写入临时 SQLite 文件，没有帧数上限；会话断开时也会清理临时录制。

### `recognizer.preview`

`{ deviceId, previewId?, examples: [{ rect, label }], conf?, iou?, imgsz?, tile?, tileSize?, tileOverlap? }`
→ `{ dets: [{ class, conf, bbox }], ms, inferMs, queueMs, device, width, height }`

- 弹窗「实时检测」用：用**当前画面**当参考帧，按示例算向量后跑一次检测（像素坐标框）；
- `previewId` 用来复用参考图（同一会话只算一次视觉向量），换会话时清掉旧参考图；
- `examples[].image`（可选，data URL）是每个示例自己的冻结帧：只在示例/参数变化时带一次，
  引擎按 index 落盘复用作参考图；
- `freeze`（默认 true）只冻结**检测目标帧**；实时检测请传 `false` 用当前帧；
- `tile` / `tileSize` / `tileOverlap` 打开分块检测；`bbox` 是当前画面的像素坐标；
- 同步返回；`ms` = 引擎侧总耗时，`inferMs` = 真正推理耗时，`queueMs` = 等 worker 锁
  的时间（运行时识别器也在跑时会变长）；`device` = worker 实际推理设备（`cuda` / `cpu`），
  界面用它标出 GPU/CPU —— CPU 版组件会明显慢。
- 预览期间（最后一次调用后 3s 内）**运行时 yolo 识别暂停提交**，直接复用上一次结果：
  两者共用一个 worker，不同词表/示例来回切换会把时间全花在重建类向量上，预览还会被
  运行时推理饿到十几秒。弹窗关掉 3s 后自动恢复；这段时间识别器可能按 `max_age_frames`
  返回"没命中"，属于预期行为。

### `recognizer.rename`

`{ deviceId, label, to }` → `{ from, to, refs: { nodes, edges, scores }, graph }`

- 给识别器改名，**所有引用一起改**：节点 `enter` / 边 `when`·`condition`（all_of / any_of /
  none_of）/ 动作 `target`·`to_target` / 动作里 `$score` 引用到的标签。
  少改一处，`validate()` 就会在保存时报"引用了未定义的识别器"
- `refs` 是改动处数，界面用来说明"顺带更新了几处引用"
- **模板文件不跟着改名**：spec 里存的是相对路径（`templates/x.png`），文件叫什么对匹配没影响
- 名字校验（`core/graph.py: validate_recognizer_label`）：非空、≤48 字符、不能带 `/` `\`
  或控制字符、不能用保留名 `always`（"无条件边"的哨兵值）、不能和现有识别器重名
- 前端在输入框里做了同一套规则的即时校验（`features/recognizers/recognizer-name.ts`），
  但**引擎才是权威**：它拦下来（重名、写盘失败）的原因照样会出现在错误条与事件栏

### `recognizer.remove`

`{ deviceId, label }` → `{ removed, graph }`；被节点/边引用时**拒绝删除**并列出被谁用了
（改名不需要这道限制：引用会跟着改）。

- 删的不只是 spec：`templates/<label>.png` 也会一起清掉。颜色识别器（纯色区域降级来的）
  spec 里没有 `template` 字段，但录制时同样写了那个文件 —— 只按 spec 删会留下它，
  用户会以为"没删干净"

### `run.start` / `run.stop`

`{ deviceId }` → `{ ok: true, running: boolean }`。
`run.start` 要求状态图里至少有一个节点，否则报「状态图还没有节点：先在画面上框选录制一个界面」。

### `run.status`（恢复运行态）

`{ deviceId }` → `{ deviceId, workflowRoot, running, runningWorkflowRoots: string[], runRevision }`。

- 返回设备上实际仍在运行、等待子流程或执行中的工作流目录；不把 idle/已结束的 runner 当成运行。
- 只取短会话锁，不等待执行/生命周期锁。界面重载、新窗口接管已有设备时读取此快照，不能只恢复画面而遗漏停止入口。
- `engine.frame` 同样携带 `workflowRoot`、`running`、`runningWorkflowRoots`、`runRevision`，用于漏通知后的持续对账。旧引擎没有这些可选字段时，不据此清空运行态。
- `run.started` / `run.stopped` 也携带设备会话内单调递增的 `runRevision`。前端忽略较小 revision 的运行状态，防异步旧帧覆盖新的停止/启动；设备断开后重置 revision。高亮节点本身不是运行状态的证据。
- 没有运行态时画布头部仍保留独立停止入口，向引擎发送当前工作流的停止请求；不得因画布空、扫描状态滞后或运行通知漏失而禁用停止。

### `run.resume` / `run.step` / `run.breakpoint`（调试）

- `run.resume { deviceId }` → `{ ok, paused }`：断点暂停后**继续跑到下一个断点或链尾**。
- `run.step { deviceId }` → `{ ok, paused }`：**单步** —— 放行当前这一步，执行完、进入下一步之前
  再暂停（暂停时同样发 `breakpoint_hit`，`message` 以「单步：」开头）。引擎用"进入步骤计数器"
  判断是不是"新的一步"，所以循环体回到同一节也会停。
- `run.breakpoint { deviceId, edgeId, enabled }` → `{ edgeId, enabled, breakpoints: string[] }`：
  设/清断点。参数名历史原因叫 `edgeId`，**语义是步骤 id**（`flow.steps[].id`），不要按边的思路理解。
- 断点在**执行前**停（`paused_at = step id`），引擎不再 tick 后续步骤；`run.resume` / `run.step`
  都会发 `run.resumed`。断点集合在 `run.start` **不清空**（重新运行仍保留），只清"已命中"记录。

### Android 多屏（`Android:///?serial=<serial>&display=<逻辑屏号>&physical=<物理屏id>`）

模拟器（MuMu 这类）会把「在模拟器里点开的应用」放到**另一块 Android 虚拟屏**上 —— 就是它窗口
顶上那些标签页。这不是多开实例，而是**同一台设备（同一个 adb serial）上的多块屏**。

- 扫描只发现主屏和**已有应用的附屏**：MuMu 会预留空的 display 槽位，
  `SurfaceFlinger` 报出的屏幕数不等于当前打开的标签页数；空槽没有 Activity、没有可用画面，不能作为设备。
  **设备选择器一台模拟器只显示主屏**，点它只连主屏。
  画面上方「添加屏幕」展开时自动刷新，列出未连接且已打开应用的附屏；
  切回本 App 也会自动刷新。点选后才启动该屏的 scrcpy/ADB 会话；
  已连接屏显示为可切换标签，附屏旁的 × 只断开本 App 的该屏连接，不关闭模拟器应用。
- 附屏 `id=android:<serial>:<物理屏id>`、
  `uri=Android:///?serial=<serial>&display=<逻辑屏号>&physical=<物理屏id>`；名字形如
  `MuMu 12 · 屏4 · com.netease.onmyoji.wyzymnqsd_cps`。屏号重排后 URI/名称更新，会话 id 不变。
- 屏号是**逻辑 display id**（`dumpsys display` 的 `displayId`，也是 scrcpy 的 `--display-id`）；
  抓图时内部换算成 scrcpy `display_id` 要的**物理 id**（两者不是一回事），所以 URI 里直接写物理 id 也认
- 同一台设备的不同屏是**独立会话**：各 scrcpy server 有独立十六进制 `scid`、
  `scrcpy_<scid>` socket 和临时 jar 路径；`display_id=<逻辑屏号>` 指定视频与触控目标。
- 主屏也会在内部查物理 id 并明确指定 `display_id=0`；
  不指定 `-d` 时 MuMu 多屏可能选到空附屏。scrcpy 首帧未到或断流时，
  回退**同一块物理屏**的 ADB 截图，不得拿主屏冒充附屏；`linkNote` 写明通道。
- 首帧等待默认 5s（`GAMEPILOT_SCRCPY_FIRST_FRAME_TIMEOUT` 秒可调），握手完到第一张
  解码帧才算连上；超时报错里注明等待时长与视频流状态。
- 引擎启动后**第一次**连某台设备时，会先清掉上一轮异常退出残留的 scrcpy server 和
  它留下的 `adb forward`：残留 server 会一直占着编码器，让新 server 的首帧从 ~0.2s
  退化到数秒，表现成反复「视频首帧未到」。清理由同一引擎进程对同一 serial 只做一次，
  所以本 App 多屏并行不会互相误杀；**同一台设备同一时间只应由一个引擎接管**
  （另开一个 App 窗口连接时，会清掉前一个窗口正在用的 server，前一个窗口重连即可）。
- 已连接的附屏扫描缺席时在同一次刷新里复核一次；两次均不存在才释放旧会话，
  不让空槽的旧连接继续显示黑屏；
  ADB 降级输入每次按物理 id 核对当前逻辑屏号，再发送 `input -d <当前逻辑屏号>`。
- 屏没了（标签页关掉、预留槽位没有应用或屏号重排）再连会明确报错，**不会静默退回主屏**。
- 枚举先用 `dumpsys SurfaceFlinger --display-id` 定位物理屏，再用 `dumpsys display`
  对应逻辑屏号、`dumpsys activity activities` 判断 MuMu 附屏是否真有应用；
  scrcpy 自己建的虚拟屏与 MuMu 空槽不会混进列表。

### 本机窗口列表（`window.list`）

界面上的「本机窗口」选择器用它列出**可以绑定**的窗口（统一入口，跨平台）：

- params：`{ "includeOwn": false }`（默认不列 GamePilot 自己的窗口）
- result：

```json
{
  "platform": "win32",
  "allowed": true,
  "note": "7 个可选窗口",
  "windows": [
    {
      "handle": 6698742,
      "hwnd": 6698742,
      "pid": 12345,
      "process": "Game.exe",
      "app": "Game.exe",
      "title": "某游戏 - 窗口",
      "class": "UnityWndClass",
      "label": "Game.exe — 某游戏 - 窗口",
      "x": 100, "y": 80, "width": 1280, "height": 720,
      "clientWidth": 1280, "clientHeight": 700,
      "minimized": false,
      "uri": "Windows:///?hwnd=6698742",
      "deviceId": "windows:6698742"
    }
  ]
}
```

- `platform`：`win32` / `darwin` / 其它。`allowed=false` 时 `windows` 为空，
  `note` 说明原因（macOS 缺「屏幕录制」权限时仍列出窗口，但标明抓到的是空白）
- 每一项都带 `uri` 与 `deviceId`：界面点一行就直接 `device.connect { uri }`；
  手输句柄时按平台拼 `Windows:///?hwnd=<十进制>` / `Mac:///?window=<句柄>`
- Windows 的 `handle`/`hwnd` 是 `EnumWindows` 给的 `HWND`；macOS 的 `handle` 是 `kCGWindowNumber`
- **窗口句柄会随窗口重开而变**，跨重启不要缓存 URI；窗口关闭后重连会报
  「没找到目标窗口」，重新挑一个即可

### Windows 本机窗口（`Windows:///?hwnd=<句柄>`）

把 PC 上的一个窗口当设备：只抓这个窗口的画面，点/拖/按键/打字都发给它。

- `?hwnd=<十进制>`：窗口句柄（`window.list` 里的 `hwnd`）。
  也支持 `?pid=<pid>` / `?title=<标题包含>` / `?exe=<进程名>` 作为兜底定位
- 另外支持 `?class=<窗口类名>`（例如 `UnityWndClass`、`UnrealWindow`）
- 抓图（URI 参数 `capture=`）：
  - `capture=auto`（默认）：装了可选依赖 `windows-capture` 就用 **WGC（Windows Graphics Capture，
    微软官方 API，Win10 1903+）**，否则/失败时回退下一条离线链路
  - WGC 通道：按窗口抓、支持 D3D/GPU 渲染、被其它窗口遮挡也能拿到内容；实测同一款 UE 窗口
    ~50fps、单帧拷贝 <5ms（对比 `PrintWindow` 23ms/帧）。帧是整窗 BGRA，引擎按客户区偏移裁成 BGR
  - 回退链路：`PrintWindow(PW_RENDERFULLCONTENT | PW_CLIENTONLY)` → 整窗裁剪 → `BitBlt` 屏幕 DC
    （**要求窗口可见、未被遮挡**）→ 窗口 DC；全黑帧自动跳过，全失败报错并给排查建议
  - `capture=wgc|printwindow|screen` 可强制指定；WGC 需要 `uv sync --extra wgc`（MIT，Windows-only）
- 输入通道（URI 参数 `post=`；**界面只暴露 global/sync 两档**，其余为高级档）：
  - `post=global`（**引擎默认 / 界面「前台」**）：`SendInput` 系统级输入，最可靠，会激活目标窗口并移动鼠标
    （默认 `activate=true`、`restore_cursor=true` 尽力把指针放回原处）
  - `post=sync`（**界面「后台」**）：`SendMessageTimeoutW` 把鼠标/键盘消息**直接送进窗口过程**（不经过消息队列），
    **不抢鼠标、不抢焦点**。实测 UE/Unity 这类"只处理送进来的消息"的游戏，后台点击/按键走这条通；
    目标 200ms 不响应会报错（防止把引擎拖死）
  - `post=message`：`PostMessage` 排队投递，不阻塞；部分游戏/引擎会忽略（实测同一款 UE 游戏
    后台收不到 WM_MOUSEMOVE/点击），作高级兼容档保留
  - `post=hybrid`：兼容档——动作前临时把目标窗口切前台、用真实 `SendInput`，
    动作后把焦点还原给原来的窗口（会闪一下）。游戏只认真实输入时的最后手段
  - `cursor=1`：给 `sync`/`message` 叠加"光标跟随"——手势期间临时把系统指针放到目标点、抬手放回；
    兼容那些用系统光标位置（而不是消息 lParam）算落点的 UI。**不激活窗口、不抢焦点**
- 后台消息会沿子窗口树投给**真正接收输入的子窗口**（Chromium/Electron 的
  `Chrome_RenderWidgetHostHWND`、WinForms/Tk 的控件窗口），不是一律投给顶层窗口
- `allowed` 恒为 true（Windows 没有屏幕录制授权概念）
- `channel` 返回 `win32`；`linkNote` 带进程名、标题、尺寸、输入方式与抓图通道（`抓图=wgc` 等）
- 常见限制：独占全屏（exclusive fullscreen）窗口 WGC/PrintWindow 都抓不到，需要游戏改窗口化/无边框；
  以管理员身份运行的游戏要求 GamePilot 也以管理员运行（UIPI 会拦下普通权限的输入）；
  带反作弊/驱动级原始输入的游戏，用户态消息注入仍可能无效 —— 这种只能前台 `SendInput`

### macOS 本机窗口（`Mac:///?window=<句柄>`）

- `mac.windows` → `{platform, allowed, windows:[{handle,pid,app,title,label,x,y,width,height,uri}]}`
  - `allowed=false` 表示缺「屏幕录制」权限，抓到的是空白
  - `handle` 就是 `kCGWindowNumber`，可以直接拼 URI：`Mac:///?window=89`
- 也支持 `Mac:///?pid=<pid>` 和 `Mac:///?app=<App 名>`（取该 App 最前面的窗口）
- `channel` 返回 `quartz`；`linkNote` 里带窗口标题与位置尺寸
- 新版界面统一走 `window.list`（返回同样的窗口表 + `deviceId`）；`mac.windows` 保留作兼容别名

### iOS 设备（`iOS:///?udid=xxx`）

URI 里用 `udid`（`pymobiledevice3 usbmux list` 的 `Identifier`）。

- **仅 iOS ≥ 17.4**：低版本没有可用的用户态 RSD 隧道，连接时会直接报错说明
- `channel` 返回 `dvt`（RSD 隧道 + DVT 截图，约 ~8fps / 2796×1290）；
  `linkNote` 里带分辨率与当前 USB 配置（`usb` 字段单独给一份测绘结果）
- 不需要切 USB 配置、不需要 sudo；切到配置 2 反而会让 usbmux 消失
- 控制走 pymobiledevice3 CoreDevice HID：`device.touch/tap/swipe/key/text` 全部可用；
  `back`/`recents` 映射到 Home（iOS 没有这两个键）
- 依赖：`pymobiledevice3`（默认 `uv sync` 已安装；DVT 采集 + HID）
- HID 服务由设备上的 **DeveloperDiskImage** 提供（`dtuhidd`）：没挂 DDI 时只在申请 HID 那一步报错，
  挂上即可 —— `pymobiledevice3 mounter auto-mount`（Windows 上也要这一步，macOS 平时由 Xcode 代劳）
- **一个引擎进程同时只带一台 iOS 设备**（用户态隧道是进程级单例）：连第二台会明确提示
  「先断开「某台」再连这台」，不会走到隧道那一步；多台要拆进程（见 `devices/ios.py`）

### `record.action`（把手动操作录成脚本里的一步）

`{ deviceId, action: {type, ...}, to? }` → `{ edgeId, graph }`。

画面栏开着「录操作」时，每次点击/滑动都会调它，一步 = 一条边：

- 这一步属于哪个界面？先按当前帧的识别结果判断（`Engine.locate()`，**不需要跑状态机**），
  判断不出来就用最近录过的节点
- 条件默认是"源界面的进入识别器"（在那个界面才做）；没有任何界面时退化成
  `{"always": true}`（无条件，进节点就做）
- `cooldown_ms` 默认 600：一次访问只做一次，不会 14fps 连点
- 录下来的边会记住 id；**下一次录新界面（`record.template` 建节点）时自动把 `to` 接上**，
  于是"录一个界面 → 点一下 → 再录一个界面"就得到 A --动作--> B 的完整流程
- 每次录制都会发一条 `engine.event`（type = `action_recorded`）

### `graph.node.add` / `graph.node.update` / `graph.node.remove` / `graph.edge.add`（legacy 状态图）

> **已废弃（步骤链工作流）**：当 `graph.json` 里 **`flow.steps` 非空** 时，这四个 RPC 会返回
> `ValueError`（中文说明改用 `graph.save` / `record.action`）。桌面端中间栏已不再调用它们；
> 仅保留给**没有 flow** 的旧脚本与自动化测试。

这四个方法的 `deviceId` 也**可选**：不带 = 直接改**项目脚本**（`graph.json`）并让所有会话热重载，
带 = 只改那台设备会话里的图（兼容旧路径）。

- `graph.node.add { name?, nodeId?, enter? }` → `{ nodeId, graph }`（不传 nodeId 时**分配一个没用过的 id**：
  `n_1`、`n_2`… 只增不减 —— 删过节点之后不能再用 `len(nodes)+1` 现算，那会撞上还活着的 id，
  把老界面顶掉，见 `session.next_node_id`。传了 nodeId 就是"往这个已有界面上加"）
- `graph.node.update { nodeId, patch: { name?, enter?, timeout_ms? } }` → `{ nodeId, graph }`
- `graph.node.remove { nodeId }` → `{ graph }`；**引用它的边会一起删掉**（否则图不合法）
- `graph.edge.add { from?, to?, when?, action? }` → `{ edgeId, graph }`；
  不传 `when` 时默认用源节点的第一个进入识别器（没有就退化成无条件边）

> **改了引擎方法要重启引擎**：引擎是壳在应用启动时拉起的独立进程，会一直活着；
> 代码更新后正在跑的那个仍是旧的，界面上会报 `-32601 未知方法`。
> 界面在 `engine.ready` / `engine.info` 里拿到方法表做能力校验（`apps/desktop/src/lib/engine-methods.ts`），
> 缺方法就把顶栏标成「引擎旧进程 · 重启」并给出一键重启 —— **新增前端会调用的方法时，把那行加进那张清单**。

### `project.get` / `project.set`（当前工作流）

一个工作流 = 一个目录：`graph.json`（状态图真源）+ `templates/`（录制的模板截图）。

- `project.get` → `{ root, graphPath, nodes, edges, recognizers, templates }`。
  **「没有当前工作流」是一等状态**：没选过工作流时 `root` 为空字符串（不伪造路径、不偷偷建目录），
  界面据此显示欢迎卡片。
- `project.set { dir }` → 切到该目录（不存在就创建），**热重载所有已连接设备的状态图**
  （保留各自当前节点与运行态），并广播 `project.changed`

### 工作区 › 工作流（目录）

层级：**工作区（用户选的文件夹，可以有多个；工作区就是项目）› 工作流（= 一张状态图）**。

| 方法 | 参数 | 返回 |
|---|---|---|
| `workspace.list` | `{}` | `{ active, recommended, items: [{ name, root, active, exists }] }` |
| `workspace.add` | `{ dir, name?, create? }` | `{ root, name, tree, current, items }` |
| `workspace.remove` | `{ dir, deleteFiles? }` | `{ active, items, tree, current, removed }` |
| `workspace.tree` | `{}` | `{ root, workflows: [{ name, root, nodes, edges, recognizers, templates, modified, trigger }] }` |
| `workflow.create` | `{ name }` | `{ created, current, items }`（**name 必填**，界面会先弹输入框让你起名） |
| `workflow.duplicate` | `{ dir, name? }` | `{ created, current, items }` |
| `workflow.rename` | `{ dir, name }` | `{ root, current, items }` |
| `workflow.delete` | `{ dir }` | `{ removed, current, items }` |

要点：

- **工作区 = 用户自己选的文件夹**（任意绝对路径），记在 `<配置目录>/config.json` 的
  `{ active, workspaces, names }` 里，按最近使用排序；`names` 是"显示名"（界面上输的名字，
  可以是 `我的工作区` 而目录仍叫 `game-a`）；`GAMEPILOT_CONFIG_DIR` 换配置目录，
  `GAMEPILOT_WORKSPACE_DIR` 直接覆盖当前工作区（测试逃生口，跳过配置文件）。
- **接入一个空文件夹时什么都不建**：没有默认工作流、没有默认目录，等用户点「＋」（新建会话）。
- 工作流 = 工作区根下**含 `graph.json` 的直接子目录**；隐藏目录（`.` 开头，老版本留下的 `.trash` 也在这类里）不算。
- 工作流摘要：`{ name, root, nodes, edges, recognizers, templates }`；`modified` 是 epoch 秒，
  界面用来显示「10 分钟」这种相对时间。
- **删除一律是真删除**（`shutil.rmtree`，没有回收站）：`workflow.delete` 删工作流目录，
  `workspace.remove { deleteFiles: true }` 连整个工作区目录一起删。返回里的 `removed` 是被删掉的路径。
  `deleteFiles: false` 只从工作区列表移除，磁盘一个字节不动。
  风险由**界面二次确认**兜（确认文案必须写明"删除后不可恢复"）。
- 删的是当前工作流就自动切到剩下的第一个；一个都不剩就保持"没有当前工作流"。

界面侧规矩（浮层面板、⌘O、原生选目录 + 手输兜底、添加工作区要输名字、行内二次确认、
禁止 `window.prompt`）见 **[docs/WORKSPACE-CONTRACT.md](./WORKSPACE-CONTRACT.md)** —— 那份是完整事实来源。

### `template.image`

`{ label, grayscale? }` → `{ label, mode, width, height, png }`（base64 PNG）。

界面用它显示"我录的模板长什么样"；`grayscale=true` 返回黑白版 ——
模板匹配本身就是按灰度算的（引擎 `TemplateRecognizer` 用 `IMREAD_GRAYSCALE`），
所以黑白版就是它在算法里真正的样子。

### 判断条件（边的 `condition`）

```json
{ "all_of": ["a"], "any_of": ["b", "c"], "none_of": ["popup"],
  "min_score": 0.85, "within_ms": 5000 }
```

- `all_of` 全命中 / `any_of` 任一命中 / `none_of` 都不得出现（没写 `condition` 时等价于 `all_of=[when]`）
- `min_score`：分数门槛
- `within_ms`：**限时等待** —— 进入源节点后最多等这么久；超时这条边不再走，
  并上报一条 `edge_timeout`（每条边每次进入节点只报一次）
- 已经执行过的边不会在超时后又报一次（真机跑脚本时踩到过，已修）

### 步骤链并行与 Android 多指触控

步骤链增加 `parallel` / `parallelbranch` / `parallelend`。画布仍保存显式 `_out` 连线，并把各分支线性化为独立的结构区间；**普通模块多接线不等于并行**。

```json
[
  { "id": "start", "type": "manual" },
  { "id": "p", "type": "parallel", "params": { "mode": "all", "branches": 2 } },
  { "id": "b1", "type": "parallelbranch", "params": { "parallel": "p", "branch": 1 } },
  { "id": "move", "type": "swipe", "params": { "x": 0.2, "y": 0.8, "to_x": 0.2, "to_y": 0.6, "duration_ms": 150, "hold_ms": 2000, "finger": 1 } },
  { "id": "b2", "type": "parallelbranch", "params": { "parallel": "p", "branch": 2 } },
  { "id": "skill", "type": "click", "params": { "by": "coord", "x": 0.8, "y": 0.8, "finger": 2 } },
  { "id": "joined", "type": "parallelend", "params": { "parallel": "p" } }
]
```

- `branches` 为 2–4；分隔标记编号须完整且与所属并行头一致。标记由画布管理，不作为普通模块编辑。
- `mode: "all"`：所有分支完成后继续；任一失败即取消其余分支。
- `mode: "any"`：第一个成功完成的分支胜出并取消其余；单个失败不会提前结束其它分支，全部失败才失败。空分支会立即成功。
- 同一调度拍按分支顺序推进，运行变量共享；多分支写同一变量时后执行者覆盖，跨步骤的读改写不是原子事务。
- 分支内部可有等待、条件与循环；不允许从分支中间单独启动、调用子工作流或跳出该分支外的循环。分支内 `end` 仅结束本分支。
- 原有串行工作流不需要迁移。并行内触摸动作使用独立指针与时间调度，不以阻塞睡眠执行长按、滑动或末端保持。

`click` / `hold` / `swipe` 可指定 `finger: 1..10`；未指定时由运行分支自动分配。显式指定的手指被其它分支占用时会报错，不会抢走摇杆。设备连接结果的 `capabilities: { multiTouch, maxTouchPoints }` 表示当前控制通道能力；scrcpy 协议最多维护 10 个同时按下的触点，并非对真机触控硬件的实测。

新增持续触控步骤 `touch`：`params: { phase: "down" | "move" | "up", finger: 1..10, x?, y?, duration_ms? }`。坐标是归一化 0–1；按下、移动需要坐标，移动可设轨迹时长。`down` 保持按下并继续本分支，`up` 释放该分支拥有的触点。必须使用同一手指编号配对；分支/流程结束、停止、异常或被手动接管时自动释放。持久按下不能通过“单独执行动作”绕开流程生命周期。

使用并行或持续触控的流程在手动接管时暂停并释放触点，需要用户明确继续；旧串行单指流程保留原手动输入门控行为。暂停恢复可从头重新执行被取消的当前完整手势；如果持久 `down` 已完成且游标已走到后续步骤，恢复会明确提示从并行块头重新运行，不偷偷补按旧摇杆。每个控制消息仍串行发送，但多个指针的按下生命周期可以重叠。连接断开时只能尽力发送抬手，不能保证已经损坏的通道收到释放消息；不会改用 ADB 或其它屏幕偷偷重试。

帧通知增加可选 `activeStepIds` 数组，用于同时高亮各分支，旧 `node` 字段保留兼容。

### 工作流触控映射（不监听电脑键盘）


```json
{
    {"id": "move-pad", "name": "移动摇杆", "type": "joystick", "x": 0.18, "y": 0.8, "radius": 0.1},
    {"id": "skill-1", "name": "技能一", "type": "button", "x": 0.85, "y": 0.75}
  ]
}
```

- `id` 稳定且唯一，动作引用 `id` 而不是名称；改名或移动后引用不变。
- `x/y` 是图像内归一化坐标，`radius` 是相对于图像短边的圆半径（0.02–0.4），不是屏幕横纵方向各自百分比。摇杆用它计算推杆距离；按钮的可选半径只用于画面标记大小，实际触摸落在中心。
- 画面开启「映射」编辑后，右键在光标位置添加按钮或摇杆，再拖动定位及调整半径。保存退出编辑后，映射圆环和名称继续叠加显示；展示层不截获指针事件，不代替工作流发起动作。
- 摇杆外圈用于拖动整体位置；中心摇杆头可拖动进行圆形范围预览，松手/取消即回中。中心拖动不改变映射中心、不保存推杆方向，也不发送设备输入；工作流的实际方向及力度仍由映射动作参数配置。


```json
```

- 按键映射支持 `tap`（默认 50ms）、`hold`（默认 500ms）、持续 `down`、`up`。持续按下后需要后续抬起或流程结束释放；`down/up` 不使用持续时间。
- 摇杆支持 `move`、`up`。移动首次从中心按下再移到目标方向；八方向使用圆形像素距离，对角线不额外加速。`strength: 0..1` 表示推杆幅度。
- 摇杆 `duration_ms > 0` 表示到达方向后保持多久并自动抬起，`0` 表示持续保持并继续下一步，不是无限阻塞。分支结束仍自动释放，因此持续移动需要后接等待/循环。
- `finger` 可省略自动分配，支持与其它并行分支技能触点同时存在。同映射的持续按下、移动、抬起必须在同一执行分支中配对；停止、暂停、取消和断连沿用多指清理规则。独立 `action.run` 不允许执行映射动作，避免产生无人管理的持续触点。

### 基础操作（边的 `action`）

| type | 必填 | 说明 |
|---|---|---|
| `click` | `target` / `rect` / `x`+`y` | 轻触（`target` 用识别器中心，跟随识别结果） |
| `long_press` | 同 click，`duration_ms`（默认 800） | 长按（按下-等待-抬起） |
| `swipe` | 起点 + `to_x`/`to_y`，`duration_ms` | 滑动；可选 `path` / `hold_ms` 做连续滑动（见下） |
| `wait` | `seconds` | 等待（阻塞该设备循环） |
| `key` | `value` ∈ back/home/recents/power/volume_up/volume_down/enter/delete（手机系统键）；Windows 窗口另支持 `a-z` / `0-9` / `f1-f12` / `space` / `shift` / `ctrl` / `alt` / `tab` / `escape` / 方向键等游戏键 | 按键 |
| `text` | `value` | 输入文本 |

写错的脚本在 **`graph.save` 时就会报错**（指出是哪条边、缺什么参数），不会跑起来才在手机上点空。

`swipe` 的两个可选参数（ADR 0002，老脚本不写它们时行为完全不变）：

- `path`：`[[x, y], …]` 归一化折线（≥2 点）。给了就按这条折线逐点下发，`x/y/to_x/to_y` 缺省时
  取首尾；**只有偏离直线时才需要写**（录制会先做 RDP 简化，≤32 点）。
  典型用法是推摇杆：`path: [[0.2, 0.8], [0.2, 0.55]]` + `hold_ms: 2000`
- `hold_ms`：到终点后**按住不放**多少毫秒再抬手（`0` = 松手即结束，默认）。
  有实时触控通道（scrcpy / iOS HID / macOS CGEvent）时是真的按住；只有合成滑动通道
  （adb `input swipe`）时会被并进滑动时长，引擎会在日志里明确告警。

**约定**：`dst` 为空的边（"就做这个动作"）默认**一次访问只做一次**；
想重复做就显式写 `cooldown_ms`（例如 500 = 每 500ms 一次）。

### `device.touch`（实时触控，画面栏拖动就靠它）

`{ deviceId, phase: "down" | "move" | "up", x, y }` → `{ ok }`，坐标归一化（相对**画面**，不是容器）。

- **逐事件实时注入**：拖动过程中每个 move 单独发一个 32 字节 scrcpy 报文，
  不是松手后合成一次滑动 —— 合成滑动在手机上表现为"延迟一下跳过去"，不跟手
- 坐标必须落在真正画出画面的区域上（`object-contain` 的黑边不算），
  否则竖屏画面在横容器里点边缘会偏出一大截（前端 `lib/canvas.ts` 负责换算，有单测）
- 报文参数对齐参考实现 `panda-agent/.../touch_controller.py`：
  `pointer_id=1, pressure=1, action_button/buttons=PRIMARY`。
  「手指式」指针（`pointer_id=-1, buttons=0`）在桌面上拖动易回弹，系统不认
- `down` / `up` 各发一条 `engine.event`（`manual_input`）；`move` 不发事件（一次拖动上百个）

### `device.tap` / `device.swipe` / `device.key`（脚本/状态机用的合成操作）

画面栏直接操作设备时用这三个，走 scrcpy 控制通道（点击约 **0.1ms**，比
`adb shell input tap` 的 ~1030ms 快四个数量级）：

- `device.tap { deviceId, x, y }` → `{ ok }`（坐标是**归一化**的，与帧一致）
- `device.swipe { deviceId, x1, y1, x2, y2, durationMs }` → `{ ok }`
- `device.key { deviceId, key }` → `{ ok }`；
  key ∈ `back` / `home` / `recents` / `power` / `volume_up` / `volume_down` / `enter` / `delete`

每次操作都会发一条 `engine.event`（type = `manual_input`，消息如
`手动点击 (0.139, 0.922)（0.0ms）`），所以事件栏和时间轴能看到手动操作记录。

真机验证（OPPO A57）：控制通道 tap 到桌面「拨号」图标 → 画面差异 110.0（拨号盘打开）；
返回键 → 差异 112.7。

### `device.stream`

`{ deviceId, fps }` → `{ ok, streamFps }`。界面告诉引擎"这台设备我只看 N fps"（**0 = 先别推帧**）。

- 引擎的截图、识别、状态机**照常跑**，只是不再编码 JPEG 推给界面
- 多设备同时投屏时这是最大的一笔开销：每帧 60~143KB，14fps 就是每台 1~2MB/s
- 界面的策略：单画面看的那台 10fps；多开每台 4~6fps；窗口不可见 0fps

#### 采集与执行调度

- 每设备独立采集推流、串行执行和录屏写入线程；慢识别、长按、证据落盘不占采集线程。
- 执行与录屏各只有一个最新帧槽位，忙时覆盖旧待处理帧，不积压后补。
  录屏索引允许跳号；停止录屏只保留已提交帧，不等待待处理帧，旧录屏任务不会写入新录屏。
- `engine.frame` 的 `index` / `ts` 属于当前视频帧，`detectionIndex` / `detectionTs` 属于最近完成的感知；
  超过 500ms 的感知框不再叠加。Session 的 OCR/YOLO 缓存也按源图 500ms 时效判断，完成不能续期。
- `device.status` 提供 `executionMs`、`executionFrames`、`executionIndex`、`executionDropped`、
  `recordingDropped`，与视频 `fps` 分开统计；掉执行帧表示主动跳过旧截图，不表示投屏丢帧。
- 停止运行立即置取消信号，拒绝后续输入；支持实时触控的点击/长按/滑动会提前抬手。
  仅有同步合成输入的控制器不能硬抢占已发出的调用，但不会阻塞独立投屏。

### `timeline.get`

`{ deviceId, limit }` → `{ frames: [...], events: [...], evidence: {...} | null }`（最近 N 帧摘要 + 事件 + 最近一次运行的证据摘要，供时间轴回溯）。

### 点击定位方式协议

`flow.steps[].params.by` 只接受英文枚举：`recognizer`（识别器）、`coord`（坐标点）、
`region`（矩形内随机）。显式枚举决定定位方式，不根据其它残留字段重新猜测。
省略 `by` 时才按 `rec` / `rect` 推断；显式空值、未知值及旧中文枚举均报错，不提供迁移或兼容。
界面文案、日志与用户自定义的识别器名称仍可使用中文。

识别器点击在界面上拆成「图像识别」和「AI 识别」两项，但协议都是 `by: "recognizer"`：
细分只写在 `params.ai: true`（AI）或缺省（图像），引擎不读取该字段，旧图无需迁移。

### `run.evidence`

`{ deviceId, workflowRoot? }` → `{ evidence: {...} | null }`。**最近一次运行**的证据目录（没跑过 / `defaults.evidence = false` 时 `null`）：

```json
{
  "dir": ".runs/20261018-201233",
  "steps": [
    {
      "index": 1, "stepId": "s1", "kind": "click", "ts": 1760...,
      "screenshot": "001_step_s1.jpg",
      "message": "",
      "params": { "by": "coord", "x": 0.5, "y": 0.5 },
      "result": "点击 · 0.50, 0.50",
      "score": 0.91, "matchedRect": [0.1, 0.2, 0.3, 0.4],
      "durationMs": 42
    }
  ]
}
```

- 目录在**工作流根**下的 `.runs/<时间戳>/`，只保留最近 10 次（截图占地方）；
- `params` 是这一步的实际入参（变量已求值）；`score` / `matchedRect` 只有「按识别器定位」的动作才有；
- 失败的那一步另有 `tag=failed` 的截图，`message` 里是失败原因。
- 截图编码、磁盘写入和 trace 批量 flush 在独立后台线程；执行线程只提交记录。截图最多 8 项待写（同文件保留最新任务），过载的中间截图会省略并在 `droppedScreenshots` 计数；`screenshot` 仅成功写盘后填入。
- `steps` 最多保留最近 5000 条摘要，较旧摘要数在 `droppedStepRecords` 返回，完整事件流水仍写入 trace.jsonl；事件待写缓冲约 1MiB，持续磁盘阻塞时会产生有界背压。
- 收尾最多等待后台 1 秒，不让停止无限等盘；`writerPending` / `pendingScreenshots` 公开尚未完成的写入。进程被强制终止时未写完的证据不保证保存。

### `evidence.image`

`{ deviceId, name, workflowRoot? }` → `{ name, jpeg }`（base64）。只接受证据目录里的**单层文件名**（防目录穿越），取不到直接报错。

### `action.run`

`{ deviceId, action }` → `{ ok: true, described }`。界面上的「立即执行这一步」：**不进入流程**，
直接按 §4「基础操作」的 `action` 形状执行一次（没在跑的时候会先截一帧做识别）。

### `variable.set`

`{ deviceId, name, value }` → `{ name, value }`。改**运行期**变量（调试用，不写回工作流；
下一次 `run.start` 会按 `graph.variables` 重置）。

### OCR：`ocr.status` / `ocr.load` / `ocr.recognize` / `ocr.cancel`

| 方法 | 参数 | 立即返回 | 说明 |
|---|---|---|---|
| `ocr.status` | — | `{ modelId, modelName, sizeMb, state, downloaded, loaded, progress, downloadedBytes, totalBytes, stage, error }` | 模型状态。`state` 是 `not_downloaded` / `downloading` / `downloaded` / `ready` / `error` |
| `ocr.load` | — | 立刻返回，进度走 `ocr.progress` 通知 | 后台加载 PP-OCRv4；等 RPC 返回会超时，所以不等 |
| `ocr.recognize` | `{ deviceId, rect? }` | 立刻返回，结果走 `ocr.result` 通知 | 拿当前帧做一次整图（或选区）识别 |
| `ocr.cancel` | — | `{ cancelled: true }` | 杀掉 OCR 子进程（ONNX 不支持协作式中断），会补一条 `cancelled: true` 的结果 |

- 识别是**异步**的：`ocr.recognize` 只提交任务，文字与框在 `ocr.result` 通知里回来；
- 流程里的文字识别**不走**这四个方法，而是 `ocr` 类型的识别器（见 `record.ocr`）——它每次 tick 都能重试、有超时、能进证据。

### YOLO 组件：`yolo.status` / `yolo.install` / `yolo.remove`

| 方法 | 参数 | 立即返回 | 说明 |
|---|---|---|---|
| `yolo.status` | — | `{ component, runtime }` | `component` 是组件安装状态（版本/路径/大小/manifest）；`runtime` 是 worker 是否就绪、**推理设备 `device`（cuda/cpu）**、当前生效词表与错误 |
| `yolo.install` | `{ source? }` | `{ accepted: true }`，进度走 `yolo.progress` 通知 | 从 http(s) / `file://` / 本地 zip 安装可选组件；省略 `source` 时读 `GAMEPILOT_YOLO_COMPONENT_URL` |
| `yolo.remove` | — | 卸载后的组件 status | 删掉当前版本（其它版本目录保留，便于回滚） |

- 组件是**可选下载**：独立 worker（内含 torch + 模型）装在用户数据目录，主安装包保持轻量；
- 组件分 **CPU / CUDA 两种变体**（`manifest.variant`）：有 NVIDIA 显卡装 CUDA 版（约 4~5GB，
  推理 ~15~20ms），否则 CPU 版（约 400MB，推理 ~60ms/次）；装错变体会在日志里出现
  `AI 组件在 CPU 上推理（variant=cpu）…` 的 warning，弹窗检测行也会标 `CPU`；
- 安装是**异步**的：`yolo.progress` 依次给出 `downloading` / `extracting` / `verifying` / `done` / `error`；
- 组件的 manifest 会校验名称、版本和 worker 文件，失败不会改动当前版本；
- `yolo` 类型识别器在组件/依赖不可用时返回"没命中"，不会拖垮状态机。

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
| 2 | 2026-10-12 | **删除不再走回收站**：`workflow.delete` / `workspace.remove {deleteFiles:true}` 改为真删除；响应字段 `trashed` → `removed`，`workspace.list/add/remove` 去掉 `trashRoot`（破坏性：删字段） |
| 2 | 2026-10-18 | 新增 `run.step`（单步）与 `run.resumed` 通知；`run.resume` / `run.breakpoint` 补文档（纯新增，向后兼容） |
| 3 | 2026-10-18 | 新增 `record.ocr`（OCR 识别器，spec `type: "ocr"`）；识别器类型从 `template`/`color` 扩到 `template`/`color`/`ocr` |
| 2 | 2026-10-18 | 动作 `swipe` 新增可选 `path`（连续滑动轨迹）/ `hold_ms`（末端保持）；`record.action` 与录制同时支持（纯新增，向后兼容） |
| 2 | 2026-10-19 | 新增 `engine.diagnostics`（环境快照：引擎身份 + adb 路径/版本/5037/adb devices），纯新增 |
| 2 | 2026-10-18 | 新增可选字段/方法（向后兼容，不升版本）：`record.template` 的 `search`、识别器 spec 的 `search`、`recognizer.search` 方法、flow 步骤 `params.search` 覆盖；`engine.frame.detections[]` 增加 `ambiguous` |
| 3 | 2026-10-20 | 步骤新增可选 `params.strategy` / `params.index`（多目标选择）；`engine.frame.detections[]` 增加可选 `candidates`；动作事件 `extra` 增加 `strategy / candidates / picked` |
| 2 | 2026-10-22 | 新增 `window.list`（本机窗口统一枚举，返回可直接连接的 `uri` / `deviceId`）+ Windows 窗口设备 `Windows:///?hwnd=<句柄>`（`channel=win32`，`post=global/message`）；`mac.windows` 与 `Mac://` 保留（纯新增，向后兼容） |

## 7. 手工调试

不启动 GUI 也能验证引擎（stdout 就是协议流）：

```bash
cd engine
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"engine.ping","params":{}}' | uv run python -m gamepilot.rpc
```

期望输出两行：先 `engine.ready` 通知，再 `id=1` 的响应。

Rust 桥的往返也有测试守着：`cd apps/desktop/src-tauri && cargo test`。

