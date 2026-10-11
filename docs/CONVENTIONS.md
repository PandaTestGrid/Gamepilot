# GamePilot 项目规范

> 本文是**约定**，不是建议。写代码前先读 §1 / §4（这两节违反了会让整个项目结构崩掉）。
> 规范变更要改本文档并在 §13 变更记录里留痕。
>
> 相关文档：[设计文档](./DESIGN.md) · [RPC 契约](./rpc.md)

---

## 0. 快速索引

| 你要做的事 | 看哪节 |
|---|---|
| 新建文件/模块，不知道该放哪 | §1 仓库结构与依赖方向 |
| 起名字（节点 id、识别器 label、RPC 方法、分支、commit） | §2 命名规范 |
| 写 TS / Python / Rust | §3 语言与代码风格 |
| 传坐标、传图像、传时间 | §4 数据与坐标铁律 |
| 改 RPC 方法或 graph.json 字段 | §5 契约与版本 |
| 加测试 / 判断该不该写测试 | §6 测试规范 |
| 想加一个第三方库 | §7 依赖准入 |
| 提交代码 | §8 提交与分支 |
| 加一个设备 / 识别器 / RPC 方法 | §11 扩展点 SOP |
| 判断「这个活算完了吗」 | §12 DoD 检查单 |

---

## 1. 仓库结构与依赖方向

```
gamepilot/
├── docs/                        # 设计、规范、契约（改代码前先改这里）
│   ├── DESIGN.md                # 总体设计（布局/数据模型/里程碑）
│   ├── CONVENTIONS.md           # 本文档
│   ├── rpc.md                   # JSON-RPC 契约
│   └── adr/                     # 重大决策记录（一决策一文件）
├── apps/desktop/                # Tauri 2 壳 + React 前端
│   ├── src/
│   │   ├── App.tsx              # 主壳：装壳 + 订阅；具体布局在 layout/
│   │   ├── types.ts             # 界面层数据模型 + Tab 枚举（RightTab / DockTab）
│   │   ├── layout/              # 壳与布局：Toolbar / DeviceTabs / PanelShell / StatusBar
│   │   │   ├── WorkspaceLayout.tsx  # 主区 + 底部调试抽屉（纵向可拖）
│   │   │   ├── PaneColumns.tsx      # 三栏（画面/状态图/右栏，横向可拖）
│   │   │   ├── RightColumn.tsx      # 右栏 Tab（脚本库 / 识别器）
│   │   │   ├── BottomDock.tsx       # 底栏状态行 + 抽屉开关
│   │   │   ├── RunButton.tsx        # 运行/停止（顶栏与图栏头共用）
│   │   │   └── StandalonePane.tsx   # ?pane= 独立窗口
│   │   ├── features/
│   │   │   ├── device/          # ScreenPane（画面/网格/录制）、RecordOverlay、DevicePopover
│   │   │   ├── graph/           # GraphPane（React Flow）+ 节点/边编辑器
│   │   │   ├── events/          # EventFeed（事件流，可复用）+ TimelinePane
│   │   │   ├── library/         # 脚本库（多状态图：列表/新建/复制/重命名/移除）
│   │   │   ├── debug/           # 底部抽屉（日志 / 控制台）+ Tab 元数据
│   │   │   └── recognizers/     # RecognizerPane（分数 + 阈值滑块）
│   │   ├── components/ui/       # shadcn/ui 组件（CLI 生成，可改）
│   │   ├── lib/rpc.ts           # 与引擎通信的唯一出口
│   │   ├── lib/log-bus.ts       # 界面日志总线（devLog → 日志抽屉，避免 lib 反向依赖 store）
│   │   ├── lib/useRunControl.ts # 运行/停止的唯一控制器（顶栏 + 图栏头共用）
│   │   ├── lib/windows.ts       # 多窗口（Tauri）与 ?pane= 解析
│   │   ├── stores/              # Zustand：device / graph / event / ui / engine / session
│   │   │                        #          / library（脚本库）/ log（日志环形缓冲）
│   │   ├── mock/seed.ts         # 布局用样本数据（M1 删除或仅留演示模式）
│   │   └── test/                # 测试 setup（jsdom 补丁）
│   └── src-tauri/               # Rust：窗口 / sidecar 守护 / RPC 转发
│       └── src/engine.rs        # 引擎桥（唯一与 Python 进程打交道的地方）
└── engine/                      # Python 引擎
    ├── src/gamepilot/
    │   ├── core/                # 纯逻辑：几何 / Frame / 识别器 / 状态图 / 引擎 / 时间轴
    │   ├── devices/             # 设备实现：mock / android / windows
    │   ├── rpc/                 # stdio JSON-RPC 服务
    │   └── protocol.py          # 协议常量（前后端契约的源）
    └── tests/                   # pytest（全部离线可跑）
```

