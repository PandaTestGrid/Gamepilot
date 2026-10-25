# 执行计划（按批次交付）

> 依据：[docs/feature-audit.md](./feature-audit.md)（代码级盘点）。
> 原则：**先接通已造好的，再补真空白**；每项都要能被你亲手验证，不靠"应该可以"。

## 0. 范围

**本期做**：批次 A（5 项，修通已实现但没接线的能力）→ 批次 B（4 项，稳定性与多设备）→ 批次 C（差异化，按需）。

**本期不做**：

| 不做 | 原因 |
|---|---|
| Windows 控制器 | 你目前没有 Windows 机器，写完无法验证。整理成 `BACKLOG-W`，接口预留（见 §5） |
| 多点触控 / 双指手势 | 现有后端只有单指注入（`engine/src/gamepilot/devices/scrcpy.py:46` `POINTER_ID_MOUSE = 1`），目标游戏若不需捏合就不做 |
| 触摸轨迹级宏录制（P2） | 投入产出比低，`flow_record.py` 现有的"动作→步骤"已够用 |
| AI 流程助手 | 硬依赖批次 A 的 A3（结构化执行日志），否则 AI 无据可依 |

---

## 0.1 进度（滚动更新）

| 项 | 状态 | 说明 |
|---|---|---|
| 工程卫生（A0） | ✅ 2026-10-18 | ruff 0 错误；顺手修掉一个一直红的单测（`connect_local_emulators` 默认参数绑定问题，见 A1 记录） |
| A1 `setvar` 接线 | ✅ 2026-10-18 | 见 §2 A1 的「完成记录」；4 条验收里「变量页签显示 5」待你在 GUI 里点一次确认 |
| A2 断点 / 单步 UI | ✅ 已完成 2026-10-18 | 见 §2 A2 的「完成记录」 |
| A3 执行记录 + 证据落盘 | ✅ 已完成 2026-10-18 | 见 §2 A3 的「完成记录」；下一步 A4 |
| A4 OCR 成为第三种识别器 | ✅ 已完成 2026-10-18 | 见 §2 A4 的「完成记录」；下一步 A5 |
| A5 启用多尺度 | ✅ 已完成 2026-10-18 | 见 §2 A5 的「完成记录」；批次 A 收尾 |
| 批次 B / C / BACKLOG-W | ⬜ 未开始 | |

---

## 1. 现状一览：已实现 / 未实现

| 模块 | 已实现（可直接用） | 未实现 / 待补 |
|---|---|---|
| 设备 | Android adb + scrcpy 通道、iOS 17.4+、macOS 窗口、Mock | Windows；多指；iOS 一进程一台 |
| 识别 | 模板匹配（粗搜加速、NMS、歧义检测）、颜色识别、实时框与分数、阈值/ROI/搜索范围 | 多尺度未启用；OCR 未入链；无多目标列表；无算法选择 |
| 流程 | 条件判断、固定次数循环+跳出、等待、动作、出错重试/继续/回退、定时/间隔触发器 | `setvar` 空转；无 while；子流程无参无返回；无 recovery 块 |
| 录制 | 点/长按/滑动/等待 → 步骤 | 按键/文本/双击录不到；无单步回放 |
| 调试 | 引擎断点/续跑、单步执行动作、事件流 | 前端零入口；无每步参数/分数/截图；无失败快照；时间轴占位 |
| 多设备 | 每设备独立会话与线程、单设备多流程并行、同时投屏与手动控制 | UI 无批量启动；无队列/并发上限；无成功率汇总 |
| 平台 | 工作区/工作流目录化、`graph.json` 可 diff、导入导出（前端） | 后端无 export/import RPC；无 HTTP/CLI |

---

## 2. 批次 A：接通已造好的（预计 1.5 周）

### A1 `setvar` 接线（0.5 天）· ✅ 已完成 2026-10-18

**问题**：`engine/src/gamepilot/core/flow_model.py:36` 把 `setvar` 登记为合法步骤，但 `engine/src/gamepilot/core/flow_engine.py:525-572` 的分支链没有它，落到 `:569-572` 记一步就跳过 —— 运行时空转。

**实际改动（与计划的差异写在后面）**
- `engine/src/gamepilot/core/flow_engine.py`
  - `_advance` 增加 `elif kind == "setvar":` 分支 → `_perform_setvar(params)`，成功后 `_emit("action_executed")`、`stats["actions"] += 1`。
  - 动作分支的失败处理抽成 `_handle_failure(step_id, params, message) -> str`（`retry/continue/fallback/fail`），`click` 等动作与 `setvar` 共用，避免两处各写一份游标逻辑。
  - 新增 `_resolve_setvar_value(raw) -> VarValue`：`{"$var"/"$expr"/"$score"}` 走 `resolve_value`；`$` 开头当表达式（`$次数 + 1`）；纯数字串转数字；其余当字面量。
  - 新增模块级 `_as_var_value(value) -> VarValue`：表达式算出 list/dict 时转字符串，避免把容器塞进变量表。
