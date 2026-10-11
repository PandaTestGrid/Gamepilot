# features/library — 脚本库（多状态图）

**职责**：管理"这个项目里有哪些状态图"，一张图 = 一个脚本目录（`graph.json` + `templates/`）。

| 文件 | 职责 |
|---|---|
| `ScriptLibraryPane.tsx` | 面板：列表 + 新建/刷新 + 当前脚本回显（右栏第一个 Tab 的内容） |
| `ScriptRow.tsx` | 单行：名称 / 界面·步数·识别器数 / 当前标记 / 悬停操作（复制·重命名·移除） |
| `ScriptNameForm.tsx` | 内联命名表单（新建与重命名共用；不用 `window.prompt`，Tauri 里它是禁的） |
| `script-name.ts` | 名称规则纯函数（与引擎 `library.validate_name` 同一套，**必须单测**） |

规则：

- **引擎是唯一真源**：列表来自 `project.list`，每次增删改都用引擎返回的整份列表刷新，
  面板不做本地乐观更新（避免界面与磁盘不一致）。
- 切换脚本走 `session.store.switchProject`（会热重载所有已连接设备的状态图并保留运行态），
  这里不重复实现。
- 删除是**移到库根 `.trash/`**，所以文案写「移除」并标注可恢复。
