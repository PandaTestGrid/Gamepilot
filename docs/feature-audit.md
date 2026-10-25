# GamePilot 能力盘点与开发优先级（代码级核对）

> 方法：只读代码审计（不采信 README 的宣称），三路并行核对流程引擎 / 视觉识别 / 设备与平台。
> 判定口径：**完整** = 引擎有实现且前端有入口、能用；**部分** = 有实现但被截断、或只有 RPC 没有 UI、或只覆盖一个方向；**无** = 代码里不存在。
> 所有行号对应本次审计的代码快照。

## 0. 一句话结论

你列的 6 个优先功能里，**4 个已经有相当完整的骨架**（流程控制块、可视化识别器、录制、多设备并发），真正缺的不是"再开发一遍"，而是四件事：

1. 一个**已经登记在册却不执行**的步骤类型（`setvar`）；
2. 一套**引擎和 RPC 都做好了、前端零入口**的调试能力（断点 / 暂停 / 从某步起跑）；
3. ~~OCR 是能用的独立工具，但没接进识别器与判断条件~~ → **A4 已修**：`type: "ocr"` 是第三种识别器，能当 `wait`/`cond`/点击目标；
4. ~~模板匹配的多尺度字段存在但从未被写入~~ → **A5 已修**：录制裁下 `recorded_size`，运行时按帧比例自动缩放（±6% 容错）。

第 5、6 项（多设备调度、AI 助手）里，多设备**引擎层已经支持并发**，缺的是批量入口与汇总报告；AI 助手确实完全空白。

---

## 1. 你的清单逐项核对

### A. 流程引擎

| 项 | 判定 | 证据 | 限制 |
|---|---|---|---|
| A1 条件分支 | **完整** | `engine/src/gamepilot/core/flow_engine.py:396-430`（cond 命中走 then，未命中按 `_resolve_match_timeout_ms` 等待后跳 else/condend）、`:439-453`（走到 else 即跳过 else 段）、`:764` `_condition_ok(params) -> bool`（组内 AND、组间 OR）；`apps/desktop/src/features/graph/flow/flow-step-ports.ts:22-27`（cond 两个出口 `then`/`else`）、`CondStepFields.tsx:50` | 条件只认"模板是否命中"，不能比较变量、数值或 OCR 文本；if-else-if 只能靠嵌套 |
| A2 循环与跳转 | **部分** | `engine/src/gamepilot/core/flow_engine.py:461-479`（`count = max(1, _as_int(params.get("count"), 1))` 压 `_LoopFrame`）、`:481-512`（loopend 递减回跳）、`:513-524`（`loopbreak`）、`:24` `MAX_STEPS_PER_TICK = 200` | 只有**固定次数**循环 + 跳出；无 while/条件循环、无 continue、无任意 goto（唯一的"跳转"是出错回退 `fallbackStepId`，`flow_engine.py:934-943`） |
| A3 变量与表达式 | **部分（硬伤已修，2026-10-18）** | `engine/src/gamepilot/core/variables.py:126` `evaluate_expr`（正则白名单 + 变量替换 + `eval(..., {"__builtins__": {}})`）、`:156` `resolve_value` 支持 `$score/$var/$expr`；`flow_engine.py:962` 动作参数过 `resolve_spec` | **步骤链的 `setvar` 引擎不处理**：`flow_model.py:36` 把它登记进 `STEP_KINDS`，但 `flow_engine.py:525-572` 的分支链没有 `setvar`，落到 `:569-572` 记一步就跳过 → **运行时空转**。赋值只在老状态机的边动作里有（`state_machine.py:393-405`）。前端 `flow-step-meta.ts:79-137` 的面板里也没有 setvar 条目，用户建不出来 |
| A4 子流程与复用 | **部分（可续跑，仍无参数/返回）** | `engine/src/gamepilot/core/flow_engine.py:420` `wait_for_subflow`、`:436` `resume_from_subflow`、`:941` `_call_subflow`；`engine/src/gamepilot/rpc/session.py:260` `_call_workflow`；`engine/src/gamepilot/session.py:444` `_complete_run` 恢复父链、`:481` `_subflow_descendants`、`:706` `stop_run` 级联停止 | 调用 B 不再切画布、也不再让 A 结束：A 挂起在 call，B 跑完后 A 从下一步继续；支持嵌套调用。仍**无参数、无返回值、无显式调用栈**，复用只能靠复制工作流目录（`library.py:175` `duplicate_workflow`） |
| A5 异常捕获与重试 | **部分** | `flow_engine.py:898-943` `_resolve_step_failure`（`fail/retry/continue/fallback`、`insertData` 写变量）、全局 `on_step_error`/`step_retries=2`、步骤级 `retryTimes` 默认 3；超时 `:648` 等待默认 20000ms；UI `FlowStepSettingsPanel.tsx:186-300`、`FlowGlobalSettingsDrawer.tsx:54-55` | 无 try/catch 块、无"异常分支"节点（异常只能落到固定 fallback 步 / continue / stop）；重试计数只在内存 `_error_retries`，`start()` 清空 |