- `engine/src/gamepilot/core/flow_model.py`：`validate_flow` 在 `strict=True` 时校验 `setvar` 的 `name` 非空；顺带把 `loopbreak` 的位置校验抽成 `_validate_loopbreak(params, frames)`（消掉一处 SIM102）。
- `apps/desktop/src/features/graph/flow/flow-step-meta.ts`：`FLOW_MODULE_GROUPS` 的「流程」组加「赋值」条目（`defaultParams: { name: '', value: '' }`）。
- `apps/desktop/src/features/graph/flow/flow-context-menu.ts`：右键菜单提示补 `setvar`。
- `engine/tests/test_flow_engine.py`：新增 3 个用例（字面量+表达式累加、`$var`/`$expr` 引用与自动建变量、缺变量名时整链失败）。

**与计划的差异及原因**
- **没有**在 `graph.py` 保存时校验「引用的变量已定义」：`setvar` 的语义是"写"，未定义变量应当被自动创建（`VariableStore.set` 本来就这么做）。若保存时强校验，用户必须先在某处定义变量才能赋值，等于把 C 批的"变量管理"提前成了硬前置。
- 因此运行期变量是宽松的：`$次数 + 1` 在 `次数` 未定义时抛 `KeyError` → 该步失败并按 `onError` 策略处理（这是可解释的失败，不是静默 0）。

**验收**
- ✅ 引擎：`次数` 初值 0，循环 3 次每次 `$次数 + 1`，结束后变量为 3。
- ✅ 引擎：`{"$var": "名字"}` / `{"$expr": "1 + 2"}` 等价写法可用；中文变量名可用。
- ✅ 引擎：变量名留空 → 整链失败并给出「「赋值」没写变量名」。
- ⬜ GUI：画布拖出「赋值」、跑一遍、变量页签看到累加结果（需要你在桌面上验一次）。

**顺带修掉的两个既有问题**
- `engine/src/gamepilot/devices/android.py` `connect_local_emulators`：`is_open` 原为默认参数（def 时就绑定了 `_port_open`），单测 monkeypatch 探测函数无效 → `tests/test_device_discovery.py::test_connect_local_emulators_reports_new_connection` 一直红。改为调用时解析 `is_open or _port_open`。
- 仓库里 9 个 ruff 报错（`ocr.py`/`ocr_worker.py`/`devices/__init__.py`/`rpc/session.py`/`tests`）全部清零。


### A2 断点 / 单步 UI（1~2 天）· ✅ 已完成 2026-10-18

**完成记录（含与计划的差异）**
- 引擎补了缺的那一半：`FlowEngine.step()`（`engine/src/gamepilot/core/flow_engine.py`）+ RPC
  `run.step`（`engine/src/gamepilot/protocol.py`、`engine/src/gamepilot/rpc/session.py`）。
  用 `_entries` / `_skip_entry` / `_pause_next` 三件套判断"是不是新的一步"——比较 `step_id` 的写法
  在"循环体只有一个步骤"时会直接冲过去（有专门的回归测试）。
- 状态命名与计划不同：计划写 `pausedAt`，实际用 `paused: Record<deviceId, string | null>`（与
  `running` / `loopProgress` 命名风格一致）。
- `apps/desktop/src/stores/session.store.ts`：`paused` / `breakpoints` + `resumeRun` / `stepRun` /
  `setStepBreakpoint`；`breakpoint_hit` 进入暂停，`step_started` / `flow_started` / `flow_finished` /
  `run.resumed` / `run.started` / `run.stopped` 退出暂停（否则横幅会挂在已停的设备上）。
- `apps/desktop/src/features/graph/flow/RunDebugBar.tsx`（新增）：暂停横幅「已暂停 · 第 N 步 · 标题」+
  继续 / 单步 / 停止，挂在 `FlowRunStrip` 上方（`absolute bottom-8 left-2`，只读快照里不渲染）。
- 节点：`FlowStepNode.tsx` 断点红点（`data-testid="flow-step-breakpoint"`）+ 暂停时 `border-warn
  ring-2`；右键菜单「在这里设断点 / 清除断点」（`flow-context-menu.ts` 末尾两个可选参数）。
- 端到端回归：`engine/tests/test_rpc_flow.py::test_breakpoint_pauses_then_step_advances_one_step`
  （真起引擎子进程：`run.breakpoint` → 停在 s2 → `run.step` → 停在 s3 → `run.resume` → 成功跑完）。
  坑：`breakpoint_hit` 是 `engine.event` 的 **type**，不是 RPC 方法名 —— 按方法名等会一直等到超时。
- 兼容老状态机：`engine/src/gamepilot/core/state_machine.py` 同步补 `step()`（`_step_once` +
  `_step_skip_edge`：放行刚停住的那条边，执行完在下一条边之前停）—— `run.step` 的
  `session.engine` 是 `Engine | FlowEngine`，只给 `FlowEngine` 加会让 mypy 报 union-attr。
  回归测试 `engine/tests/test_state_machine_conditions.py::test_step_runs_one_edge_then_pauses_before_the_next`。
- 顺带修掉两个既有 typecheck 红点（不是本次功能引入，但挡 `pnpm typecheck`）：
  `apps/desktop/src/lib/pinyin-lite.ts` 11 组重复键（值完全相同，删后出现的那条）、
  `apps/desktop/src/features/graph/flow/ClickStepFields.tsx:342-343` 用 `coerceStr` 代替裸插值
  （`unknown` 插值触发 `@typescript-eslint/no-base-to-string`）。