### 依赖方向（单向，不允许反向或横跨）

```
        apps/desktop/src (React)
                 │  invoke / listen        ← 只能经 lib/rpc.ts
        src-tauri (Rust 壳)
                 │  stdio NDJSON JSON-RPC
        engine/rpc ──▶ engine/core ◀── engine/devices
```

| 规则 | 说明 | 怎么检查 |
|---|---|---|
| R1 | `core/` **不得** import `rpc/` 或 `devices/` | `ruff` 的 TID/import 规则 + code review |
| R2 | `devices/` 只能 import `core/` | 同上 |
| R3 | 前端组件**不得**直接碰设备或进程，一切经 `lib/rpc.ts` | ESLint `no-restricted-imports` |
| R4 | Rust 业务逻辑一律不写：它只做窗口 + sidecar 生命周期 + 转发 | code review |
| R5 | 像素坐标不得跨出 `devices/` 层（见 §4） | code review + 单测 |
| R6 | 不允许 `features/A` 直接 import `features/B` 的内部文件；需要共享就提到 `lib/` 或 `stores/` | ESLint `no-restricted-imports` |
| R7 | 一个面板一个文件、一个 store 一个文件；壳只负责装壳（`App.tsx` 不写具体布局），布局都在 `layout/` | code review |

> R1/R2 会在 M1 加进 ruff 的 `flake8-tidy-imports`（`banned-api`）配置；R3/R6 在 M1 加进 ESLint。

---

## 2. 命名规范

### 2.1 状态图领域（会被写进 graph.json 和模板文件名，改一次要迁移数据，所以最严格）

| 对象 | 规则 | 示例 |
|---|---|---|
| 识别器 label | `snake_case`，`<界面或功能>_<元素>`，全局唯一 | `main_start`、`battle_settle`、`popup_close` |
| 模板文件名 | 与 label **完全一致** + `.png` | `main_start.png` |
| 状态节点 id | `snake_case`，用界面名 | `main`、`shop`、`battle`、`result` |
| 普通边 id | 前缀 `e_` + 动词/目标 | `e_start`、`e_settle`、`e_back` |
| recovery 边 id | 前缀 `r_` + 中断类型 | `r_popup`、`r_disconnect`、`r_out_of_stamina` |
| 事件类型 | `snake_case`，**过去式或名词**，由引擎定义 | `node_entered`、`edge_matched`、`transition_failed` |

### 2.2 代码

| 语言 | 对象 | 规则 | 示例 |
|---|---|---|---|
| TS | 组件文件 | `PascalCase.tsx` | `DevicePanel.tsx` |
| TS | hook | `useXxx.ts` | `useDeviceStream.ts` |
| TS | store | `xxx.store.ts` | `event.store.ts` |
| TS | 工具/纯函数文件 | `kebab-case.ts` | `event-tone.ts` |
| TS | 函数/变量 | `camelCase`；布尔用 `is/has/should` 前缀 | `isRunning` |
| TS | 常量 | `UPPER_SNAKE_CASE` | `PROTOCOL_VERSION` |
| TS | 类型/接口 | `PascalCase`，禁止 `I` 前缀 | `EngineNotification` |
| Python | 模块/函数/变量 | `snake_case` | `score_node` |
| Python | 类 | `PascalCase` | `TemplateRecognizer` |
| Python | 常量 | `UPPER_SNAKE_CASE` | `PROTOCOL_VERSION` |
| Rust | 遵循 rustfmt/clippy 默认 | — | `EngineProcess` |
| 通用 | 目录 | `kebab-case`（Python 包目录用 `snake_case`） | `features/recognizers/` |
| 通用 | 标识符一律英文；注释/文档可中文 | — | — |

