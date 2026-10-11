# features/device — 画面栏

**职责**：设备连接与投屏的 UI 与状态；**不承担识别逻辑**。

计划内容（M1~M2）：
- `DevicePanel.tsx` — 画面容器、letterbox 缩放、十字准星与归一化坐标读数
- `useDeviceStream.ts` — 订阅引擎推送的 `engine.frame` 通知（JPEG），维护最近一帧
- `OverlayCanvas.tsx` — 识别框叠加（已确认 / 待投票 / 失败残影三态）
- `RecordingMarquee.tsx` — 框选/点选录制，产出归一化 `Rect` 交给 `features/recognizers`

规则：
- 组件内**禁止**出现像素坐标：所有矩形都是 `[0,1]` 归一化，转像素只在引擎侧。
- 画面渲染不直接调用引擎：一律经 `src/lib/rpc.ts`。
- 不在本目录里写死颜色：三态语义色走 `index.css` 的 theme token（DESIGN.md §4.5）。

## 画面下方的设备控制条

`DeviceControls.tsx` —— 贴在投屏下面那条 28px 横条：`控制` 开关 · `返回 / 桌面 / 最近任务 / 电源` · `录操作`
（开着时多出 `+等0.5s/1s/3s`），右侧一行状态提示。

规则：

- 它属于 **`SCREEN_LAYOUT` 的 `view` 面板**（画面那一格）：拖高"识别读数"时控制条不会被推走；
- **不要把这些键放回面板头**：面板头只留面板自己的工具（框选 / 点选 / 多开 / 读数），
  否则面板一窄就换行成两排，最常用的返回键被挤到第二行（真踩过）；
- 设备没连上（`session.store.ready[deviceId]` 为假）时按钮变灰，并在 `title` 里说明原因；
- 状态全在 store（`ui.store.controlMode` / `recordActionMode`、`session.store.pressKey` / `recordStep`），
  组件自身不持有状态，换设备不会串。

## 画面上的「录操作」辅助

`ScreenPane.tsx` 的 `SingleScreen` —— 只有**录操作**（`ui.store.recordActionMode`）开着时才在画面上画东西，
而且画什么必须和手势语义一致（判定在 `touch-gesture.ts`）：

| 场景 | 画什么 |
|---|---|
| 正常控制：轻触 / 滑动 | **一个辅助都不画**（投屏要保持干净）。手势照常发给设备 |
| 录操作·轻触 | 落点上**中心点 + 扩散环**（`animate-touch-ping`），抬手在同一位置再播一次 = "这一下录进去了"；整枚标记由 `animate-touch-fade` 收尾淡出 |
| 录操作·滑动 | **起点实心点 →（虚线）→ 终点空心圈 + 方向箭头**，拖动中落点实时更新 = "这一段会被录成 swipe" |

规则：

- **辅助是「录操作」专属**（`recordActionMode` 为假时连轻触标记都不画）。
  别改成"总是画"或"正常控制也留个点"：投屏上多出来的东西用户一眼就嫌脏（真被要求删过两轮）；
- **两种形态互斥**（`TouchFeedback` 是联合类型，同一时刻只有一个）：
  曾经按下画一个、抬手在终点再画一个 —— 滑动就成了**两个分开的点击**，
  用户看到的是"我点歪了两下"（真踩过）。滑动抬手**绝不补点击标记**；
- 每个形状都带**暗色垫层**（`stroke-canvas` / `fill-canvas`）：投屏可能是白底亮画面，
  只画品牌蓝会糊在内容里；箭头的"方向"是滑动区别于点击的关键，别省；
- 轻触 / 滑动用**同一个阈值** `SWIPE_MIN_DISTANCE`，而且**按合位移判**，不按"有没有 move 事件"
  （轻触时手抖 1px 也会发 move）：否则会出现"画面上看着是点击、录下来却是滑动"；
- 辅助点用 `canvasPointToPixels` 按**实际画面区域**换算，不能用容器百分比 ——
  竖屏画面在横容器里有黑边，百分比画出来的点会飘到黑边上；
- 手势判定是**纯逻辑**，改动先看 `touch-gesture.test.ts` 与 `ScreenPane.test.tsx`
  （后者专门守"正常控制不画辅助"和"滑动抬手不补点击标记"这两条）。

## 设备弹层（分类与交互）

| 文件 | 职责 |
|---|---|
| `DevicePopover.tsx` | 弹层外壳：搜索、分类 Tab、列表、Footer（刷新/高级），↑↓/Enter/Esc 键盘流转 |
| `device-kinds.ts` | **纯逻辑**：分类 / 过滤 / 排序 / 搜索（`buildDeviceTabs` / `filterByTab` / `sortForDisplay` / `resolveTab`），有单测 |
| `DeviceRow.tsx` | 一行设备：当前 / 已连接 / 未连接 / 失败 四种交互各不相同 |
| `MacWindowList.tsx` | 「本机窗口」Tab 的内容：枚举窗口 + 搜索 + 刷新 + 权限提示 + 已连标记 |

规则：

- **只显示有内容的分类**（空 Tab 会让人以为"设备不见了"）；分类计数来自实际设备列表。
- macOS 在引擎里是**一个伪设备（`macos:picker`）+ 一串窗口**两条数据路径：
  伪设备**不是可连设备**，只用来在 Tab 上有入口；真正要连的是 `macos:<句柄>`。
- 点击语义按状态分：当前设备 = 无动作；已连接 = **切换**；未连接 = 连接；行尾按钮才是断开。
- `DeviceKind` 白名单在 `stores/device.store.ts` 里是**穷举 Record**：新增来源漏一行就编译不过
  （曾经漏了 `ios`，所有 iPhone 被降级成 `remote`，分类里看不到）。