**问题**：引擎 `flow_engine.py:171,378-382` 有步骤断点、`resume()`，RPC `run.breakpoint`/`run.resume` 都在，但 `apps/desktop/src/lib/rpc.ts:370,378` 的函数**全仓无调用方**；前端也没有任何 `paused` 状态。

**改动**
- `apps/desktop/src/stores/session.store.ts`：加 `pausedAt: Record<deviceId, string | null>` 与 `breakpoints: Record<deviceId, string[]>`，处理 `breakpoint_hit` 事件（`:463` 已有该分支）。
- `apps/desktop/src/features/graph/flow/FlowStepNode.tsx` + `flow-context-menu.ts`：步骤右键「设断点 / 取消断点」，节点上画断点红点。
- 新增 `apps/desktop/src/features/graph/flow/RunDebugBar.tsx`：暂停时显示「已暂停在第 N 步 · 继续 / 停止」，挂在画布底部（与 `FlowRunStrip.tsx` 同一层）。
- `apps/desktop/src/stores/session.store.ts` 增加 `resumeRun(deviceId)` 调 `runResume`。
- `apps/desktop/src/features/graph/flow/FlowStepEditor.tsx:221` 的「从本模块开始运行」保持现状（它已支持 `stepId`）。

**验收**
- 给第 3 步设断点 → 运行 → 停在第 3 步，节点高亮、画面不动；点「继续」跑到链尾；点「停止」结束。
- 断点在运行前设置、运行中设置都生效；重新运行后断点仍保留（引擎每次 `start()` 只清命中记录）。

**风险**：`run.breakpoint` 的参数名是 `edgeId` 但语义是 step id（`rpc/session.py:759-769`），命名不一致 —— 改参数名会破协议，**保留原名，在注释里说明**。

### A3 执行记录补全 + 证据落盘（3~5 天）✅

**问题**：`flow_engine.py:1090-1109` 的 `_emit` 没有任何调用方传 `extra`，事件只有 `{seq, ts, type, node, message}`；`core/trace.py` 只存识别分数摘要；帧 JPEG 不落盘。

**改动**
- `engine/src/gamepilot/core/flow_engine.py`：给 `step_started/step_finished/step_failed/action_executed` 补 `extra`：`params`（已求值）、`score`、`matchedRect`、`durationMs`、`retry`。
- 新增 `engine/src/gamepilot/core/evidence.py`：按 run 建目录 `<工作流>/.runs/<时间戳>/`，每步落 `NNN_<stepId>.png` + `trace.jsonl`；由 `Session.start_run` 创建、`stop_run` 收尾。
- `engine/src/gamepilot/session.py`：`start_run` 传入 evidence 目录；`Session.timeline` 返回带截图路径的帧。
- `apps/desktop/src/features/debug/` 新增「运行记录」面板：按步展开参数/分数/耗时/截图缩略图；`TimelinePane.tsx` 由占位换成真实数据（`rpc.ts:736` 的 `timeline.get` 已有封装，接上调用即可）。
- `apps/desktop/src/features/graph/flow/flow-console.ts`：耗时改读引擎上报值，不再用前后事件 ts 相减估算。

**验收**
- 跑一次 10 步的流程 → `.runs/<ts>/` 下有 10 张截图 + trace.jsonl；界面能点开任一步看参数与分数。
- 失败的一步：记录里能直接看到"等待「登录」超时 20000ms、当帧最高分 0.61 < 阈值 0.82"。

**风险**：截图会占磁盘。默认**只在失败步 + 每步首帧**落图，全量落图做成开关（项目设置里）。

**完成记录（含与计划的差异）**

- 落盘格式：计划写 `.png`，实现用 **JPEG（质量 80）** —— 一张全屏 PNG 2~4MB，跑一次 50 步就是 100MB+；JPEG 大约 1/6，且界面本来就是看小图。
- 目录：`<工作流>/.runs/<YYYYmmdd-HHMMSS>/`，文件名 `NNN_<tag>_<stepId>.jpg`（`tag` = `step` / `failed`）+ `trace.jsonl`（一行一个事件，与界面事件同构）。**只保留最近 10 次**（`RECORD_KEEP`），`.gitignore` 加了 `**/.runs/`。
- 开关：项目设置走 `graph.defaults.evidence`（默认 `true`；写 `false` 就整次运行不落盘）。
- 事件 `extra`：
  - `step_started` → `{index, kind, params}`（`params` 去掉 `_` 开头的内部键）
  - `action_executed` → `{index, kind, params(已求值), label, score, matchedRect}`
  - `step_finished` → `{index, kind, durationMs}`（`durationMs` 由引擎用 `monotonic` 算，不再靠前端拿事件 ts 相减）
  - `step_failed` → `{index, kind, params, durationMs, reason}`
  - `step_retry` → `{index, kind, params, durationMs, retry, reason}`
  - `flow_finished` → `{result, durationMs, steps}`