**步骤类型全集（18 个，`engine/src/gamepilot/core/flow_model.py:14-37`）**

```python
STEP_KINDS = (
    "manual", "schedule", "interval",     # 触发器，只能做第一步
    "wait", "click", "hold", "swipe", "key", "text", "delay",
    "cond", "else", "condend",
    "loop", "loopend", "loopbreak",
    "call", "setvar",
)
```

面板实际可建 10 个模块 + 3 个触发器：`click / swipe / key / text / wait / delay / loop / loopbreak / cond / call`（`flow-step-meta.ts:79-137`）。`hold` 靠 click 的 `event=long_press` 表达，`else`/`condend` 是自动插入的块标记，**`setvar` 不在面板里**。

### B. 视觉识别

| 项 | 判定 | 证据 | 限制 |
|---|---|---|---|
| B1 模板匹配 | **完整** | `engine/src/gamepilot/core/recognizer.py:60-246`；唯一算法 `cv2.matchTemplate(gray, template, cv2.TM_CCOEFF_NORMED)`（`:158`）；大画面 1/2 降采样粗搜 + 原分辨率复核（`:198-246`）；NMS（`:318-324`）；同分异位标 `ambiguous`（`:137-140`，`AMBIGUITY_EPS=0.02`）；纯色模板拒绝（`:108-109`，`TEMPLATE_MIN_STD=2.0`） | `region` 模式下目标一移动就漏检（测试记录在 `engine/tests/test_recognizer_search.py:79`，切 `full` 后 `:84` 通过） |
| B2 OCR 文字识别 | **完整（A4）** | `engine/src/gamepilot/core/ocr.py:177-650`（PP-OCRv4 mobile，异步子进程 `ocr_worker.py:21-63`）、RPC `ocr.status/load/recognize/cancel`（`rpc/session.py:782-829`）、前端 `ocr.store.ts` | `engine/src/gamepilot/core/recognizer.py` 的 `OcrRecognizer`（异步缓存型）+ `record.ocr` RPC；能当 `wait`/`cond`/`action.target`。仍不支持"把 OCR 文本当数字参与比较"（需变量取值，C 批） |
| B3 颜色与像素判断 | **部分** | `recognizer.py:249-278` `ColorRecognizer`（`tolerance=30`、`min_pixels=60`，`mask.sum()` 判定）；录制时低方差自动降级（`session.py:889-905`） | 只有"指定颜色±容差+最小像素数"；**无区域变化/差分检测**（`core/` 内无 absdiff）；颜色识别器不允许整帧搜索（`graph.py:281-283`） |
| B4 目标出现/消失等待 | **完整（出现）/ 靠变通（消失）** | 出现：`flow_engine.py:651-668` `_try_wait`（`stable_frames` 投票、超时 `wait_timeout_ms` 默认 20000）、`:741-767`（点击目标自动等）；条件限时 `conditions.py:176-185` `ConditionTimer.check() -> "ok"/"wait"/"timeout"`；消失：`conditions.py:130-131` `none_of`，老状态机的 settle 边 `state_machine.py:293-297` | 没有独立的「等待消失」模块；步骤链里表达不了 recovery 边 |
| B5 分辨率自适应 | **完整（A5）** | 坐标层完整：`geometry.py:16-74` `Rect` 全 `[0,1]` 归一化 + `to_pixels/from_pixels`；但尺度层：`recognizer.py:71` `scales: Sequence[float] = (1.0,)`、`:118` `for scale in self.scales`、`:351` 读 `spec["scales"]` | 录制写 `recorded_size`（`session.record_template`），`TemplateRecognizer._scales_for(frame)` 按 `帧宽/录制宽` 生成主尺度 + ±6% 容错；显式 `scales` 仍然优先（手调） |
| B6 多目标匹配 | **完整（选点）** | `recognizer.py` 保留 `MAX_CANDIDATES=24` 条；`frame.py` 的 `best_per_label` 把不同位置收进 `Detection.candidates`（阅读顺序）；`core/selection.py` 的 11 种策略（auto / nearest / first / last / nth / 极值 / random / all）；步骤 `params.strategy` + `params.index`；`engine.frame.detections[].candidates` 给界面画多个框；动作事件 `extra.picked` 记录点了哪几个 | `wait` / `cond` 仍只判"有没有命中"，不参与选点；`all` 的候选来自同一帧，点完会重排的界面要配合循环 |
| B7 阈值/ROI/算法可配 | **部分** | 阈值滑块 `RecognizerPicker.tsx:245-380` → `graph.py:266-272`；ROI `recognizer.py:95-98`；搜索范围 `SEARCH_MODES=("region","full")`（`:43`）+ 步骤级覆盖 `flow_engine.py:190-259` | 算法**硬编码** `TM_CCOEFF_NORMED`，无算法选择；粗搜常数不可配 |
| B8 实时框/相似度/坐标 | **部分** | 框 + 分数 + 状态色 `ScreenPane.tsx:890-914`；读数列表 `:1626-1717`；`pass = item.score >= item.threshold`（`:1627`） | 框、分数、绿/橙/虚线都有；**检测框不显示数字坐标**（坐标只在录制准星 `:916-931` 与草稿框 `SelectionBox.tsx:270-275`） |

