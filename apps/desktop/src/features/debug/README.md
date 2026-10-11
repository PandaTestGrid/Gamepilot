# features/debug — 底部调试抽屉

**职责**：把"跑起来之后偶尔盯一眼"的信息集中到一处（底部抽屉），别常驻占纵向空间。

| 文件 | 职责 |
|---|---|
| `DebugDrawer.tsx` | 抽屉内容区：按 `ui.store.dockTab` 渲染四个 Tab 之一 |
| `tabs.ts` | Tab 元数据（`DOCK_TABS`）：抽屉与底栏共用一份，加 Tab = 加一行 |
| `LogFeed.tsx` | 日志流：引擎（`engine.log`）+ 界面（devLog）混排、级别过滤、自动滚底 |
| `ConsolePane.tsx` | 控制台：手发一条 RPC 看返回（排查"到底哪一层坏了"） |

四个 Tab：事件流（`features/events/EventFeed.tsx`）、日志、控制台、时间轴（`features/events/TimelinePane.tsx`）。

规则：

- 抽屉的**开关与 Tab** 都记在 `stores/ui.store.ts`（`dockOpen` / `dockTab`），
  展开/收起是命令式的（`Panel` 的 collapse/expand）；收起时**不能收到 0** ——
  0 会让分隔线压在窗口底边、鼠标抓不到（CONVENTIONS §12.6-6）。
- 面板高度可拖，记忆在 `layout/layout-specs.ts` 的 `DOCK_LAYOUT`。
- 控制台只做**只读排查**：写操作都有界面入口（带校验），不在这里开后门。