### 2.3 Git

- 分支：`main`（始终可运行）、`feat/<slug>`、`fix/<slug>`、`chore/<slug>`、`docs/<slug>`
- commit：Conventional Commits，scope 限定为顶层域

```
<type>(<scope>): <一句话>
type:  feat | fix | docs | refactor | test | chore | perf
scope: desktop | engine | core | devices | rpc | docs | deps | ci
```

示例：`feat(engine): 状态机支持 recovery 边`、`fix(rpc): 修正超时后未清理 pending`

- **一个 commit 一个可验证的行为改动**。禁止「顺手重构 + 新功能」混在一个 commit。
- 提交前必须过 §12 DoD；单人项目也要走，别给自己开后门。

---

## 3. 语言与代码风格

### 3.1 TypeScript / React

- 已开启（`tsconfig.json`）：`strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`、`noUnusedLocals/Parameters`、`isolatedModules`、`verbatimModuleSyntax`。
- **禁止 `any`**（ESLint error）。外部数据一律 `unknown` + 类型收窄。
- 类型导入必须用 `import { type Foo }`（`verbatimModuleSyntax`）。
- 组件用**函数组件 + named export**（`react-refresh` 规则需要）；只有 `main.tsx` 允许顶层副作用。
- 状态管理：**服务端/引擎状态放 Zustand store**，组件内只放 UI 局部状态（选中项、hover）。
- 不在组件里写死颜色：一律用 `index.css` 里的 theme token（§4.5 的语义色也是 token）。
- 副作用收敛在 hook 里；`useEffect` 必须有明确的清理函数（订阅类必须有）。

### 3.2 Python

- **Python 3.11+**（引擎统一用 `engine/.venv`，不要用系统 3.9 / DSH bundled Python）。
- 每个模块顶部 `from __future__ import annotations`。
- 格式化与 lint 全部交给 ruff（`pyproject.toml` 已配好）：
  - `line-length = 120`、`target-version = "py311"`、双引号
  - 规则集：`E,F,W,I,N,UP,B,SIM,RUF`
- 类型：`mypy --strict` 覆盖 `src/`，`tests/` 放宽（允许不写注解）。
- 公有函数/类必须有 docstring（中文可以），说明**契约与副作用**，不写废话注释。
- 日志：`logging` + **stderr**；引擎的 stdout 归协议（见 §4.6）。

### 3.3 Rust

- 提交前跑：`cargo fmt` + `cargo clippy -- -D warnings` + `cargo test`。
- 壳里的代码只允许出现在 `src-tauri/src/`，且不与业务耦合（§1 R4）。

---

## 4. 数据与坐标铁律

这一节是本项目最容易踩的坑，全部靠约定 + 单测守住。

| # | 规则 | 为什么 |
|---|---|---|
| 4.1 | **所有跨模块坐标一律 `[0,1]` 归一化**；像素转换只允许出现在 `devices/` 内部 | 投屏缩放（scrcpy 常把 1080p 缩成 720p）、分辨率切换、云手机换机型都不该影响识别与点击 |
| 4.2 | 图像一律 **BGR** `uint8` ndarray（引擎内）；跨 RPC 只传 **base64 JPEG** | 与 OpenCV 一致；RGB/BGR 混用是最经典的静默错误 |
| 4.3 | 时间统一 **Unix 秒 float**（`ts`）；持续时间/超时统一 **毫秒 int**（字段名带 `_ms`） | 不写单位就是 bug 温床 |
| 4.4 | 匹配分数 / 阈值统一 **`0.0 ~ 1.0` float**，越大越严格 | 颜色识别的「覆盖度」也归一到同一区间 |
| 4.5 | 事件 `seq` **单调递增**；前端发现跳号要显式告警 | 判断「前端丢帧」还是「引擎重启」 |
| 4.6 | 引擎 **stdout 只允许协议帧**；日志/调试输出必须走 stderr | 否则前端解析直接崩 |
| 4.7 | 缺省值用 `null` 显式表达，不用魔法值（`-1`、`""`） | DSL 需要能区分「没配」和「配了空」 |
| 4.8 | 识别器必须是**纯函数**：`detect(frame, roi) -> Detection[]`，不得持有业务状态 | 可测试、可并发、可缓存 |