### C. 游戏操作

| 项 | 判定 | 证据 | 限制 |
|---|---|---|---|
| C1 录制与回放 | **部分** | `apps/desktop/src/features/device/use-screen-surface.ts:216-247` → `rpc/session.py:574-583` `record.action` → `session.py:678-753` → `core/flow_record.py:15-54`（action→step）；"录操作"开关 `GraphPane.tsx:157-195`，另有「+等0.5/1/3s」按钮 | 只录**单指 click / long_press / swipe**；按键、文本、双击**录不到**（UI 无 keydown 采集），只能手加 |
| C2 多点触控 | **无** | `devices/base.py:127-157` 只有单点原语；`devices/scrcpy.py:46` `POINTER_ID_MOUSE = 1` 写死；`core/actions.py:27` 无多指动作 | 全仓无第二指注入；双指捏合、组合手势都做不了 |
| C3 随机延迟与间隔 | **部分** | `flow_engine.py:689-695` `_with_jitter_ms`（base ± `delay_jitter_ms`）；`:710-729` pre/post/step_interval 都过抖动；`bezier_trajectory.py:445-446` 按下时长 ±30ms、落点 ±3px | **`delay` 步骤本身不抖动**（`:669-678` 直接用 `params["ms"]`）；抖动只能全局配，无每步随机区间 |
| C4 游戏状态机 | **完整（框架级）** | `core/state_machine.py`（625 行：`tick:110`、`_recoveries:182`、`_execute:361`、`_advance_pending:277`）、`graph.py:79-116`（Edge: kind/priority/min_score/cooldown_ms/retries/condition） | 状态/边全靠用户画，无内置大厅/战斗/结算模板；**recovery 边只存在于老状态机**，步骤链模型里没有 |
| C5 崩溃与断线恢复 | **部分** | 通道级自愈：`android.py` 只有 scrcpy 通道，断了直接报错重连（无 adb 截图/输入回退）、`ios.py:1120-1146`（后台重连 HID）、`session.py:338-380`（截图失败重试→`device.failed/recovered`）、`session.store.ts:269-296`（自动重连） | **不能重启游戏**（全仓无 `am start`/bundle 启动）；**无断点续跑**（无 checkpoint）；会话关闭直接清 `runners`（`session.py:326-331`），运行态**完全不落盘** |