- 证据记录本身也自带字段（`RunEvidence.merge()` 在动作执行/完成/失败时补齐）：`params` / `result` / `score` / `matchedRect` / `durationMs` —— 界面只读 `run.evidence` 一个接口就够，不用再去 join 事件流。
- 新 RPC：`run.evidence`（最近一次运行的证据：目录 + 每步记录）、`evidence.image`（按文件名取 base64 JPEG，只接受单层文件名）；`timeline.get` 的返回多了 `evidence` 字段。
- 失败原因自解释：等待超时的 message 变成 `等待「登录」超时（20000ms）· 当帧最高分 0.61 < 阈值 0.82`（颜色识别器没有 threshold 时退化成「未达命中条件」）。
- 前端：`apps/desktop/src/features/events/TimelinePane.tsx` 由占位换成「运行记录」面板（左列表 + 右详情：截图、参数、分数、耗时、失败原因），Tab 名字也改成「运行记录」；截图**点哪条取哪条**（几十步全量拉 base64 会卡）。
- `apps/desktop/src/features/graph/flow/flow-console.ts`：`lastDurationMs` 优先读事件的 `extra.durationMs`，没有才回退到 ts 相减。
- 顺带：`apps/desktop/src/types.ts` 的 `TraceEventView` 与 `event.store` 把 `extra` 透传下去（以前直接丢掉，前端根本拿不到引擎上报的字段）。

**没做**：全量落图开关（每帧一张）—— 每步首帧 + 失败帧已经覆盖排查需要，逐帧落图是"操作录制/回放"（B1）的活。

**验证**：`engine/tests/test_evidence.py`（4 例：落盘 / 目录穿越 / 文件名清洗 / 只留最近 N 次）、`engine/tests/test_flow_engine.py` 两例（每步记录 + 参数耗时、失败步带原因）、`engine/tests/test_session_flow_trigger.py` 两例（跑完有证据且能取图、`defaults.evidence=false` 时不落盘）、`apps/desktop/src/features/events/TimelinePane.test.tsx`（3 例）。

### A4 OCR 成为第三种识别器（3~5 天） ✅

**问题**：`engine/src/gamepilot/core/recognizer.py:337-368` `build_recognizer` 只认 `template`/`color`，OCR 只存在于 `ocr.*` RPC，不能当条件。

**改动**
- `engine/src/gamepilot/core/recognizer.py`：新增 `OcrRecognizer(label, text, mode="contains"|"equals"|"regex", threshold, roi)`，`detect()` 返回 `Detection(source="ocr", score=置信度)`。
- `engine/src/gamepilot/core/ocr.py`：暴露同步单帧接口给识别循环（复用现有子进程，注意别在采集线程里阻塞 —— 走已有 `begin_recognize` 的异步回调，结果缓存到识别器）。
- `engine/src/gamepilot/core/flow_model.py`：`cond`/`wait` 的 `params.rec` 可以指向 OCR 识别器（现有 `_NEEDS_RECOGNIZER` 逻辑已按标签校验，无需改结构）。
- `apps/desktop/src/features/recognizers/` + `OcrRecognizerDialog.tsx`：录制区独立「文字识别」入口（框选区域 + 输入期望文字 + 匹配方式 + 阈值）。
- `apps/desktop/src/types.ts:95`：`RecognizerType` 的 `'ocr'` 从死代码变成真类型。

**验收**
- 框选金币区域、设「文字包含 金币」→ 该识别器在画面栏实时显示文字与置信度。
- 用它做 `wait`（等"每日奖励"出现）与 `cond`（金币 ≥ 阈值另说，见下）。

**范围外（明确不做）**：把 OCR 文本解析成数字再参与比较 —— 需要变量系统支持"从识别结果取值"，排到 C 批（A3 的 A 批之后变量才真正可用）。

**完成记录（含与计划的差异）** — ✅ 2026-10-18

- **`OcrRecognizer` 是异步缓存型**，不是"每帧同步调 OCR"：一次推理 100ms~1s，而采集循环 8~28fps，
  同步会把整个循环拖死。做法是 `detect()` 提交一次 `OCR_MANAGER.begin_recognize`（同一时刻只允许
  一个在跑，`_pending`），然后**用上一帧的结果**判定；结果超过 `max_age_frames`（默认 3 帧）丢弃
  （屏幕上那行字可能已经变了）。
- **模型没就绪不装死**：`begin_recognize` 抛错（模型没下载/子进程起不来）记进 `last_error`，
  该识别器本帧不命中；`FlowEngine._best_score_text` 会把它变成等待超时的原因
  —— `等待「金币」超时（20000ms）· 识别器报错：OCR 模型未就绪`（否则用户只能看到"超时"）。
- `mode` 三种：`contains`（默认）/ `equals` / `regex`；`regex` 只在 `graph.json` 手改时用，
  界面只暴露前两种。正则写错在**构造时**就报错（`build_recognizer` 在 `Graph.from_dict` 里跑）。
- `threshold` 默认 **0.6**（模板是 0.82）：识别模型自带噪声，阈值照模板那么高会大面积漏。
- **录制入口新增 `record.ocr`**（没走 `record.template` 加参数）：因为 OCR 不需要裁模板图、
  但需要 `text`，语义差得远。`record.template` 的收尾逻辑抽成 `Session._finish_record(...)` 复用
  （注册识别器 + 建界面/边 + 落盘 + 热重载），OCR 照样往 `templates/` 存一张截图作证据。