---

## 5. 契约与版本

### 5.1 RPC 契约

- 契约源在 `engine/src/gamepilot/protocol.py`，人读版在 `docs/rpc.md`，前端类型在 `apps/desktop/src/lib/rpc.ts`——**三处必须同步**。
- 变更分级：

| 变更 | 是否破坏性 | 动作 |
|---|---|---|
| 新增可选字段 / 新增方法 | 否 | 只改三处实现 |
| 新增必填字段 / 改字段语义 / 改事件名 / 删方法 | **是** | `PROTOCOL_VERSION += 1`，更新 `docs/rpc.md` 变更记录，前端同步 |
| 改分帧方式（NDJSON → 其它） | 是 | 同上，并在 Rust 桥与 Python 侧同时改 |

- JSON-RPC 错误码固定用标准值（`-32700/-32600/-32601/-32602/-32603`），自定义错误码从 `1000` 起并在 `docs/rpc.md` 登记。

### 5.2 状态图 `graph.json`

- 顶层必须有 `version`（当前 `1`）。
- 加载时必须校验：引用的节点/识别器是否存在、字段类型是否正确；不兼容就**明确报错**，不允许静默降级。
- UI 私有字段（节点坐标等）统一放在 `ui` 对象里，引擎必须忽略它——保证「引擎不懂 UI，UI 可以随便改」。

---

## 6. 测试规范

| 层 | 框架 | 必须测什么 | 不写什么 |
|---|---|---|---|
| `engine/core` | pytest | 几何换算、投票过滤、状态机迁移/recovery 优先级/超时重试、DSL 校验 | 不用真实设备 |
| `engine/rpc` | pytest（子进程） | 信封、分帧、错误码、stdout 纯净性 | — |
| `engine/devices` | pytest + Mock 设备 | 归一化↔像素换算、点击命中、状态流转 | 真机行为只做手工验证 |
| Rust 壳 | `cargo test` | 命令解析、与引擎的 ping 往返 | Tauri 窗口行为 |
| 前端纯函数/store | Vitest | 映射函数（`graphParser`、`eventTone`）、store 状态机 | — |
| 前端组件 | Vitest + Testing Library | 关键交互（录制浮层、阈值滑块） | 像素级视觉回归 |

规则：

1. **CI 必须全程离线可跑**：任何依赖真机/模拟器的测试都不能进 CI。
2. 改 `core/` 必须带测试；修 bug 必须先写一个能复现的失败测试。
3. 命名：`test_<被测对象>_<场景>_<期望>`（Python）/ `it('<场景> -> <期望>')`（TS）。
4. 覆盖率不追求数字，但 `core/` 的目标是行覆盖 ≥ 80%；不为了覆盖率写无断言测试。

本地一条命令跑全部：`pnpm check`（含前端 + 引擎；Rust 单独 `cargo test`）。

---

## 7. 依赖准入

1. **许可白名单：MIT / Apache-2.0 / BSD / ISC / 0BSD**。
   **禁止** GPL / AGPL / LGPL / SSPL 代码进入仓库（引用、拷贝、改写的都不行）。理由：保证以后想闭源或商用不受传染。
2. 加依赖前问三句：
   - 标准库/已有依赖能不能做？
   - 维护是否活跃（近一年有提交）、体积是否可接受？
   - 有没有更小的替代（例如图表用 uPlot 而不是 ECharts）？
