# features/graph — 状态图画布

**职责**：把 `graph.json` 渲染成可读/可编辑的节点图（React Flow / xyflow）。

计划内容（M3~M5）：
- `GraphCanvas.tsx` — React Flow 容器、自动布局、缩放/框选
- `nodes/StateNode.tsx` — 自定义节点：名称、判定标签数、当前态高亮
- `edges/TransitionEdge.tsx` — 普通边（绿）与 recovery 边（红虚线 + ⚡）两种样式
- `graphParser.ts` — 引擎 `graph.to_dict()` ↔ React Flow 节点/边 的纯函数映射（**必须单测**）
- `ValidationPanel.tsx` — 校验结果：不可达节点、无恢复边、从未命中的识别器

规则：
- 数据形状以引擎的 `graph.to_dict()` 为准；本目录只做映射，不改写字段语义。
- 位置信息（x/y）是 UI 私有的，写回 `graph.json` 时放在 `ui` 字段下，引擎忽略。
