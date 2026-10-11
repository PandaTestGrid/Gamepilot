# 冻结契约 v4：工作区（= 项目）› 工作流

> **v4 覆盖 v1/v2/v3 的层级与命名 —— 中间那层「项目」取消。**
> 用户原话：「我更正一点：**工作区就是项目，项目也是工作区**，工作区里面添加的是**工作流**，
> 工作添加要输入名字不是直接添加。」
> 拍板：**不要默认工作流（完全空着开始）**。
>
> **v5 修订（用户 2026-10 原话）**：
> 「我理解这东西应该很简单……工作区支持电脑拖进来一个文件夹，就是个工作区，
>  **就像 deepseek 侧边栏一样，在工作区下面添加一个会话一样**」；
> 「工作区的目录后面不是跟的添加按钮，竟然是个打开 —— 这是谁给你的需求？」；
> 「选择工作区就是调用一个系统文件夹」。
> 于是 v4 的三条被推翻：
> 1. **添加工作区是一步**：挑中文件夹 → 直接 `workspace.add`（显示名默认取文件夹名，之后可改）——
>    v4 的"第二步输名字"和"不许选完就默默加进去"作废；
> 2. **+ 从 Finder 拖一个文件夹进来 = 同一个动作**（webview 拖拽事件给真实路径）；
> 3. **点工作区名字 = 切过去**（v4 的「打开」按钮删除）；**行尾的 ＋ = 在这个工作区里新建会话 = 一张状态图**。
>    ＋ **先弹输入框让你起名**，提交了才建（这一条 v4 本来就是对的：
>    期间试过"点一下自动命名『新会话』"，用户当场否掉 —— "一点后让用户输入名字不行么"）。
> 这份文件是唯一事实来源；v1–v3 里没被 v4 改到的（单一 `.trash` 语义、可恢复删除、禁止 `window.prompt`、
> 配置持久化、没有当前脚本是一等状态）继续有效。

## 0. 层级与词汇（最终版）

```
工作区（= 项目，同一个东西；用户选的一个文件夹，可以有多个）
└── 工作流（= 一张状态图 = graph.json + templates/，可以有多个）
```

- **不再有「项目」这一层**：UI、RPC、磁盘、文档里都不要再出现"项目"当层级名。
- **不再有「脚本/任务/状态图」当层级名**，统一叫 **工作流**（内部类型名用 `workflow`）。
  （画布上仍然是状态图，那是图形本身的叫法，不是目录层级。）
- 工作区可以在列表里有多个；同一个工作区里可以有很多工作流。

## 1. 磁盘与配置

```
<用户选的文件夹>/                 ← 工作区根
├── .trash/                      ← 这个工作区里删掉的工作流（可恢复）
├── 斗技/                         ← 工作流 = 一张流程图
│   ├── graph.json
│   └── templates/
└── 御魂/
    └── ...
```

- **接入一个空文件夹时什么都不建**（连「默认项目」也不建了）。完全空着，等用户「＋工作流」。
- 工作流 = 含 `graph.json` 的**直接子目录**；隐藏目录（`.` 开头，含 `.trash`）不算工作流。
- 配置持久化不变（v3 §1）：`config.json` 里 `{ active, workspaces }`，按最近使用排序，
  `GAMEPILOT_CONFIG_DIR` 换配置目录，`GAMEPILOT_WORKSPACE_DIR` 覆盖 active 且跳过配置读写。
  **v4 追加 `names`**（工作区显示名要活过重启，而空文件夹里不能放任何文件）：

  ```json
  {
    "active": "/Users/me/Documents/game-a",
    "workspaces": ["/Users/me/Documents/game-a", "/Users/me/Documents/game-b"],
    "names": { "/Users/me/Documents/game-a": "我的工作区" }
  }
  ```

  `names` 缺失/没有对应项 → 退化成 `basename(root)`；老配置（没有 `names`）必须能正常加载。
  `workspaces` 仍是**绝对路径数组**（顺序 = 最近使用），不是对象数组。
- 全局回收站仍是 `<配置目录>/.trash/`（删整个工作区时才用）。

## 2. RPC 契约

### 2.1 工作区层

| 方法 | 参数 | 返回 |
|---|---|---|
| `workspace.list` | `{}` | `{ active, recommended, trashRoot, items: [{ name, root, active, exists }] }` |
| `workspace.add` | `{ dir, name?, create? }` | `{ root, name, tree, current, items, trashRoot }` |
| `workspace.remove` | `{ dir, deleteFiles? }` | `{ active, items, tree, current, trashed, trashRoot }` |
| `workspace.tree` | `{}` | `{ root, workflows: [{ name, root, nodes, edges, recognizers, templates, modified }] }` |

