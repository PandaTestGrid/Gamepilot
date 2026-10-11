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

## 画布手势：左键框选、中键/空格平移

用户反馈过两件事："鼠标一放上去就是个小手"、"怎么框选多个界面"。根因是同一个 ——
**左键拖空白原来是平移**（xyflow 默认），所以画布常驻 `cursor: grab`（`.react-flow__pane.draggable`），
而框选得靠 Shift+拖（没人知道）。现在：

| 操作 | 行为 |
|---|---|
| 左键拖空白 | **框选**（`selectionOnDrag`），框选矩形用品牌色（`.react-flow__nodesselection-rect`） |
| **滚动 / 双指滑动** | **平移画布**（`panOnScroll`）—— Mac 触控板没有中键，只靠空格太别扭 |
| **⌘+滚动** | 缩放（`zoomOnScroll={false}` + xyflow 的 `zoomActivationKeyCode`，Mac 上默认 Meta）；捏合也能缩放 |
| 中键拖 / **空格+拖动** | 平移（`panOnDrag={[1]}` + 默认 `panActivationKeyCode='Space'`） |
| 右键 | 右键菜单 |
| 点节点 | 选中（进下方编辑器）；`Shift/Meta/Ctrl` + 点 = 加选 |
| `Delete` / `Backspace` | 删除选中的界面 / 边（`deleteKeyCode`，macOS 上 Delete 要 Fn+Backspace，所以两个都收） |

规则：

- **`panOnDrag` 不能含 0**：含 0 时 xyflow 给 `.react-flow__pane` 加 `draggable` → `cursor: grab`
  就是那个"小手"，同时也意味着左键做不了框选；
- **`panOnDrag` 也不能含 2**（右键）：xyflow 的 `Pane.onContextMenu` 里，只要 `panOnDrag` 含 2 就
  `preventDefault()` 然后 return —— **右键菜单会被整个吞掉**，两者不能共存。所以 `[1]` 只能是中键；
- 多选状态（`GraphPane` 的 `selectedIds`）是**画布本地的临时状态**，不进 store：
  它和"下方编辑器在编辑哪一个"（`graph.store.selectedNodeId`）是两件事，画边框时取并集。
  但**必须喂回节点数据**（`selected`）并进 `nodeSignature` —— 引擎每帧推数据都会重建节点，
  不带上的话框选结果下一次同步就没了；
- 删界面**逐个调** `graph.node.remove`：引擎会把它连着的边一起删（`session.py: graph_node_remove`），
  所以不用自己先删边；正被下方编辑器编辑的那个被删掉时要 `selectNode(null)` 收起编辑器；
- 画布左下角的图例里写了"拖动空白 = 框选 · 空格/中键拖动 = 平移"，选中后还多一条
  "已选 N 个界面 · 删除 / 取消选择"的工具条（不然没人知道左键不再是平移）。

## 画布上的模板截图与右键菜单

| 文件 | 职责 |
|---|---|
| `GraphContextMenu.tsx` | 菜单（支持**二级**：`item.submenu`）：右键三套 + 节点 ⋯ + ＋添加操作（**portal 到 body**） |
| `action-menu.ts` | 「＋添加操作」的内容：一级动作类型、二级参数预设（纯函数，见 `action-menu.test.ts`） |
| `DockBar.tsx` | 详情坞的 `▸展开/▾收起` 控制条（收起时也显示在编辑什么） |
| `RunStatusStrip.tsx` | 运行状态条：当前界面 / 下一步 / 还差什么 |
| `stores/template.store.ts` | 模板截图**进程级缓存**：一张模板只取一次，取到过就不再消失，失败可重试 |

规则：

- 画布上的缩略图是"这一步点的是哪个图标 / 这个界面长什么样"，一律读同一份缓存
  （`TemplateMini`）；**不要在画布里自己发 `template.image`**。
- 重新录制同一张模板（同名同路径、内容变了）必须 `clearTemplateCache([label])`，
  否则界面还在显示旧截图（`session.store.record` 里已经接了）。
- 右键菜单只放"入口 + 删除"这类不会误操作的项：参数编辑留在下方详情面板。

## 坐标、小地图、视图

| 文件 | 职责 |
|---|---|
| `lib/node-positions.ts` | 坐标记忆：引擎回包不覆盖用户摆位、按脚本目录存 localStorage |
| （官方）`MiniMap` / `Controls` | 右下角小地图 + 缩放/适配视图控件，直接用 xyflow 的 |

规则：

- **所有**引擎回包都必须走 `graph.store` 的 `placed(...)`（内部 `toGraphData` + 坐标套回）。
  单独调 `toGraphData` 再塞进 store，等于把用户的摆位冲掉 —— 以前有 8 处这么干，
  表现就是"拖动/建节点之后节点弹回网格（看起来像消失）"。
- 节点状态用**官方 `useNodesState`**，不要再自造"拖动表/尺寸表"：官方 `applyNodeChanges`
  会处理 position/dimensions/select，`measured` 也由它保管（自己实现容易漏掉尺寸回填，
  然后小地图画不出节点、`nodesInitialized` 反复 false）。
- 同步 store → React Flow 时：**不在拖动中的节点坐标取 store**（"重新布局"才生效）；
  **正在拖动的节点（本地 `dragging === true`）坐标必须取本地** —— 拖动期间每帧的实时更新都会
  触发同步，用 store 的旧坐标覆盖就是"抖动 + 松手回原位"。
  - ⚠️ 重建节点时 `dragging` 标记要**一起带回去**：丢了它，下一次同步就会覆盖正在拖的节点（抖动根源）。
  - ⚠️ 写回坐标读**本地最新坐标**（`nodesRef` 镜像本地数组），别用 `onNodeDragStop` 回调参数里的
    `node.position`：它可能落后一帧，写回旧值 = "停下来弹回原位"。
  - 拖动中每 90ms 节流写一次 store 兜底（画面跟手仍由 React Flow 本地负责），松手把
    React Flow 报上来的**所有**被拖节点一次写全（多选拖动）。
  - **尺寸沿用本地**（别重新测量），`data` 每次重建。
- 连线必须用 `ConnectionMode.Strict`：Loose 允许从 target 圆点起拖并交换方向，
  会出现"从左圆点拖，结果连成了反向边"。
- 菜单项要区分"要做什么"和"怎么做"：一级动作类型、二级参数（`action-menu.ts`）。
  每类最后留一项「自定义…」指向详情面板，别把参数全塞进一级。
- 节点卡片里**可点元素 ≥24px**（`size-5` / `h-6`）；小字号标签可以小，按钮不能小。
- 弹菜单/浮层一律 **portal 到 `document.body`**：节点卡片在 React Flow 的
  `scale()/translate()` 变换里，卡片内 `position: fixed` 会被变换劫持（菜单飞到视口外、点不到）。
- 节点里的操作：点行 = 选中那一步；`▶` = `action.run` 立即执行（结果进事件流）；`✕` = 删除。
  加操作走 `graph.store.addStep`（一次 RPC 带上 action，别"先建后改"）。
- 运行态：`data-run="active|pending"` 驱动 `graph.css` 的呼吸/闪烁；条件边用 `animated`（matched
  或当前界面的 waiting）表示"正在盯这条"；状态条读 `graph.activeNodeId` + 每帧算出的边状态。
- 建节点、加分支之后自动 `fitView` 一次（`centerAll`）：引擎回包会重排、详情坞展开会让画布变矮，
  不居中就很容易"建完看不见"。
