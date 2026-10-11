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

## 交互反馈（悬停 / 选中 / 拖拽）

| 文件 | 职责 |
|---|---|
| `StateNode.tsx` | 节点卡片：悬停/选中/拖拽三种描边与底色、引脚摊开、双击就地改名 |
| `graph.css` | Tailwind 够不着的那部分：拖拽中的父级类（`.dragging`）、边的光标、连线预览线 |

规则：

- 视觉状态只有一套语言：**悬停 = 描边提亮 + 底色抬一级；选中 = brand 描边 + `bg-active`；拖拽 = brand 描边**。
  不要用阴影/放大动画（DESIGN §4.0 禁阴影）。
- **边的线宽/颜色是逐条内联的**（每条边按"走不走得通"上色）→ CSS `:hover` 盖不住，
  悬停必须走 React 状态（`GraphPane` 的 `hoveredEdge`），顺序是"选中 > 悬停 > 默认"。
- 节点里的 store 选择器**不要写 `?? []`**：selector 每次返回新数组会让 `useSyncExternalStore`
  认为状态一直在变 → 无限重渲染（图还没加载完时必炸）。

## 画布上的模板截图与右键菜单

| 文件 | 职责 |
|---|---|
| `GraphContextMenu.tsx` | 右键菜单（空白 / 节点 / 边 三套；贴边翻转、Esc/点别处关闭） |
| `stores/template.store.ts` | 模板截图**进程级缓存**：一张模板只取一次，取到过就不再消失，失败可重试 |

规则：

- 画布上的缩略图是"这一步点的是哪个图标 / 这个界面长什么样"，一律读同一份缓存
  （`TemplateMini`）；**不要在画布里自己发 `template.image`**。
- 重新录制同一张模板（同名同路径、内容变了）必须 `clearTemplateCache([label])`，
  否则界面还在显示旧截图（`session.store.record` 里已经接了）。
- 右键菜单只放"入口 + 删除"这类不会误操作的项：参数编辑留在下方详情面板。
