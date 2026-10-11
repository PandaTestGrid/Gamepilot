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

## 画布手势：全用官方默认（不要再自己发明）

这条是**教训**，不是设计。前几版把左键改成框选、平移挪到右键/中键，还补了一套外壳光标
（`.canvas-panning`）。结果：多选与拖动互相打架（拖一个动了别的）、选中计数乱跳、
画布时不时报渲染错。根因都是"自己维护一份选中/手势状态，再和 xyflow 的内部状态对齐"。
现在的规矩：**手势一条都不改，选中态只有 xyflow 一个真源。**

| 操作 | 行为（xyflow 默认） |
|---|---|
| 左键拖空白 | **平移画布**（`panOnDrag` 默认 true，光标 grab/grabbing 由 xyflow 给） |
| **Shift + 拖动** | **框选**（`selectionKeyCode` 默认 Shift，`selectionOnDrag` 保持默认 false） |
| **滚动 / 双指滑动** | **缩放**（`zoomOnScroll` 默认 true，捏合也缩放） |
| 中键拖 / **空格+拖动** | 平移（官方内置） |
| **Control + 点节点** | **多选**（`multiSelectionKeyCode={['Control']}`：官方在 mac 上是 Meta，按要求统一成 Control） |
| 点节点 / 点边 | 选中（进下方编辑器） |
| `Delete` / `Backspace` | 删除选中的界面 / 边（macOS 上 Delete 要 Fn+Backspace，所以两个都收） |

规则：

- **`panOnDrag` 不要传数组**：xyflow 的 `Pane.onContextMenu` 里，只要 `panOnDrag` 含 2（右键）
  就 `preventDefault()` 然后 return —— 画布空白处的右键菜单会被整个吞掉。要右键菜单就别把右键给平移；
- **选中态不要自己存一份**：xyflow 通过 `onNodesChange` 的 `select` 变更维护它，
  落在 `rfNodes` 上（`GraphPane` 的 `selectedIds` 是 `useMemo` **读回来**的）。
  自己存一份的两种下场都踩过：
  - 和 xyflow 不同步 → 点了没反应/计数不对；
  - 反过来喂进节点数据（`selected`）→ 回环：`selected` 变 → 重建节点 → 又报选中变化 → 计数乱跳；
    而且 React Flow 的拖动是"把选中的一起拖"，假的选中标记就是**"拖一个、动了别的"**；
- 官方 `onNodesChange`/`onSelectionChange` 交出来的 `nodes` 是**整份节点表**（各带 `selected`），
  不是"被选中的那几个" —— 要的是 `.filter(node => node.selected)`；
- 清选中态也走官方通道：发一串 `{ type: 'select', selected: false }`（`applyNodeChanges`），
  不要自己 `setState`；
- 删界面**逐个调** `graph.node.remove`：引擎会把它连着的边一起删（`session.py: graph_node_remove`），
  所以不用自己先删边；正被下方编辑器编辑的那个被删掉时要 `selectNode(null)` 收起编辑器；
- 画布左下角的图例文案**必须和真实手势一致**（`graph-selection.test.tsx` 里有断言守着）：
  "拖动空白 = 平移画布；Shift+拖动 = 框选；按住 Control 点 = 多选"。

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
| `lib/node-positions.ts` | 坐标记忆：引擎回包不覆盖用户摆位、按**脚本目录**存 localStorage（不按设备） |
| （官方）`MiniMap` / `Controls` | 右下角小地图 + 缩放/适配视图控件，直接用 xyflow 的 |

规则：

- **所有**引擎回包都必须走 `graph.store` 的 `placed(...)`（内部 `toGraphData` + 坐标套回）。
  单独调 `toGraphData` 再塞进 store，等于把用户的摆位冲掉 —— 以前有 8 处这么干，
  表现就是"拖动/建节点之后节点弹回网格（看起来像消失）"。
- 坐标记忆**只按脚本目录**键：图是项目级的（`SCRIPT_SCOPE`），按设备分开记的话，
  同一份脚本在 A 设备摆好、切到 B 设备就套用 B 的旧记忆 —— 用户看到的就是
  "切换设备时流程图布局自己变了"。旧版本按设备存的键只读一次做迁移，不再写。
- 多选**不需要**自己管"换设备要清掉"：选中态归 xyflow，切设备/切脚本时节点表整体重建，
  `selected` 跟着一起重建（见上面「画布手势」那节的规则）。
- 节点状态用**官方 `useNodesState`**，不要再自造"拖动表/尺寸表"：官方 `applyNodeChanges`
  会处理 position/dimensions/select，`measured` 也由它保管（自己实现容易漏掉尺寸回填，
  然后小地图画不出节点、`nodesInitialized` 反复 false）。
- 同步 store → React Flow 时：**不在拖动中的节点坐标取 store**（"重新布局"才生效）；
  **正在拖动的节点（本地 `dragging === true`）坐标必须取本地** —— 拖动期间每帧的实时更新都会
  触发同步，用 store 的旧坐标覆盖就是"抖动 + 松手回原位"。
  - ⚠️ **`dragging` 标记要自己维护**：官方 `applyNodeChanges` 对 `position` 变更**只改 `position`**，
    不写 `dragging`（源码里那个分支只 spread 了 position）。所以只能在 `onNodesChange` 外面包一层
    （`GraphPane` 的 `handleNodesChange`）把 xyflow 发的标记落进本地状态；不维护的话
    "正在拖的节点用本地坐标"这条路永远不生效，画布上的节点每帧都被 store 按回去
    （`graph-drag.test.tsx` 那条"拖动中被实时更新打断"就是守它的）。
    测试桩里**别替官方补写这个标记**，否则这条 bug 永远测不出来。
  - ⚠️ 重建节点时 `dragging` 标记要**一起带回去**：丢了它，下一次同步就会覆盖正在拖的节点（抖动根源）。
  - ⚠️ 写回坐标读**本地最新坐标**（`nodesRef` 镜像本地数组），别用 `onNodeDragStop` 回调参数里的
    `node.position`：它可能落后一帧，写回旧值 = "停下来弹回原位"。
  - 拖动中每 90ms 节流写一次 store 兜底（画面跟手仍由 React Flow 本地负责）。这一笔要把
    **所有 `dragging === true` 的节点**都写回（`nodesRef.current` 里数），不能只写回调里那一个：
    多选拖动时漏写的那个在 store 里还是旧坐标，下一次每帧同步就把**它**按回原位
    （表现："拖着这个，另一个自己跳回去"）。松手再把 React Flow 报上来的所有节点写全。
  - **尺寸沿用本地**（别重新测量），`data` 每次重建。
- 连线必须用 `ConnectionMode.Strict`：Loose 允许从 target 圆点起拖并交换方向，
  会出现"从左圆点拖，结果连成了反向边"。
- 菜单项要区分"要做什么"和"怎么做"：一级动作类型、二级参数（`action-menu.ts`），
  二级还能放**输入行**（`item.input`：相对坐标这类要用户填值的参数，别让人跑去详情面板）。
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
