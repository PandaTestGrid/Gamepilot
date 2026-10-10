# GamePilot

面向**游戏**的状态机式自动化框架 —— 目标是 Airtest 的交互手感 + 挂机场景需要的状态感知与自愈能力。

- 桌面端：**Tauri 2**（Rust 壳）+ React 19 + TypeScript + Tailwind v4 + shadcn/ui
- 引擎：**Python 3.11+**（感知 / 决策 / 执行 / 事件），作为 sidecar 由壳守护
- 通信：**JSON-RPC 2.0 over stdio**（NDJSON 分帧）
- 设备：Android（adb → scrcpy）、Windows（DXGI + 虚拟 HID）、Mock（离线端到端）

> 当前状态：**项目骨架已完成**（工程配置、规范、契约、三栏布局占位、引擎链路自检）。
> 业务功能按 [`docs/DESIGN.md`](./docs/DESIGN.md) 的 M1~M5 里程碑推进。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/DESIGN.md`](./docs/DESIGN.md) | 总体设计：定位、Airtest 对照、数据模型、**UI 线框**、功能清单、里程碑 |
| [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md) | **项目规范**：依赖方向、命名、风格、坐标铁律、契约版本、测试矩阵、DoD |
| [`docs/rpc.md`](./docs/rpc.md) | 前端 ⇄ 引擎的 RPC 契约 |
| [`docs/adr/`](./docs/adr/) | 重大决策记录 |

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20（本机 24） | 前端构建 |
| pnpm | ≥ 9（本机 10.23） | 包管理（workspace） |
| Rust | ≥ 1.90（本机 1.97） | Tauri 壳 |
| Python | **3.11**（Homebrew） | ⚠️ 不要用系统 3.9 或 DSH bundled Python，见 CONVENTIONS §13 |
| uv | ≥ 0.5（本机 0.11） | 引擎依赖管理 |

## 快速开始

```bash
# 1. 前端依赖
pnpm install

# 2. 引擎依赖（会创建 engine/.venv）
cd engine && uv sync && cd ..

# 3. 启动桌面 App（开发态，自动拉起 Vite 与 Python 引擎）
pnpm tauri dev

# 只跑前端（浏览器里看布局，RPC 不可用）
pnpm dev
```

首次打开 App，点右上角 **「骨架自检（拉起引擎 + ping）」**：状态变绿即表示
`React → Rust → Python` 三段链路打通。

## 第一版怎么用（已可用）

```bash
cd ~/Desktop/gamepilot
pnpm install && (cd engine && uv sync)
pnpm tauri dev
```

窗口里的顺序：

1. 点右上角 **「骨架自检」** → 变绿（`React → Rust → Python` 链路通）
2. 点顶栏 **设备选择器** → 打开会自动扫描 → 看到 adb 真机 / Mock → 点某一行即连接
   （连接成功自动收起弹层，画面栏开始出帧）
3. 点画面栏 **「框选」** → 在画面上拖一个矩形 → 弹层里填模板名、调阈值、选归属节点 →
   **确定并写入状态图**
   - 纯色区域会自动改用颜色识别器（模板匹配对纯色不可靠），事件栏会说明
   - 识别器面板立刻出现该识别器，并显示每帧的实时分数
4. 再录一个「下一个界面」的节点，然后在状态图里连边（画布拖拽或直接改 JSON）
5. 点顶栏 **「运行」** → 状态机开跑：事件栏出现 `node_entered` / `edge_matched` /
   `action_executed`，画面上的识别框按「已确认 / 待确认」两态变色
6. 想验证中断自愈：给弹窗录一条 `kind: "recovery"` 的边

工程文件在 `engine/projects/default/`（`graph.json` + `templates/`），可以直接 git diff；
用 `GAMEPILOT_PROJECT_DIR` 指向别的目录即可切工程。

### 性能现状（真机实测：OPPO A57 / USB 2.0）

| 通道 | 实测 | 说明 |
|---|---|---|
| adb `screencap -p`（当前默认） | **~1.8fps（553ms/帧）** | 免 root、兼容性最好；够录制与慢速状态机，不够"看着顺滑" |
| 三台设备同时截图 | ~1.3s/台 | USB 带宽共享，多开按此估算 |
| scrcpy（H.264，待做） | 目标 30~60ms | 下一步主要性能项 |
| 连接耗时 | 1.8~3s | 含 adb 握手 + 首帧等待 |
| 录制一次模板 | ~10ms | 从已有帧裁剪 + 落盘 |

## 提交前检查

```bash
pnpm check                                              # 前端 + 引擎（lint/类型/测试/格式化）
cd apps/desktop/src-tauri && cargo clippy -- -D warnings && cargo test   # 改了 Rust 时
```

## 目录

```
apps/desktop/     Tauri 2 壳 + React 前端（src/features/{device,graph,events,recognizers}）
engine/           Python 引擎（src/gamepilot/{core,devices,rpc}）
docs/             设计、规范、RPC 契约、ADR
```

## 不做的事

- 不做内存注入 / 读写进程内存 / 反反作弊 —— 只做「看屏幕 + 模拟输入」
- 不做通用 App 自动化测试平台、不做云真机调度
- 不引入 GPL/AGPL/LGPL 代码（保证后续可闭源分发）

## 风险提示

本项目用于**游戏自动化**，可能违反游戏用户协议并导致封号。请只用于自己账号的
重复性操作，不要用于代练、多开变现等场景。