### D. 调试与平台

| 项 | 判定 | 证据 | 限制 |
|---|---|---|---|
| D1 节点单步调试 | **部分（引擎有、产品无）** | `flow_engine.py:171` `breakpoints: set[str]`、`:378-382`（执行前停、emit `breakpoint_hit`）、`:291-297` `resume()`；RPC `run.breakpoint`/`run.resume`（`rpc/session.py:751-769`，参数名是 `edgeId`）；`action.run` 可单执行一步 | **前端零入口**：`apps/desktop/src/lib/rpc.ts:370,378` 两个函数定义了，全仓无任何组件调用；也没有真单步（resume 一直跑到下一个断点） |
| D2 运行截图与视频 | **无** | `core/trace.py:44-53` 只存 `{index,ts,node,detections:{label:score}}`；唯一 `cv2.imwrite` 是录模板（`session.py:796,892`）；`TimelinePane.tsx:3,33` 自述"占位" | 任何一步都没有图像证据落盘；实时帧走 `engine.frame` 单向推流，不落盘、不可回溯 |
| D3 每步执行记录 | **部分（弱）** | `flow_engine.py:1090-1109` `_emit` 构造 `TraceEvent`；事件类型齐全（`step_started/finished/failed/retry/skipped`、`cond_false`、`loop_repeat`、`action_executed`…） | **没有任何调用方传 `extra`**（`grep "extra="` 只命中定义行）→ 记录里**没有输入参数、没有识别分数、没有截图**；环形内存 1000 条（`trace.py:34`），重启即丢、不能导出 |
| D4 失败回放/从失败恢复 | **无** | `timeline.get` 封装存在但**无调用方**（`rpc.ts:736`）；`run.start {stepId}` 可指定起点（`flow_engine.py:299-336`），但 `session.py:622` `reset_variables()` | 没有失败快照；"从这步起跑"会重置变量/重试计数/循环栈，不算恢复；`lastFailedStepId` 只画一个红框 |
| D5 多设备并发 | **部分（引擎完整 / UI 缺批量入口）** | 每设备独立 `DeviceSession`（`rpc/session.py:198`）+ 独立采集线程（`session.py:312`）+ 每 session 可挂多份 `runners`（`:270,1076-1092`）；前端 `running: Record<deviceId,bool>`（`session.store.ts:82`） | 运行按钮只对当前设备（`useRunControl.ts:42-58` `startRun(activeId)`），没有"全部一起跑"；**iOS 一进程只能带一台**（`ios.py:129-146`） |
| D6 任务队列与定时 | **部分** | `schedule`（daily/once/weekly/monthly）+ `interval` 触发器（`flow_trigger.py:21,58-136`）；到点自动 `start_run`（`session.py:592-614`）；步骤重试 `flow_engine.py:898-924` | **没有队列/调度器**：无 cron 库、无持久队列、无跨设备编排；每 session 只有一个 `_auto_at`；应用关闭期间漏跑不补 |
| D7 导入导出/API | **部分** | 导出/导入是**纯前端**：`features/library/workflow-io.ts:1-51`（Blob 下载 / FileReader 读 `graph.json`）+ `WorkspacePanel.tsx:839,848` | 后端无 export/import RPC；**无 HTTP/WS/CLI 入站**；唯一对外通道是 stdio JSON-RPC（前端私有，`rpc/stdio.py:1-16`） |