- 前端：OCR 是**独立识别器表单**，不塞进图像模板的「点选素材」浮层（同一个浮层两种语义会让表单越来越长）：
  `draft.kind === 'ocr'` 时由 `DraftForm` 分派出 `OcrRecognizerDialog`，阈值默认 0.6、
  多出「要识别的文字」输入框 + 「包含/相等」下拉，**没填字保存按钮禁用**（引擎也会拒绝，界面先拦）。
  入口两处：素材区头部录制工具里的「文字识别」（原来的`素材区标题行「文字」`已并进这一组）、条件槽位的「读字」按钮；
  `RecognizerView.text` 让画面栏的 OCR 条目 title 显示"读「金币」"。
- 验证：`engine/tests/test_ocr_recognizer.py`（10 例，含"走执行器：OCR 能当 wait 的条件"）、
  `tests/test_session_mock.py` 4 例（落盘/模式/缺文字/重载后仍在）、
  `tests/test_rpc_session.py::test_record_ocr_over_stdio`；前端 `OcrRecognizerDialog.test.tsx` 6 例。

### A5 启用多尺度匹配（2 天） ✅

**问题**：`recognizer.py:71` 有 `scales`、`:118` 有循环、`:351` 会读 `spec["scales"]`，但**全仓无写入方** → 恒为 `(1.0,)`。

**改动**
- `engine/src/gamepilot/session.py:906-916` `record_template`：录制时按设备分辨率写 `scales`（默认 `[0.85, 1.0, 1.18]`）。
- `engine/src/gamepilot/core/recognizer.py`：命中失败且 `scales` 只有一个值时，自动在 ±15% 范围粗扫一次（带缓存，避免每帧重算）。
- `apps/desktop/src/features/recognizers/RecognizerPicker.tsx`：识别器详情显示"适用缩放"，可勾选自动/固定。
- 帧分辨率与模板录制分辨率不同时，UI 给出提示（"模板录制于 1080×2400，当前 720×1600"）。

**验收**
- 同一模板在 720p 设备录、在 1080p 设备跑仍能命中（真机或 Mock 图）。
- 识别耗时回归：1080p 全屏搜索不超过基线 2 倍（现有约 15ms）。

---

**完成记录（含与计划的差异）** — ✅ 2026-10-18

- 计划里写的是"录制时写 `scales`（`[0.85, 1.0, 1.18]`）"，实现改成**写 `recorded_size` + 运行时算比例**：
  固定三档覆盖不了"录在 1080p、跑在 720p"（差 33%，超出 ±15%），而录制时也并不知道以后会跑在什么分辨率上。
- `TemplateRecognizer.scales` 默认值从 `(1.0,)` 改成 `None`，含义变成"没显式指定 → 按 `recorded_size` 自动算"：
  - 有 `recorded_size` 且帧尺寸一致（±3%）→ 仍然只用 `1.0`（不做无意义的 3 倍匹配开销）；
  - 尺寸变了 → 主尺度 `帧宽 / 录制宽` + `±6%` 两个容错档，钳在 `[0.35, 2.8]`，去重；
  - spec 里显式写了 `scales` → 以它为准（手调优先，行为与以前一致）。
- 老工作流（没有 `recorded_size`）行为**完全不变**：单尺度 1.0。
- `session.record_template` 写 `"recorded_size": [帧宽, 帧高]`（裁模板那一帧的像素尺寸）。
- 前端：`RecognizerView.recordedSize` + 识别器详情里一行「换分辨率会自动缩放（录制于 W×H）」。
- 验证：`engine/tests/test_resolution_scales.py`（6 例：老工作流不变 / 同尺寸不付开销 / 比例与容错 /
  **0.75 倍分辨率下仍命中且 rect 落在预期位置** / 显式 scales 优先 / 脏数据被忽略）；
  `tests/test_session_mock.py::test_recorded_template_remembers_the_capture_size`。

## 3. 批次 B：稳定性与多设备（预计 3 周）

| 项 | 目标 | 主要改动 | 验收 | 估时 |
|---|---|---|---|---|
| B1 录制补齐 | 按键/文本/双击可录 | `use-screen-surface.ts:216-247` 增加 keydown/双击识别；`flow_record.py` 已有分支，只差调用侧 | 录制时按返回键落成 `key` 步骤 | 1~2d |
| B2 失败快照 + 断线续跑 | 断了能从失败步继续，不重置变量 | `Session.start_run` 前后落 `checkpoint.json`（`cursor/variables/loop_stack/startedAt`）；重连后 UI 给「继续上次」；`flow_engine.py:299-336` 支持恢复而不是重置 | 运行中断开设备 → 重连 → 点「继续」从中断步跑，变量保留 | 3~5d |
| B3 多设备批量启动 + 汇总 | 一次让多台跑同一流程，看每台结果 | `useRunControl.ts:42-58` 增加 `startAll()`；新增「运行汇总」面板（每台状态/耗时/成功失败/失败步）；引擎侧已有并发能力，只需 UI 与汇总收集 | 连 2 台（Android+Mock）→ 一键全跑 → 汇总表出来 | 3~5d |
| B4 任务队列 | 串行/并发上限/定时/失败重试 | 新增 `engine/src/gamepilot/queue.py`（设备×工作流队列）+ RPC `queue.*` + 前端队列页；定时沿用 `flow_trigger`，补"漏跑补跑"（记录上次触发时间） | 入队 5 个任务、并发 2，队列按序跑完，失败按策略重试 | 5~8d |