- **`workspace.add` 新增 `name?`**：用户在界面上输的名字。省略/空白时退化成 `basename(dir)`。
  - `name` 只是**列表里显示的名字**，不要求等于目录名（目录名不能被随便改）；重名时在列表里允许，
    但 `workspace.remove` 用 `dir` 定位，所以不会歧义。
  - 同一个 `dir` 再加一次 = 幂等：把它提到最前、设为当前，**名字更新成这次传的**（用户可能是来改名的）。
  - `create` 默认 `true`（目录不存在就建）；`create: false` 且不存在 → 报「工作区目录不存在: <路径>」。
  - 只接受绝对路径或 `~` 开头（相对路径报错）。
  - **不建任何目录内容**（空文件夹保持空着）。
- `workspace.remove`：`deleteFiles: true`（默认）→ 整个目录移到全局回收站，回 `trashed`；`false` → 只移出列表，
  `trashed` 回空串。移掉当前 → 切列表里下一个还存在的；列表空了 → `active: null`。
- `trashRoot` / `recommended` 同 v3。

### 2.2 工作流层（**由 `script.*` 改名而来**）

| 方法 | 参数 | 返回 |
|---|---|---|
| `workflow.create` | `{ name }` | `{ created, current, items }` |
| `workflow.rename` | `{ dir, name }` | `{ root, current, items }` |
| `workflow.duplicate` | `{ dir, name? }` | `{ created, current, items }` |
| `workflow.delete` | `{ dir }` | `{ trashed, current, items }` |

- **`name` 必填**（`workflow.create`）：界面会弹输入框；省略时报「缺少参数 name」。
  `duplicate` 的 `name` 可省（自动「<原名>-副本」）。
- 工作流建在**当前工作区根**下：`<工作区根>/<名字>/`。没有当前工作区 → 报「请先选择工作区」。
- `create` / `duplicate` 建完**切过去**（`current` = 新 root）。
- `items` = 当前工作区里的工作流列表（`{name, root, nodes, edges, recognizers, templates, modified}`）。
- `delete` 删的是当前工作流 → 切到剩下的第一个；一个都不剩 → 保持"没有当前工作流"。
- 名字规则沿用 `library.validate_name`（1~64、禁 `/ \ : * ? " < > |`、不以 `.` 开头结尾），中文报错。

**下线的**：`project.list` / `project.create` / `project.rename` / `project.delete` 全部删除
（那一层没了）；`project.get` / `project.set` **保留**（当前工作流的读取/切换，语义不变）。

### 2.3 工作流摘要字段

```json
{ "name": "斗技", "root": "/abs/path", "nodes": 3, "edges": 2,
  "recognizers": 4, "templates": 5, "modified": 1760000000 }
```

`modified` = `max(graph.json mtime, 工作流目录 mtime)` 的 epoch 秒（面板显示「10 分钟」用）。

### 2.4 「没有当前工作流」仍是一等状态

`project.get` → `{ root: "", graphPath: "", nodes: 0, edges: 0, recognizers: 0, templates: 0 }`；
写盘类调用报中文「还没有选择工作流」；界面在图区显示空图、右栏显示 §3.1 那个区域，不报错。

## 3. 前端 UI 契约

### 3.1 右栏「工作区」区域（`features/library/WorkspacePanel.tsx`）

**这个区域就是右栏第一个 Tab 的全部内容 —— 不是浮层、不是弹框、没有"打开/关闭"。**
（历史坑：曾经这里是「树 + 一个浮层面板」两份东西在列同一批目录，用户看到两份真相；
树已删除，只有这一套列表。）

```
工作区                        🔍  ⚙  ＋        ← 区域自己的头；＋ = 添加工作区（⌘O）
📁 阴阳师                       ──            ← 工作区行：普通行（不高亮、不变蓝），点名字 = 切过去
   · 斗技                24 分钟              ← 工作流行：圆点 + 名字 + 右对齐相对时间
   • 是的发生地发        24 分钟              ← 当前那条：圆点蓝色实心 + 整行低对比浅底
📁 默认                                        ← 没有"底部固定项"了（那会和列表里的目录重复成两个"默认"）
```

- **顺序 = 登记顺序**：切换工作区**不会**把它挪到列表最上面（用户明确要求）；新加的工作区追加在末尾。
- **工作区行**：箭头（`aria-expanded`）管展开/收起；**点名字 = 切到这个工作区**
  （已经在这个工作区里 → 点名字就是展开/收起，和 IDE 一样）；折叠时右边显示「N 个工作流」；
  行尾悬停出 **＋**（在这个工作区里新建会话）。
- 头部的添加入口是**看得见的文字按钮**「＋ 添加」（只放一个 ＋ 图标时用户找不到）。

- 工作流行悬停出「改 / 复 / 删」三个小图标（内联表单 + 行内二次确认）；点名字 = 切过去。
- **有工作区但一个工作流都没有**时，区域里直接给「＋ 新建会话（= 一张状态图）」——
  这就是契约 §3.3 空态的唯一落点（原 `WelcomeCard` 已删除，避免两处入口）。