**设备后端现状**：Android adb（完整）/ scrcpy 通道（完整）/ iOS 17.4+（部分，一进程一台）/ macOS 窗口（完整）/ **Windows 窗口（2026-10-22 已实现：EnumWindows + PrintWindow/BitBlt + SendInput/PostMessage，真实引擎+Tk 窗口冒烟通过）** / Mock（仅测试）。

---

## 2. 六个建议功能的真实差距

| 你的建议 | 现状 | 真正缺的 |
|---|---|---|
| 01 游戏流程控制节点 | 条件/循环/子流程/等待/变量**全部有对应步骤类型** | ① `setvar` 空转，等于没有计数/累加；② 无 while 与条件循环；③ 子流程无参数无返回；④ 无条件式的"等待消失" |
| 02 可视化图像识别编辑器 | 框选 → 识别器（模板/颜色/OCR）→ 阈值/ROI/搜索范围/实时分数 + 换分辨率自动缩放**已闭环** | ① 无多目标列表；② 无算法选择（模板之外只有颜色/OCR） |
| 03 操作录制与流程生成 | 点/长按/滑/等待可录成步骤，可编辑 | ① 按键/文本/双击录不到；② 单步回放/重录某步没有；③ 无触摸轨迹（P2 宏录制） |
| 04 专业调试与失败回放 | 断点/暂停/从某步起跑的**引擎语义都有** | ① 前端没有入口（最便宜的高价值项）；② 事件不含参数/分数/截图；③ 无失败快照与续跑 |
| 05 多设备任务调度 | 引擎已支持每设备并发 + 单设备多流程并行 | ① UI 无批量启动；② 无队列/并发上限；③ 无成功率/耗时汇总；④ iOS 限一台 |
| 06 AI 流程助手 | **完全空白**（无任何 LLM 调用） | 全部。但前置依赖是"结构化执行日志 + 未确认目标标记"，也就是 04 要先做 |

---

## 3. 我的排序（和你的 01-06 有一处重要不同）

**先修 4 个"已经造好但没接线"的缺口，再谈新功能。** 理由：这四项的引擎/RPC 已存在，改造成本远低于新做，而它们恰好是"稳定跑起来"的瓶颈。

| 序 | 事项 | 性质 | 量级 | 验收标准 |
|---|---|---|---|---|
| 1 | `setvar` 接线 | 修 bug | ~0.5 天 | `flow_engine.py` 加 `setvar` 分支 → `variables.set()`；面板加"赋值"条目；`次数 = $次数 + 1` 能跑通 |
| 2 | 断点/单步 UI | 接线 | 1~2 天 | 步骤右键"设断点"、运行到此处暂停、工具条"继续/停止"；复用 `rpc.ts:370,378`，引擎不用改 |
| 3 | 执行记录补全（含截图） | 小改 + 落盘 | 3~5 天 | 每条 step 事件带 `params / score / matchedRect / 截图路径 / 重试次数`，按 run 存目录；这是 04 与 06 的地基 |
| 4 | OCR 成为第三种识别器 | 中等 | 3~5 天 | `build_recognizer` 支持 `ocr`（文本+阈值+ROI），条件/等待可选"文字包含 X"；`金币=1234` 能当条件 |
| 5 | 启用多尺度匹配 | 小改 + 实测 | 2 天 | 录制写 `scales`，或首次匹配失败自动 ±15% 扫描；同一模板跨 720p/1080p/2K 可用 |
| 6 | 录制补齐按键/文本/双击 | 小改 | 1~2 天 | 录制时按音量键/返回键也能落成步骤 |
| 7 | 失败快照 + 断线续跑 | 中等 | 3~5 天 | checkpoint 存 `cursor/variables/loop_stack`；重连后提供"从失败步继续"，不重置变量 |
| 8 | 多设备批量启动 + 汇总 | 中等 | 3~5 天 | "所有已连接设备运行此流程"、并发上限、每台成功率/耗时表 |
| 9 | 任务队列（串行/定时/重试编排） | 较大 | 5~8 天 | 队列页：入队、顺序/并发、失败重试策略、漏跑补跑 |
| 10 | 屏幕差分识别器 | 中等 | 3~5 天 | "区域变化超过 N%" 可作为条件（血条、加载、弹窗） |
| 11 | recovery 进入步骤链 | 中等 | 3~5 天 | 步骤链支持"中断处理块"，等价老状态机的 recovery 边 |
| 12 | AI 生成流程草稿 | 大 | 8~15 天 | 自然语言 → 步骤草稿 + 未确认目标清单 + 审核后落地；依赖 3 的日志格式 |