3. 每次新增依赖必须在 commit message 里写明**用途 + 许可**。
4. 定期抽查：`pnpm licenses list`、`uv pip list`、`cargo deny`（M2 接入）。
5. **已批准依赖清单**（新增依赖前先看这里有没有可复用的）：

| 层 | 依赖 | 许可 | 用途 |
|---|---|---|---|
| 前端 | react / react-dom | MIT | 框架 |
| 前端 | @xyflow/react (React Flow) | MIT | 状态图画布 |
| 前端 | react-resizable-panels | MIT | 三栏拖拽 + 布局记忆 |
| 前端 | zustand | MIT | 全局状态 |
| 前端 | tailwindcss / shadcn-ui(cli) | MIT | 样式与组件 |
| 前端 | lucide-react | ISC | 图标 |
| 前端 | clsx / tailwind-merge | MIT | 类名合并 |
| 前端 | class-variance-authority | Apache-2.0 | 组件变体 |
| 前端 | uplot | MIT | 性能曲线（M4 用） |
| 工具 | vite / vitest / eslint / prettier | MIT | 构建与质量 |
| 工具 | typescript | Apache-2.0 | 类型 |
| 壳 | tauri / tauri-plugin-log / serde | MIT 或 Apache-2.0 | 桌面壳 |
| 引擎 | numpy | BSD-3 | 数值 |
| 引擎 | opencv-python-headless | Apache-2.0 | 图像识别 |
| 引擎 | pillow | HPND(MIT-CMU) | 合成测试画面 |
| 引擎 | rapidocr-onnxruntime（可选） | Apache-2.0 | OCR 识别器 |
| 引擎 | av (PyAV) | BSD-3 | scrcpy H.264 解码（投屏主通道） |
| 引擎 | scrcpy-server（vendor/，非 Python 依赖） | Apache-2.0 | 设备端投屏/控制程序，版本 3.3.4 与 `devices/scrcpy.py::SCRCPY_VERSION` 对齐 |
| 引擎 | pytest / ruff / mypy | MIT | 测试与静态检查 |

---

## 8. 提交与分支

- 直接在 `main` 上做也可以（单人自用项目），但**每个 commit 必须自洽可运行**。
- 提交前：`pnpm check` + `cargo clippy`（改了 Rust 时）。
- 提交信息模板：

```
<type>(<scope>): <做了什么>

为什么：<动机/问题>
怎么验证：<跑过的命令或手工步骤>
```

- 禁止提交：`.venv/`、`node_modules/`、`dist/`、`target/`、运行产物（`runs/`、`assets/runtime/`）、任何密钥/token。
- 大文件（>5MB 的模型、素材）不进 git；放 `assets/` 时确认已在 `.gitignore` 的例外白名单里。

---

## 9. 文档规范

- 设计变更**先改文档再改代码**：`docs/DESIGN.md` 对应章节 + 底部「变更历史」加一行。
- 单个决策（选型、架构取舍）写 `docs/adr/NNNN-标题.md`，模板见 `docs/adr/0000-template.md`。
- 契约变更同步 `docs/rpc.md` 的变更记录。
- 代码注释写「为什么」，不写「是什么」；对外行为写进 docstring。
- 每个新目录都要有 `README.md` 说明职责与规则（`features/*` 已示范）。

---

## 10. 常用命令

| 目的 | 命令 |
|---|---|
| 装前端依赖 | `pnpm install` |
| 装引擎依赖 | `cd engine && uv sync` |
| 启动桌面 App（开发态） | `pnpm tauri dev` |
| 只跑前端页面（浏览器） | `pnpm dev` |
| 前端 lint / 类型 / 测试 / 构建 | `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` |
| 引擎 lint / 类型 / 测试 | `pnpm engine:lint` / `pnpm engine:test` |
| 全量检查（提交前） | `pnpm check` |
| Rust 检查 | `cd apps/desktop/src-tauri && cargo clippy -- -D warnings && cargo test`（首次或改过前端后先 `pnpm build`，`tauri::generate_context!` 要求 `dist` 存在） |
| 格式化 | `pnpm format`（前端/文档）+ `pnpm engine:fmt` |
| 引擎自检（协议/版本） | `cd engine && uv run python -m gamepilot` |

