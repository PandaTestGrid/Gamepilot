# 冗余代码与模块化：本轮处理 + 后续方向

对上万行的两端代码做了一遍「谁在用」的实测扫描（不是读 README），把**确认没人调用**的删掉、
把**同一件事写了两遍**的列成收口清单、把**该拆的大文件**按现有测试边界标出拆分点。

扫描方法：解析 `import`/`from` 语句解析真实引用（`@/` 与相对路径都解析），排除测试文件后
统计「生产代码里有没有引用方」；Python 侧另排除 `@server.method` 装饰器注册的 RPC handler
（反射调用，扫不到调用方≠死代码）。仓库不是 git 仓库，删除前已备份到 `/tmp/gp-unused-backup/`
（前端，保持原路径）与 `/tmp/engine-backup.tgz`（引擎）。

## 1. 已删除（本轮）

| 位置 | 是什么 | 为什么能删 |
|---|---|---|
| `apps/desktop/src/layout/Toolbar.tsx` | 文件里自己写着"已废弃"的空占位 | 入口都搬进了就近面板（`GraphToolbar` / `ScreenPane` / `DeviceTabs`） |
| `apps/desktop/src/layout/RunButton.tsx` | 运行/停止按钮 | `GraphToolbar.tsx:28` 直接调 `useRunControl()`，没有任何文件 import 它 |
| `apps/desktop/src/features/graph/VariablesPanel.tsx` | v3「黑板」变量面板 | 全仓零引用；v4 的变量在步骤里（`setvar` + `$变量名`） |
| `apps/desktop/src/lib/{variable-usage,graph-logic,node-hit,param-vars,action-pins,edge-status}.ts` | 6 个只有自己测试在用的 v3 纯函数模块 | 唯一的生产引用方是已删的 `VariablesPanel`，其余引用全在 `.test.ts` |
| 上述 6 个模块的 `.test.ts` | 死代码的测试 | 留着会让人以为这些函数是活 API |
| `apps/desktop/src/lib/graph-adapter.ts` 的 `toParamPayload` / `toConditionPayload` / `toActionPayload` | UI → `graph.json` 的**边/条件/动作写回通道**（112 行，占该文件 38%） | v4 之后没人写回边，`graph-adapter.test.ts` 里对应的 3 个 describe 一起删 |
| `apps/desktop/src/lib/rpc.ts` 的 `graphNodeAdd/Update/Remove`、`graphEdgeAdd` | 旧状态图的写操作 RPC 封装 | 四个函数都只有定义 + `@deprecated` 注释；引擎侧对应 handler 在 `flow.steps` 非空时本来就会被 `reject_legacy_graph_edit` 拒绝 |
| `apps/desktop/src/lib/rpc.ts` 的 `actionRun`、`GraphEdgePayload` | 零调用封装 / 零引用 interface | `timelineGet` 保留（`timeline.get` 仍是有效 RPC，`RunEvidenceBundle` 靠它取形状说明） |
| `apps/desktop/src/lib/format.ts` 的 `formatTime/formatScore`、`manual-input.ts` 的 `flushManualInput`、`pinyin-lite.ts` 的 `charPinyin`、`device.store.ts` 的 `MAX_ACTIVE_DEVICES`、`flow-loop-progress.ts` 的 `LoopProgressPayload`、`layout-specs.ts` 的 `EDITOR_SPLIT_LAYOUT` | 13 个零引用零测试导出 | 逐个确认 0 生产引用、0 测试引用 |
| `apps/desktop/src/features/graph/flow/flow-structure.ts` 的 `disconnectCondLoopBack` / `disconnectBodyLoopBack`（连带只为后者服务的 `innermostCondBranchOf`） | 反向断环 | 只有「连」没有「断」的入口，界面从不调用 |
| `engine/src/gamepilot/core/flow_model.py` 的 `empty_flow()` | 未被调用的辅助函数 | 全仓仅定义处 |
| `engine/src/gamepilot/core/graph.py` 的 `roi_of()` | 同上 | 连带让 `Rect` import 变成 F401，已一并清掉 |
| `engine/src/gamepilot/core/state_machine.py` 的 `_timeout_key()`、`_rect_center()` | 同上（`_as_float` 仍被 `:649` 使用，保留） | 全仓仅定义处 |
| `engine/src/gamepilot/devices/ios.py` 的 `asyncio_wait_for()`、`ios_usb.py` 的 `AppleUsbDevice.is_iphone` | 同上 | 全仓仅定义处 |
| `engine/src/gamepilot/session.py` 的 `_same_workflow()` | 同上 | 路径比较已改用 `_root_key` |

顺带补了一处**资源泄漏**：`engine/src/gamepilot/rpc/stdio.py` 的 `run()` 在 `os._exit(0)` 之前
没有清理设备会话，退出时 scrcpy 子进程会变成孤儿；现在先调 `SessionManager.stop_all()`。