**不建议现在做的**：多点触控（除非目标游戏必须双指缩放）、Windows 控制器（当前机器是 macOS，做完无法验证）、触摸轨迹级宏录制（P2，投入产出比低）。

---

## 4. 三个迭代的切法

- **迭代 A（约 1.5 周）**：1 → 2 → 3。产出"能调试、能复盘"的可信闭环。这之后你录的每个流程失败时都能回答"哪一步、看到了什么、参数是什么"。
- **迭代 B（约 3 周）**：4 → 5 → 6 → 7 → 8。产出"换机器也能跑、断了能续、多台能一起跑"的稳定性。这是挂机场景的及格线。
- **迭代 C（按需）**：9 → 11 → 10，最后才是 12（AI）。

> 与你原来的建议一致的地方：AI 放最后。补充一条更硬的依据——AI 助手要读的是**结构化执行日志**（哪一步、什么参数、识别到什么、失败原因），而这东西现在是空的（D3），所以 3 是 12 的硬前置。

---

## 5. 需要你知道的三个"账实不符"

| 宣称 | 代码事实 |
|---|---|
| `README.md:269` 有 `set`（赋值）动作，示例 `设置变量 次数 = $次数 + 1` | 只对老状态机的边动作成立；步骤链的 `setvar` 曾是空转类型 —— **已在 A1 修通**（见 [execution-plan.md](./execution-plan.md) §2 A1） |
| `README.md:61` 安装包内置 PP-OCRv4 ONNX | 源码树 `engine/src/gamepilot/assets/ppocr_v4/` 只有 README，`.gitignore:29` 忽略 `*.onnx`；实际用的是 rapidocr wheel 里的模型（装了 `ocr` extra 才成立） |
| `apps/desktop/src/types.ts:95` `RecognizerType` 含 `'ocr'`、`graph-adapter.ts:95` 有 ocr 分支 | 引擎永不产出该类型（`build_recognizer` 拒绝），属死代码 |

另外两处环境问题：`engine/pyproject.toml:12` 钉 `opencv-python-headless>=4.9,<5`，但 `engine/.venv` 里是 **cv2 5.0.0**（环境漂移，建议 `uv sync` 重建）；`docs/DESIGN.md:46` 的进度表仍写"§5 功能清单待审定"，与代码现状脱节。

---

## 6. 关于"你要自动化什么游戏"——用代码事实反推

你的工具目前的能力边界已经回答了这个问题：

- **主战场是 Android 手游**：scrcpy 通道（点击 0.1ms、解码 28fps）是唯一做了深度优化的路径，真机实测记录在 `README.md:332-349`。
- **iOS 可做但受限**：一进程一台（`devices/ios.py:129-146`），~8fps，适合单机自动化，不适合多设备农场。
- **PC 游戏：地基已补（2026-10-22）**：`devices/windows.py` 支持按窗口句柄绑定、`PrintWindow`/`BitBlt` 抓图、
  `SendInput`/`PostMessage` 双输入；**真实游戏尚未逐款验证**（独占全屏、反作弊/管理员权限是已知边界）。
- **QA/兼容性测试**是天然的第二个场景：`workspace`/`workflow` 目录化 + `graph.json` 可 git diff（`library.py:33`、`graph.py:220-250`）本来就像一个测试资产管理器，缺的只是批量执行与报告（第 8、9 项）。

**建议的答案组合**：Android 手游 + 挂机/日常/刷关；若同时要做兼容性测试，第 8 项（批量 + 汇总）优先级提到迭代 B 最前面。