---

## 4. 批次 C：差异化（按需，不承诺时间）

| 项 | 说明 | 依赖 |
|---|---|---|
| C1 屏幕差分识别器 | "区域变化超过 N%" 当条件（血条、加载、弹窗） | A4 之后同类工作，可共享 ROI 与阈值 UI |
| C2 recovery 进入步骤链 | 老状态机的 `recovery` 边（`graph.py` Edge.kind、`state_machine.py:182`）在步骤链里没有对等物 | A2/A3（要能观察失败） |
| C3 等待消失 / while 循环 | `wait` 只有"等出现"；循环只有固定次数 | A1（变量可用后 while 才有意义） |
| C4 子流程参数与返回 | 现在 `call` 会等子链跑完并回到父链（`flow_engine.py:941`、`session.py:444`），但仍无参数与返回值 | A1 + 变量作用域设计 |
| C5 AI 生成流程草稿 | 自然语言 → 步骤草稿 + 未确认目标标记 | **A3（结构化日志）硬前置** |

---

## 5. `BACKLOG-W`：Windows 支持（✅ 2026-10-22 已实现）

**现状**：PC（Windows）本机窗口已经能当设备用。选窗口 → 绑定窗口句柄 → 抓该窗口画面 →
点/拖/按键/打字都发给它；上层（设备列表、坐标归一化、录制、状态图、运行）与 Android/iOS/macOS 完全同构。

**实际落地**
1. `engine/src/gamepilot/devices/windows.py`（新，约 1300 行）：
   - 枚举：`EnumWindows` + 进程名/标题/类名/`WS_EX_TOOLWINDOW`/DWM cloaked 过滤；窗口矩形优先
     `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`；客户区 `GetClientRect` + `ClientToScreen`；
   - 抓图：`PrintWindow(PW_CLIENTONLY|PW_RENDERFULLCONTENT)` → 整窗 PrintWindow 裁剪 → `BitBlt`
     屏幕 DC → `BitBlt` 窗口 DC；全黑帧自动回退并缓存成功方式；全失败报中文排查建议；
   - 输入：`post=global`（默认）`SendInput` + 绝对坐标（Per-Monitor DPI 感知），点前用
     `SwitchToThisWindow`/AttachThreadInput/Alt 键/置顶四级兜底激活窗口，点后指针放回原处；
     `post=sync` 走 `SendMessageTimeout`（WM_LBUTTON* / WM_KEY* / WM_CHAR），消息直送窗口过程，
     不抢鼠标焦点 —— 实测 UE 游戏后台按键/鼠标移动/菜单可走通；`post=message`（PostMessage）保留作兼容档；
     鼠标消息会沿子窗口树下钻到真正接收输入的子窗口；
   - URI：`Windows:///?hwnd=<十进制>`（手输 `0x…` 由 `parse_device_uri` 归一化），
     另支持 `pid/title/exe/class` 兜底；只用 stdlib ctypes，没有新增依赖（也没有 pywin32）。
2. `devices/__init__.py`：Windows 扫描来源（非 Windows 自动返回空）；
   `devices/macos.py` 补 `window_list_payload()` 与 `deviceId`。
3. `protocol.py` + `rpc/session.py`：新增统一 `window.list`（Windows/macOS 共用；
   老 `mac.windows` 保留为兼容别名），`device.connect` 支持 Windows scheme。
4. 前端：设备弹层 Tab `mac`→`window`（Windows/macOS 通用），`WindowList.tsx`（新）负责
   枚举/搜索/刷新/`0x` 句柄展示/手输绑定/前台·后台输入方式；`DevicePopover` 用窗口 `deviceId`
   记录已绑定；`ui.store` 记忆分类并迁移旧值。
5. 测试：
   - 引擎纯逻辑 30 例（窗口过滤/句柄解析/归一化坐标/黑帧/按键表/控制器参数）+ `window.list`
     平台分发 7 例；`tests/test_rpc_session.py` 的"未知 scheme"反例改成不存在的 `Lunar://`。
   - 前端：`WindowList` 6 例 + `device-kinds`/`DevicePopover`/`ui.store` 更新。
   - 手工验收：`scripts/smoke-windows-window.py`（真实引擎子进程 + Tk 测试窗口）→
     枚举 → 绑定句柄 → 首帧非黑 → `engine.frame` 出图 → SendInput 点击真的落到窗口 →
     `post=message` 重新绑定，**16 项检查全过**。

**还剩的风险（真实游戏尚未逐款验证）**
- 独占全屏 DirectX 窗口抓不到（已明确报错提示改窗口化/无边框）。**已用真实 Unreal 游戏窗口
  （SilverPalace，1280×720）做只读验证：`PrintWindow` 实时抓图成功，两帧差异 45.5（画面在动，不是黑帧/静帧）**；
  真实游戏上的点击/按键未验证（避免干扰正在运行的游戏，留待用户实测）；
