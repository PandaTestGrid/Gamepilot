# 工作流画布（`features/graph`）

**职责**：把当前工作流的 `graph.json` → **`flow.steps`** 渲染成步骤链（Automa 式：触发 + 模块 + 连线改顺序）。识别器仍在 `graph.recognizers`。

运行真源：`FlowEngine`（`flow.steps` 非空时优先于状态机）。`nodes/edges` 仅兼容旧数据；**中间栏不再编辑状态图**，引擎对 `flow.steps` 非空的工作流会 **拒绝 `graph.node.*` / `graph.edge.*`**（见 `docs/rpc.md`）。

## 目录

| 路径 | 说明 |
|------|------|
| `GraphPane.tsx` | 壳：标签、左栏模块、画布、下方详情坞 |
| `flow/FlowCanvas.tsx` | 官方 `@xyflow/react` + `graph.css` |
| `flow/FlowStepNode.tsx` | 模块卡片（`state-node` 样式与旧节点一致） |
| `flow/FlowStepEditor.tsx` | 选中模块参数 |
| `flow/ModulePalette.tsx` | 左侧拖模块 |
| `flow/flow-layout.ts` | 顺序链 ↔ 节点/边 |
| `flow/flow-canvas-sync.ts` | 拖动中不被 store 覆盖坐标 |
| `flow/FlowRunStrip.tsx` | 画布左下：空闲连线说明 / 运行中当前步 |
| `graph.css` | 暗色主题下的拖拽/边/控件补样式 |
| `GraphToolbar.tsx` | 运行、重新布局、卡片大小 |

## 手势（xyflow 默认 + 项目约定）

| 操作 | 行为 |
|------|------|
| 拖空白 | 平移画布 |
| 拖模块卡片 | 只改摆位（localStorage） |
| 右圆点 → 左圆点 | 改 **执行顺序**（写回 `flow.steps`） |
| 左栏按住拖模块 | 指针拖放（Tauri 兼容）；追加或拖到节点上 **插入其后** |
| 双击模块 | 打开下方详情 |

同步节点时：**正在拖的节点坐标取 React Flow 本地**，见 `flow-canvas-sync.test.ts`。

## 录制

画面栏「录操作」→ 引擎 `record.action`：若工作流已有 **`flow.steps`**，追加一步到链尾（不再写 `edges`）；画布会自动选中新建模块。

## 共享组件

- `GraphContextMenu.tsx` — 步骤链画布 / 节点右键加模块
