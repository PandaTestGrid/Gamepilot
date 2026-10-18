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
| 当前版本 | `PROTOCOL_VERSION = 2` |

**铁律**：引擎 stdout 只能出现协议帧；所有日志走 stderr。

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

### `device.list`

扫描可用设备（adb 真机/模拟器 + iOS + macOS 窗口；**不再包含 Mock**）。**第 1 块已实现**。
本机 MuMu / 雷电 / 夜神等模拟器不会自动出现在 `adb devices`，扫描时会对已在监听的常见 adb 端口
（16384 系 / 7555 / 5555 / 62001 …）补一次 `adb connect`。

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
  "errors": [{ "provider": "android", "message": "adb 列表获取失败: ..." }]
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
| `device.connected` | ✅ | **拿到首帧后**连接成功：`deviceId, uri, resolution, graph`，可带 `channel, linkNote, name, kind` |
| `device.disconnected` | ✅ | 主动断开：`deviceId` |
| `device.failed` | ✅ | 连接失败 / 连续三次截图失败：`deviceId, error`；截图失败可带 `channel, linkNote`，同一原因只通知一次 |
| `device.recovered` | ✅ | 截图恢复或视频转 ADB 截图后出帧：`deviceId`，可带 `channel, linkNote` |
| `engine.frame` | ✅ | 每帧画面：`deviceId, index, ts, resolution, node, pending, tick, fps, captureMs, detections[], jpeg(base64)`。fps 是实际交付节奏；scrcpy 静止画面会复用上一帧与上次的 JPEG 编码。`detections[]` 每项：`label, rect[4], score, source, state, ambiguous`（`ambiguous=true` = 有多个同分候选，界面提示、点击拒绝猜） |
| `engine.event` | ✅ | 状态机事件：`deviceId, seq, ts, type, node, edge, message` |
| `run.started` / `run.stopped` | ✅ | 运行控制：`deviceId` |
| `run.resumed` | ✅ | 断点暂停后继续 / 单步（`run.resume` / `run.step` 之后发）：`deviceId` |
| `engine.log` | ✅ | 引擎侧结构化日志：`level`（DEBUG/INFO/WARNING/ERROR）、`logger`、`message`、`ts`。日志仍然照旧进 stderr；这条通知是给界面的「日志」抽屉用的（**限频**：同一条消息 200ms 内只发一次） |

> 帧推送限频；adb PNG 通道约 ~550ms/帧（~1.8fps）。
> UI 不要假设固定帧率。真实时投屏要等 scrcpy 通道（H.264，目标 30~60ms）。

高频通知的约定（CONVENTIONS §11.4）：必须限频或聚合，禁止把每一帧原样推给 UI。

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
  "index": 128, "fps": 14.2, "captureMs": 0.3,
  "channel": "scrcpy", "linkNote": "scrcpy 720×1280", "linkFps": 27.8,
  "node": "home", "pending": null, "tick": 42,
  "stats": { "ticks": 42, "actions": 3, "transitions": 1, "failed": 0, "recoveries": 0 },
  "graph": { "…": "DESIGN.md §7 的状态图" }
}
```

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

- `search`（可选，默认 `region`）：模板的搜索范围。
  - `region`：只在 `rect`（写进 spec 的 `roi`）里找，行为与老版本一致；
  - `full`：整帧找，`roi` 仍然写入（切回 `region` 时复用），spec 里多一个 `"search": "full"`。
    用于「同一个按钮可能出现在屏幕任意位置」；命中后 `rect` 是它当前的位置，点击仍准。
    性能：大区域走引擎内部的降采样粗搜 + 原分辨率复核。
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
- `search`：同 `record.template`（`region` / `full`），OCR 也支持整帧读字
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

### `recognizer.search`

`{ deviceId, label, search: "region" | "full" }` → `{ label, search }`

- 切换已有模板的**默认**搜索范围并热重载（运行中也能改，和改阈值一样）。
- `full` 写入 spec 的 `"search": "full"`；切回 `region` 时**删掉该字段**（默认值不落盘）。
- `roi` 不删：它是录制时的原区域，切回 `region` 时还要用。
- 只有模板识别器支持；颜色识别器会报「不是模板识别器」。非法值报「未知识别器搜索范围」。
- **步骤链可以按步骤覆盖**（优先级高于模板默认）：`click` / `hold` / `wait` / `cond` 的 params
  写 `"search": "region" | "full"`；不写或写 `"auto"` 时用模板默认。
  引擎按当前步骤把覆盖传给 `perceive()`，同一拍里跨到范围不同的下一步会按需重识别。

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
- 已连接的附屏扫描缺席时在同一次刷新里复核一次；两次均不存在才释放旧会话，
  不让空槽的旧连接继续显示黑屏；
  ADB 降级输入每次按物理 id 核对当前逻辑屏号，再发送 `input -d <当前逻辑屏号>`。
- 屏没了（标签页关掉、预留槽位没有应用或屏号重排）再连会明确报错，**不会静默退回主屏**。
- 枚举先用 `dumpsys SurfaceFlinger --display-id` 定位物理屏，再用 `dumpsys display`
  对应逻辑屏号、`dumpsys activity activities` 判断 MuMu 附屏是否真有应用；
  scrcpy 自己建的虚拟屏与 MuMu 空槽不会混进列表。

### macOS 本机窗口（`Mac:///?window=<句柄>`）

- `mac.windows` → `{platform, allowed, windows:[{handle,pid,app,title,label,x,y,width,height,uri}]}`
  - `allowed=false` 表示缺「屏幕录制」权限，抓到的是空白
  - `handle` 就是 `kCGWindowNumber`，可以直接拼 URI：`Mac:///?window=89`
- 也支持 `Mac:///?pid=<pid>` 和 `Mac:///?app=<App 名>`（取该 App 最前面的窗口）
- `channel` 返回 `quartz`；`linkNote` 里带窗口标题与位置尺寸

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

### 基础操作（边的 `action`）

| type | 必填 | 说明 |
|---|---|---|
| `click` | `target` / `rect` / `x`+`y` | 轻触（`target` 用识别器中心，跟随识别结果） |
| `long_press` | 同 click，`duration_ms`（默认 800） | 长按（按下-等待-抬起） |
| `swipe` | 起点 + `to_x`/`to_y`，`duration_ms` | 滑动；可选 `path` / `hold_ms` 做连续滑动（见下） |
| `wait` | `seconds` | 等待（阻塞该设备循环） |
| `key` | `value` ∈ back/home/recents/power/volume_up/volume_down/enter/delete | 功能键 |
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

### `timeline.get`

`{ deviceId, limit }` → `{ frames: [...], events: [...], evidence: {...} | null }`（最近 N 帧摘要 + 事件 + 最近一次运行的证据摘要，供时间轴回溯）。

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
      "params": { "by": "坐标", "x": 0.5, "y": 0.5 },
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
| 2 | 2026-10-18 | 新增可选字段/方法（向后兼容，不升版本）：`record.template` 的 `search`、识别器 spec 的 `search`、`recognizer.search` 方法、flow 步骤 `params.search` 覆盖；`engine.frame.detections[]` 增加 `ambiguous` |

## 7. 手工调试

不启动 GUI 也能验证引擎（stdout 就是协议流）：

```bash
cd engine
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"engine.ping","params":{}}' | uv run python -m gamepilot.rpc
```

期望输出两行：先 `engine.ready` 通知，再 `id=1` 的响应。

Rust 桥的往返也有测试守着：`cd apps/desktop/src-tauri && cargo test`。