---

## 11. 扩展点 SOP

### 11.1 加一个设备（例如 iOS、云手机）

1. `engine/src/gamepilot/devices/<name>.py`：实现 `Controller` 协议（`connect/close/resolution/screenshot` + 归一化输入方法）。
2. 注册 URI scheme：`Android:///`、`Windows:///?title_re=...` 这种形式。
3. 在 `devices/__init__.py` 里 import 以触发注册。
4. 写单测：归一化↔像素换算 + 点击命中（用 Mock 画面，不连真机）。
5. 更新 `docs/CONVENTIONS.md` §1 的目录说明 + `docs/DESIGN.md` §6.4 选型表。
6. 用 `doctor` 命令做一次真机自检并在 commit message 里贴结果。

### 11.2 加一个识别器（例如 YOLO 检测、VLM 兜底）

1. `engine/src/gamepilot/core/recognizer.py`：实现 `detect(frame, roi) -> Detection[]`，**纯函数**。
2. 在识别器工厂注册类型名（`type` 字段的值），并在 `docs/rpc.md` / DSL 说明里补字段。
3. 前端 `features/recognizers/` 加对应的配置表单与徽标。
4. 单测：合成图像 → 期望命中/不命中；阈值边界。
5. 若引入模型文件：确认大小与许可，模型不进 git。

### 11.3 加一个 RPC 方法

1. `engine/src/gamepilot/rpc/` 注册 handler（`RpcServer.method` 装饰器）。
2. 常量加到 `protocol.py`（方法名、通知名）。
3. 更新 `docs/rpc.md`（方法表 + 变更记录）。
4. 前端 `lib/rpc.ts` 加类型化封装 + 单测。
5. 破坏性变更记得升 `PROTOCOL_VERSION`（§5.1）。

### 11.4 加一个事件类型

1. 引擎侧定义事件名（`snake_case`，过去式）并在 `protocol.py` 登记。
2. `docs/rpc.md` 事件表补充：字段、触发时机、频率（是否会刷屏）。
3. 前端 `features/events/eventTone.ts` 加语义色映射 + 单测。
4. 高频事件必须做节流/聚合，禁止把每帧事件直接推给 UI。

---

## 12. Definition of Done

一个改动算「做完」，必须同时满足：

- [ ] 行为符合 `docs/DESIGN.md`；若设计有变，文档已先改
- [ ] `pnpm check` 全绿（lint + typecheck + test + engine lint/test）
- [ ] 改了 Rust：`cargo clippy -- -D warnings` 与 `cargo test` 全绿
- [ ] 新增/修改的 `core`、`rpc`、映射函数有对应测试
- [ ] 契约变更已同步 `protocol.py` / `docs/rpc.md` / `lib/rpc.ts` 三处
- [ ] 无颜色/坐标/时间的硬编码（分别走 token / 归一化 / 带单位字段）
- [ ] 新依赖符合 §7 许可白名单并在 commit message 说明
- [ ] 日志没有污染 stdout；错误路径有明确报错信息（含排查建议）
- [ ] 文档/注释已更新（目录 README、图表、命令表）
- [ ] commit message 说明了「为什么」与「怎么验证」

---

## 12.5 帧数据的传输约定

大块二进制（画面帧）**不允许**塞进 JSON-RPC 消息或 Tauri 事件：

- 引擎 → host：unix socket 原始字节（`GAMEPILOT_FRAME_SOCKET`，见 rpc.md §3.5）
- host → 界面：`engine_frame` 命令返回 `ArrayBuffer`，前端造 blob URL 给 `<img>`
- 控制通道（stdio / Tauri 事件）只承载**小消息**：元数据、事件、RPC