- 带反作弊/管理员权限的游戏：UIPI 会拦输入，必须同权限运行；
- `post=message` 对 DirectInput/原始输入游戏可能无效（这是游戏侧行为，不是通道 bug）；
- 缩放 125%/150% 已做 DPI 感知，但未在多显示器不同缩放组合上实测。


---

## 6. 工程约定

- 每批次结束必须 `pnpm check`（前端 lint/tsc/vitest + 引擎 ruff/mypy/pytest）全绿；
- 引擎改动都配 `engine/tests/*.py`；前端改动配 `*.test.ts(x)`；
- 提交顺序：引擎 → `protocol.py`/RPC → 前端 → 文档（`docs/rpc.md` 同步更新）；
- 不引入新依赖（Windows 的 pywin32 是例外，且只在 `windows` extra 里）；
- 每批次结束更新本文件的"状态"列，并在 `docs/DESIGN.md:611` 的功能清单里打勾。

### 6.1 本机当前跑不了的检查（环境漂移，不是代码问题）

| 命令 | 现象 | 替代做法 |
|---|---|---|
| `pnpm engine:lint` / `engine:test` | `uv run` 起不来：`Failed to initialize cache at ~/.cache/uv … Operation not permitted`（沙箱不让写 `~/.cache`） | 直接 `engine/.venv/bin/python -m ruff check .` / `-m ruff format --check .` / `-m mypy` / `-m pytest -q` |
| `engine:lint` 里的 `ruff format --check` | venv 是 **ruff 0.17.0**（`pyproject.toml:37` 只写 `>=0.6`），另外还有十几个文件本来就不符合它的格式（与批次 A 无关） | 只格式化自己改过的文件（A1~A5 改过的都已格式化），不整仓重排（避免无意义 diff） |
| `engine:lint` 里的 `mypy` | venv 是 **mypy 2.4.0**（`pyproject.toml:38` 只写 `>=1.11`）。**A4 已把 `src` 收到 0 报错**（修掉 `core/actions.py` 的 `float(object)`、`core/ocr.py` 三处 `IO[bytes]` vs `BinaryIO`）。`tests` 里仍有 19 个既有报错（`test_call_workflow.py`、`test_session_flow_trigger.py` 等把 `Engine \| FlowEngine` 当具体类用） | `mypy src` 现在 0 报错；`mypy`（含 tests）还剩 19 个，属测试代码的历史欠账，B 批顺手收 |

**前端侧的既有漂移：已清（2026-10-18 收尾）**
- `prettier --check`：全仓原本 52 个文件不合格式（全在 `apps/desktop/src`，mtime 早于本会话）。
  已执行 `prettier --write .` 统一 + `ruff format .`（引擎 14 个文件）；原文件备份在
  `/tmp/format-backup/` 与 `/tmp/engine-backup.tgz`。现在 `prettier --check .` 与
  `ruff format --check .` 都是全绿。
- `eslint src`：原本 18 个 error，已全部修掉（多余断言、无 await 的 async、`[object Object]`
  字符串化、`set-state-in-effect`、`preserve-caught-error` 等），现在 **0 error / 9 warning**；
  剩下 9 条是 `react-refresh/only-export-components`（文件同时导出组件与常量/工具，只影响热更粒度，
  不影响构建，`pnpm lint` 退出码 0）。
- `apps/desktop/src/stores/session.engine.test.ts` 的 **5 条集成用例已修绿**。根因不是产品代码：
  v4 把"工作区/工作流"分成两层之后，用例结尾还在用 `switchWorkflow(projectDir)` 把"当前工作流"
  切回临时**脚本目录**，而 `projectDir` 不在工作区列表里 → `switchWorkflow` 的"否则关标签"守卫
  直接 return → `waitFor` 超时 → 后面 4 条读 `projectDir/graph.json` 级联 ENOENT。
  改法：用例结尾改用 `projectSet(projectDir, true)`（`create` 默认 false，必须显式传 true 才会
  补齐 `graph.json`）+ `refreshCurrentWorkflow()`；同时给 3 条没有显式超时的用例补 `{ timeout: 30000 }`、
  `waitFor` 默认 8s → 15s、`beforeAll` 给 60s（并行跑 93 个测试文件时引擎子进程起得慢会假阳性）。

另外：venv 里的 `cv2` 是 **5.0.0**，与 `engine/pyproject.toml:11` 的 `opencv-python-headless>=4.9,<5` 不一致（`uv sync` 重建即可，但需要能写 `~/.cache/uv`）。

### 6.2 批次 A 收尾时的验证结果（2026-10-18）

| 检查 | 结果 |
|---|---|
| `engine/.venv/bin/python -m pytest -q` | 全绿（含 A1~A5 新增的 10+4+3+6+… 用例） |
| `engine/.venv/bin/python -m ruff check src tests` | `All checks passed!` |
| `engine/.venv/bin/python -m mypy src` | `Success: no issues found in 44 source files`（`src` 0 报错，A4 顺手清掉了 5 个历史欠账） |
| `apps/desktop` `tsc --noEmit` | 干净 |
| `apps/desktop` `vitest run` | **662 passed / 0 failed**（93 个文件；连跑两遍都绿，见上「已清」） |
| `apps/desktop` `prettier --check .` | **All matched files use Prettier code style!** |
| `apps/desktop` `eslint src` | **0 error**（9 条 `react-refresh` warning，不影响 `pnpm lint` 退出码） |
| `engine` `ruff format --check .` | `86 files already formatted` |

