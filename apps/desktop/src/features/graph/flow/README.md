# Flow 编辑模型

**显式连线 + 线性 `steps[]`**。画布上的每一条线都是一条真实存在的边，存在步骤的 `params._out` 里；
Python 引擎仍然只吃线性 `steps[]`（`cond/else/condend`、`loop/loopend` 块配对），引擎一行没改。

## 真源

- **`graph.flow.steps`**：引擎的执行顺序。
- **`params._out`**：画布上的连线。每条 `'<出口>><目标步骤 id>'`，例如 `'then>abc'`、`'else>def'`、`'out>ghi'`、`'body>jkl'`。
  - 有 `_out` = 显式模式：画布只画 `_out` 里的线，不再按数组顺序补线，也不因为连线搬动节点。
  - 一个步骤都没有 `_out` = 老文件：先按老规则推导一次（打开和以前一模一样），保存时冻结进 `_out`。

## 核心文件

| 文件 | 职责 |
|------|------|
| `flow-edge-model.ts` | 连线真源：`flowEdges`（读）、`withFlowEdges`（写）、`linearizeFlow`（图 → 线性 steps）、`connectFlowSteps` / `disconnectFlowSteps` / `insertStepBeforeFlowStep` |
| `flow-structure-core.ts` | 块解析、校验（`parseBlocks` / `validateFlowSteps`）等底层工具 |
| `flow-structure.ts` | 面向老调用方的适配层：`connectSteps` / `disconnectSteps` / `insertUnitBefore` / 删除 / `migrateFlowSteps` |
| `flow-hidden.ts` | 画布不展示的块标记 / 隐藏跳出循环 |
| `flow-branch-layout.ts` | 把 `flowEdges` 渲染成画布边（只按 `_out` 画，不发明线） |
| `flow-disconnect.ts` | 删线 → 只删这一条，下游变「未接入」 |
| `flow-wrap-loop.ts` | Shift 多选连续段 → 套循环 |
| `flow-mutations.ts` | 画布连线、模块拖放 → 结构 |
| `flow-drop-target.ts` | 画布/模块栏拖放落点 |
| `flow-layout.ts` | 节点位置 + 未接入标记 |
| `flow-spacing.ts` | 统一格距（自动排版 / 插入 / 追加共用）：必须比最宽卡片大，否则节点会贴在一起 |
| `flow-node-size.ts` | 卡片真实高度（`offsetHeight` 量 + 按条件行数估）：分支挂在头节点底边下面，不能写死行距 |
| `FlowCanvas.tsx` | 画布 UI |
| `WorkflowWorkspace.tsx` | 模块栏 + 画布工作区 |

## UI 入口

1. **画布连线** — `connectFlowSteps` → `structureFromCanvasLink` → `connectSteps`（只加一条边，然后重新线性化）
2. **模块栏** — `applyModuleDrop` → 插入/追加模块

## 连线语义

- **加一条线**：只改 `(来源, 出口)` 对应的那一条边；同一个出口只有一条线，重连 = 换掉旧的那条。
- **删一条线**：只删这一条，下游变成「未接入」（`_pendingLink`，跑的时候引擎走到它之前就结束），
  不会自动接回上游，也不会接到别的模块。
- **节点不搬家**：连线只改顺序（`linearizeFlow` 把图写成引擎要的数组），节点的画布位置由用户拖动，接线不动坐标。
- **空的条件支**：不画线、也不发明「否则」，目标就是未接入；接上「成立 / 不成立」才有线。
- **循环回线**：只有真的画了「循环体最后一步 → 循环头」才有那条虚线；删掉它循环就不再提前回头。
  循环体自然走到 `loopend` 仍然是引擎正常计数的循环，不需要额外那条线。

## 接线限制（`linearizeFlow` 拒绝的图）

只有「条件 / 循环结束后的下一步」可以是两路汇合点。除此之外：

- 成环（把线接回前面的模块）→ `模块连成了环（…）`
- 一个模块被两条线接上、又不是块后那一步 → `一个模块被两条线同时接上…`
- 两条分支接到不同的下一步 → `两条分支接到了不同的下一步…`
- 「结束」「跳出循环」没有出口；块标记（否则 / 条件结束 / 循环结束）不能直接连。

拒绝时返回中文原因，`steps` 原样不动。

## 非法连线

`connectionRejectReason` / `isFlowConnectionAllowed` 与 `connectSteps` 同源。