同时界面必须用 `device.stream` 告诉引擎"这台设备我看多少帧"（0 = 停推）：
单画面 10fps、多开每台 4~6fps、窗口不可见 0fps。不做这件事，多设备必然卡。

## 12.6 布局陷阱（都真实踩过，改 UI 时注意）

1. **`<button>` 有 `align-items: center` 的浏览器默认样式**。
   如果按钮里是"只有绝对定位内容"的容器，它的内容宽度是 0，居中布局下会被压成 **0 宽**：
   图片加载成功、`getBoundingClientRect()` 宽度却是 0，表现就是"看不见画面"。
   → 显式写 `items-stretch`（或用 `<div role="button">`）。
2. **`flex-1` 的内容区必须同时有确定的父高度**。
   全绝对定位的内容撑不起高度，父级缺 `h-full` 时会被压成 0 高（表现为"只剩一条边框线"）。
   → `PanelShell` 的 `<section>` 有 `h-full`，内容区是 `min-h-0 flex-1` + 内层 `h-full`。
3. **网格的行高必须显式给 `minmax(0, 1fr)`**。
   默认 `auto` 行同样会被绝对定位内容撑成 0 高。→ `gridAutoRows` / `gridTemplateRows`。
4. 排查这类问题的办法：在组件里打一行 `devLog(... getBoundingClientRect())`，
   直接看"元素有没有真的被渲染出尺寸"，比盯着代码猜快得多。
5. **可拖拽区域一律登记在 `layout/layout-specs.ts`**，不要在组件里散写 `defaultSize`。
   主壳三栏是横向 Group（拖宽度），栏内是纵向 Group（拖高度）；`Panel` 的 `id` 必须与
   `LayoutSpec.panels` 的 key 完全一致 —— 预设走 `setLayout`，它会校验"key 数必须等于面板数"，
   对不上就抛错（而且只在点预设那一刻炸）。
6. **收起态的 Panel 不要收到 0**。纵向 Group 里最下面那个面板收成 0 时，它的分隔线会正好压在底栏
   （StatusBar）上边：指针事件被底栏接走，用户想拖回来反而拖不动。收起态留一条提示条（28px）即可。
7. **`text-*` 工具类会同时查字号表与颜色表**。本项目有背景色 token `--color-panel`，
   所以字号 token 不能叫 `--text-panel`：`.text-panel` 生成的是 `color: var(--bg-panel)`，
   四个面板标题会被涂成面板底色（看起来就是"标题没了"）。字号叫 `--text-panelhead`。
8. **React Flow 用受控 `nodes` 时，必须自己接 `onNodesChange`，否则节点只在松手后跳过去**。
   内核里 `triggerNodeChanges` 只在**非受控**模式才 `applyNodeChanges`，受控时仅回调；
   官方示例都走 `useNodesState` 那一套，我们漏了这一步，表现就是"按住拖动画面不动"。
   本项目的做法：回调里把拖动中的坐标记进组件本地表（`dragging`），合进 `nodes` 让画面跟手；
   真源仍是状态图 store，落盘只走 `onNodeDragStop` 一次（不要每移动一像素写一次图表）。

## 13. 已知环境坑

| 坑 | 现象 | 解法 |
|---|---|---|
| DSH bundled Python 3.12 | `pip install` 的 `.so` 加载失败（签名 Team ID 不匹配） | 不要用它；项目统一 Homebrew `python3.11` + `engine/.venv` |
| 系统 Python 3.9 | numpy 需源码编译，装不上或极慢 | 同上 |
| 首次 `cargo build` | 要拉几百个 crate，几分钟 | 正常；CI 用缓存 |
| macOS Gatekeeper | 未签名的 app 首次打开被拦 | M5 处理签名/公证；开发态用 `pnpm tauri dev` |
| 引擎未启动就调 RPC | Rust 返回「引擎未启动」 | 前端先 `engineStart()`（骨架自检按钮就是这么做的） |

---

## 14. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| — | v1 | 初版：依赖方向、命名、风格、坐标铁律、契约版本、测试矩阵、依赖准入、提交规范、扩展点 SOP、DoD |