- `＋` 新建会话**先弹输入框**（`WorkflowNameForm`，自动聚焦）：名字是你自己认这张图的方式；
  提交才 `workflow.create { name }`，取消就什么都不建。引擎侧**名字必填**，不会替你起名。
- 仍然**绝对不许 `window.prompt`**。

### 3.2 工作区面板（`features/library/WorkspacePanel.tsx`）

```
┌────────────────────────────────────────────────┐
│ 工作区                    🔍  ⚙  [＋ 添加]      │  ← 添加是**文字按钮**（只放图标时用户找不到）
├────────────────────────────────────────────────┤
│ ▾ 📁 my-game-bot                            ＋ │  ← 点名字 = 切过去；悬停的 ＋ = 新建会话（弹框起名）
│      • 斗技                        刚刚        │  ← 会话（= 一张状态图）：圆点 + 名字 + 相对时间
│      · 御魂                      10 分钟       │
│ ▸ 📁 game-b                2 个工作流       ＋ │  ← 非当前：折叠着；悬停出 ＋
└────────────────────────────────────────────────┘
```

- **＋ / ⌘O / 拖拽（添加工作区）都是一步**：挑中文件夹 → 直接 `workspace.add`
  （`open({directory:true})` 动态 import + try/catch；拿不到原生对话框就退回**手输绝对路径**输入框，
  并在日志里记一行说明为什么退化）。显示名默认取文件夹名（引擎行为），之后随时可改。
- **从 Finder 拖一个文件夹进侧栏** = 同一个动作（`getCurrentWebview().onDragDropEvent` 给真实路径；
  一次拖多个就逐个登记，最后一个成为当前）。拖动中侧栏顶部显示「松手就把它添加为工作区」。
- 点工作区名字 → `workspace.add { dir, name }`（幂等，沿用已知名字）→ 列表刷新、当前会话跟着换。
- 搜索：按名字过滤工作区 + 工作流。
- 设置（⚙）：移除当前工作区两个选项（移到回收站 / 只从列表移除），**行内二次确认**，
  文案要显示 `trashRoot` 实际路径，**禁止"永久删除"**。
- `exists: false` 的工作区灰掉 + 标「目录不存在」+ 提供「从列表移除」。
- **一个工作区都没有**时：区域里一个主按钮「＋ 添加工作区」。（以前还有个「用默认工作区」次按钮，已删）

### 3.3 空状态（**唯一入口，别再做第二处**）

条件：**有当前工作区** 且 **一个工作流都没有**。

- 落点在 §3.1 那个区域里：一句「这个工作区还没有工作流」+ 一个「＋ 新建工作流（输名字）」按钮，
  点开 `WorkflowNameForm`，输名字才建。
- 独立的 `WelcomeCard.tsx` **已删除**（区域里已经有出路了，两处入口就是两份真相）。
- 一个工作区都没有时：区域里是「＋ 添加工作区」主按钮（没有「默认工作区」那个次入口了）。

### 3.4 顶部目录菜单（`layout/ProjectMenu.tsx`）

保留路径输入 + 「切换到此目录」+ 当前工作区的工作流列表；新建工作流走内联表单。

## 4. 验收标准

1. `cd engine && .venv/bin/python -m pytest -q` 全过，**≥ 268**（v3 结束时 268）；ruff / mypy(strict) 干净。
2. `cd apps/desktop && node_modules/.bin/vitest run` 全过，**≥ 376**；`tsc --noEmit`、`eslint .` 干净。
3. `apps/`、`engine/src/` 里搜下面这些**零命中**：
   `script\.(create|rename|delete|duplicate)`、`project\.(list|create|rename|delete)`、
   `默认项目`、`默认工作流`、`默认脚本`、`＋工作区`、`window\.prompt`。
4. **端到端可重复跑**（真实引擎子进程 + 临时目录 + 隔离配置目录）：
   - 空配置 → `active: null`、`items: []`
   - `workspace.add` 一个**空临时目录** + 名字「我的工作区」→ 磁盘上**一个文件都没有**
     （不许出现 `默认项目/`、不许有 `graph.json`），列表里名字是「我的工作区」而不是目录名
   - 同目录再 add 一次 + 新名字 → 幂等且名字被更新
   - `workflow.create { name: "斗技" }` → `<工作区>/斗技/graph.json` 出现并切过去
   - 再来一个 + 切换 + 改名 + 复制 + 删（校验 `.trash/`）
   - `workspace.remove { deleteFiles: true }` → 目录进全局回收站
   - **重启进程** → 列表、名字、active、当前工作流都记得
   - 删掉最后一个工作流 → `project.get` 的 `root` 是空串，不崩
5. 界面文案里不再出现"项目"当层级名（`README.md`、`docs/rpc.md` 同步）。