## 2. 已修的口径漂移（比死代码更危险：静态检查发现不了）

| 问题 | 事实 | 现在的行为 |
|---|---|---|
| `double_click` 被静默改写成单击 | `engine/src/gamepilot/core/actions.py:29` 的 `ACTION_TYPES` 有它，但 `apps/desktop/src/lib/graph-adapter.ts` 的 `known` 白名单没有 → 读进来显示为 `click`、保存又写回 `click`，用户的动作**永久丢失** | 白名单补上 `double_click`，`types.ts` 的 `EdgeAction['type']` 同步 |
| 全局默认值"显示值 ≠ 生效值" | 抽屉手抄 17 个默认值（步骤间隔 300ms、长按 800ms、抖动 30ms、阈值 0.85），引擎兜底是 0 / 600 / 0 / 0.82 | `DEFAULT_FLOW_GLOBAL_CONFIG` 全部对齐引擎兜底，并在注释里写明"必须等于引擎兜底" |
| `retry_interval_ms` 是空转滑块 | 前端有这个字段，引擎全仓 0 处引用 → 调它没有任何效果 | 引擎真正实现：重试前按 `retry_interval_ms` 冷却（`FlowEngine._note_retry_wait` + `_retry_ready_at`），带单测 |
| 打开旧图 = 装一个每天 9 点的定时任务 | `apps/desktop/src/stores/graph.store.ts` 的 `DEFAULT_WORKFLOW_FLOW` 是 `schedule at 09:00`，打开没有 `flow` 的旧图就落盘，引擎的 `_arm_auto_trigger` 会真的每天跑 | 默认触发块改成 `manual`（手动点运行才跑） |
| 节点备注被超时顶替 | `graph-adapter.ts` 把 `note` 写成 `timeout ${timeout_ms}ms`，而引擎的 `Node.note` 是真实备注字段 | 直接映射 `note`，超时不再占用这个字段 |
| `TraceEventType` 是过期名单 | 前端声明 15 个事件，引擎实发 27 个（断点、重试、子流程、循环都没有），消费方全靠 `String(event.type) ===` 与 `as TraceEventType` 绕过类型 | 联合类型按引擎实发事件重写（另加前端自己合成的 6 个），`EngineEventPayload.type` 直接用这个联合类型，`flow-console.ts` 的三处字符串比较改直连 |

## 3. 还没动、但建议尽快做的（按性价比排）

### 3.1 契约生成（治本，先做「止血版」）

现在同一份接口有 5 份手抄副本，`docs/CONVENTIONS.md:194-200` 自己写着"三处必须同步"，但没有任何校验：

- `engine/src/gamepilot/protocol.py:42-113`（51 个 `METHOD_*`）↔ `apps/desktop/src/lib/rpc.ts` 的字符串字面量
  ↔ `apps/desktop/src/lib/engine-methods.ts`（只列 9 条"必需"）↔ `ConsolePane.tsx` 的命令补全列表
  ↔ `docs/rpc.md` 的方法表 ↔ `apps/desktop/src-tauri/src/engine.rs` 的超时分支。
- 步骤类型：`engine/src/gamepilot/core/flow_model.py:14-37` ↔ `apps/desktop/src/features/graph/flow/flow-step-meta.ts:27-46`
  （目前恰好一致，但没有东西守着）。
- 默认值与阈值：前端抽屉 17 键 + 引擎 14 个 `graph.default()` 键 + `ClickHumanConfig` / `SwipeBezierConfig` + 8 处 `0.82` + OCR 的 `0.6`。

**止血版（半天）**：在 `engine/tests/` 加一条测试，断言 `protocol.py` 的 `METHOD_*` 集合、
`rpc/` 里实际注册的 handler 名集合、`docs/rpc.md` 的方法表、前端 `rpc('x')` 字面量集合四者一致。
**治本版**：`protocol.py` → `contract/methods.json` → 生成 TS 常量 + 文档表格 + `engine-methods.ts`，CI 里 `--check`。

步骤参数的形状是最大的空白：`flow_model.validate_flow` 只管 id/引用/块配对，完全不管 `params`；
前端散在 10+ 个 `flow-*-params.ts` / StepFields 里。建议一份 JSON Schema 双端校验，错误文案只写一处。

### 3.2 引擎侧重复（有真实行为差异，不只是丑）