**`pnpm check` 现在剩下的唯一障碍**：`pnpm engine:lint`/`engine:test` 走 `uv run`，在这台机器上因沙箱写不了
`~/.cache/uv` 而起不来；用 `engine/.venv/bin/python -m …` 等价执行是全绿的。这一点不是代码问题，换能写
`~/.cache/uv` 的环境（或先 `uv cache dir` 指到可写目录）即可。

---

## 7. 里程碑（你可以亲手验的）

| 里程碑 | 你能看到什么 |
|---|---|
| **M-A** ✅ 2026-10-18 | 能写计数变量（`$次数 + 1` 真的生效）；能给任一步设断点、暂停、继续（含单步）；每步有参数、分数、截图可查；OCR 文字能当等待/条件；同一模板跨分辨率可用 |
| **M-B** | 录脚本时按键也能录；断线重连后从失败步继续且变量不丢；两台以上设备一键同跑并给出成功率与耗时；任务能排队、按并发上限执行 |
| **M-C** | 血条/加载这类"变化"能当条件；步骤链里能写中断处理；`wait` 能等消失；子流程能传参返回；AI 能根据自然语言与历史日志生成草稿 |

---

## 8. 冗余清理与口径修正（2026-10-19）

细节见 [refactor.md](refactor.md)。这一轮做的不是新功能，而是把「同一件事写了两遍 / 写了没人用 /
显示值与实际值不一致」处理掉：

- **删掉没人用的代码**：前端 15 个文件（含 6 个只有测试在用的 v3 纯函数模块与它们的测试）+
  7 个零引用导出 + `graph-adapter` 的边/动作写回通道（112 行）+ 旧图编辑 RPC 封装；
  引擎 7 个零引用定义。补上 `rpc/stdio.py` 退出时 `SessionManager.stop_all()`（否则 scrcpy 子进程成孤儿）。
- **修掉 6 处口径漂移**：`double_click` 被静默改写成单击（用户动作会永久丢失）、抽屉默认值与引擎兜底不一致、
  `retry_interval_ms` 是空转滑块、打开旧图会自动装一个每天 9 点的定时任务、节点备注被超时顶替、
  `TraceEventType` 只声明了引擎 27 个事件中的 15 个。
- **验证**：`pytest -q` 全绿、`ruff check src tests` → All checks passed、`mypy src` → 44 files 无问题、
  `tsc --noEmit` 干净、`vitest run` → **607 passed / 0 failed**（删掉的测试都跟着死代码一起走，
  所以总数从 662 降到 607）。

### 8.1 契约守卫（2026-10-19 同日）

`engine/tests/test_contract.py`（7 条，全部绿）是"同一份接口抄四遍"的机械检查：

| 断言 | 防的是什么 |
|---|---|
| `METHOD_*` 常量与 `rpc/*.py` 里 `@server.method(...)` 双向相等 | 常量加了没注册 / 注册了没常量 |
| `docs/rpc.md` 里提到每一个方法 | `ocr.*`、`action.run`、`variable.set` 曾经整组漏写（这次补上了） |
| `docs/rpc.md` 里提到每一个 `NOTIFY_*` | `run.resumed` 这种"加了通知忘写文档" |
| 前端 `rpc('x')` 的每个名字都在方法表里 | 拼错方法名（只会在运行时才报 `-32601`） |
| `REQUIRED_ENGINE_METHODS` ⊆ 方法表 | 握手清单写错 → 要么永远提示"引擎太旧"，要么永不提示 |
| `STEP_KINDS` == 前端 `FLOW_STEP_TYPES` | 加步骤类型时漏改一边（漏了就是"画布上有、跑起来当未知步骤跳过"） |

做了变异验证：从 `docs/rpc.md` 删掉 `` `evidence.image` `` 后测试立刻红，恢复后绿。

### 8.2 `SingleScreen` 合并到 `useScreenSurface`（2026-10-19）

- `apps/desktop/src/features/device/ScreenPane.tsx` 1835 → **1590 行**；`use-screen-surface.ts` 344 → 389 行。
  单画面之前自己重写了一遍测量 / 坐标换算 / 指针处理（710 行），现在与多开网格共用同一把尺子。
- hook 新增两个可选回调：`onGesture`（`SurfaceGesture`：`down/move/up` + `from/to` + `swipe` + `durationMs`）
  与 `onHover`（录制态归一化坐标），单画面据此画波纹/轨迹/准星；hook 因此仍是"只管行为、不管画什么"。
- 同时消掉 `liveScore` 的两份语义（一份取 `detections[0]`、一份取 max）：现在只有 hook 里导出的那一份。
- 对齐两处行为差异：网格里"待录滑动只点了一下"也会提示（原来只有单画面有）；录制坐标统一 4 位小数。
- 验证：`tsc --noEmit` 干净、`eslint src` 0 error、`prettier --check .` 全绿、
  `vitest run` → **613 passed / 0 failed**（87 个文件）。