| 重复 | 位置 | 风险 |
|---|---|---|
| `_as_int` **4 份语义互相矛盾** | `core/flow_engine.py:28`（静默回退）、`core/state_machine.py:640`（能转 `"300"`）、`core/bezier_trajectory.py:95`（`round()`，非数字抛）、`core/actions.py:201`（非数字抛） | 同一个 `duration_ms: "300"` 在三条路径三种结果 |
| `_same_path` 3 份逐字相同、`_abs` 3 份 | `config.py:61`、`workspace.py:49`、`rpc/workflows.py:91`；`config.py:56`、`library.py:50`、`rpc/workflows.py:86` | 改一处不改另一处就是跨平台路径 bug |
| RPC 参数样板 | `rpc/session.py:116` 的 `_require_str` 与 `rpc/workflows.py:49` 的逐字相同；`rpc/session.py` 里 20 处 `manager.get(_require_str(params, "deviceId"))` | 每个新方法都抄一遍 |
| 双引擎同义方法 | `_resolve_point`（`state_machine.py:523` vs `flow_engine.py:1256`，≈95% 相同）、`_press` 92%、`state` 82% | 修一个 bug 要改两处，容易漏 |

**建议顺序**：先建 `engine/src/gamepilot/paths.py`（`norm_path`/`same_path`/`same_dir`）把 6 处收口，
再把 `_as_int` 统一到 `core/coerce.py` 并**明确一种语义**（建议：数字字符串可转、非法值回退，
需要"报错"的路径显式 `raise`），最后才动 `EngineCore` 抽象基类。

### 3.3 前端「两份实现」（真正的浪费不是复制粘贴）

- ~~`SingleScreen` 与 `use-screen-surface.ts` 两份实现~~ **已合并（2026-10-19）**：`SingleScreen` 现在只用
  `useScreenSurface` 拿测量/换算/手势，自己只保留"画什么"（波纹、轨迹、十字准星、草稿/OCR/识别框浮层）。
  `ScreenPane.tsx` 1835 → **1590 行**，hook 344 → 389 行（多出来的是回调契约与注释）。
- ~~`liveScore` 同名不同语义~~ **已统一**：只有 `use-screen-surface.ts` 里的 `export function liveScore(frame)`
  （取 `detections` 最大值），`ScreenPane.tsx` 那份删掉了。
- 合并时顺手对齐的两处行为：网格里"待录滑动却只点了一下"现在也会提示（原来只有单画面提示）；
  录制坐标统一留 4 位小数（原来网格写 15 位浮点、单画面写 4 位）。
- `lib/coerce.ts` 只有 13 行 1 个函数，却是天然的收口点：现在有 4 套强制转换
  （`graph-adapter.ts:28`、`workspace-tree.ts:23`、`log.store.ts:31`、`coerce.ts:2`），
  语义互不一致（什么时候把数字变字符串、什么时候返回空串），另有 17 处手写 clamp 和 2 份 `optionalNumber`。

### 3.4 文件拆分（按现有测试边界切）

拆分边界已经现成：`MaterialArea.test.tsx`、`ScreenPane.empty-state.test.tsx` 就是两个独立测试文件。

| 文件 | 行数 | 建议 |
|---|---|---|
| `apps/desktop/src/features/device/ScreenPane.tsx` | 1590 | `SingleScreen` 已迁到 `useScreenSurface`；下一步拆 `ScreenGrid` / `MaterialArea`（366 行）/ `TouchFeedback` / `EmptyState` |
| `engine/src/gamepilot/session.py` | 1383 | 先拆零风险的图编辑纯函数（`:56-235` → `core/graph_edit.py`），再把录制（`:755-1208`）拆成 `recording.py` |
| `apps/desktop/src/stores/graph.store.ts` | 1245 | 按域拆 slice：加载 / 步骤链编辑 / 快照 / 位置 |
| `apps/desktop/src/stores/session.store.ts` | 1138 | 引擎生命周期 / 运行控制 / 录制 / 识别器 CRUD |
| `apps/desktop/src/lib/rpc.ts` | 890 | 类型（31 个 interface）与传输、按域调用分开 |
| `apps/desktop/src/features/graph/flow/flow-structure.ts` | 796 | 块解析 / 连接规则 / 单元搬移 三块，彼此只通过 `StructureResult` 通信 |
| `engine/src/gamepilot/core/flow_engine.py` | 1430 | 动作执行 / 控制流 / 证据 / 设置 四块；`devices/ios.py`（1209）同理 |

`apps/desktop/src/features/graph/flow/` 已经 65 个文件、中位数 ~90 行，**继续往下碎不如先拆上面这几个大块**。

## 4. 明确不建议动的

- `@server.method` 注册的 RPC handler（扫不到调用方是正常的，它在被反射调用）。
- 只为单测导出的纯函数（`resolveInsertAfterStepId`、`isTypingTarget`、`parentDir` 等）：prodRefs=0 但 testRefs 2~7，
  这是"纯函数 + 单测"的正常设计，不是死代码。
- 有测试覆盖、但生产零调用的 4 个 store action：`graph.store.ts` 的 `moveNode`、
  `ui.store.ts` 的 `toggleRecording` / `setRightTab`、`template.store.ts` 的 `cachedTemplate`。
  它们确实没人用，但删它们要同时删对应测试（**测试正在保护死代码**），建议放进下一次批量清理，
  和上面 3.4 的 store 拆分一起做，避免"改测试 → 改实现"的来回。
