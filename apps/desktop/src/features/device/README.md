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

## 画面下方的设备控制条（只有导航键，居中）

`DeviceControls.tsx` —— 贴在投屏下面那条 28px 横条：**导航键居中**，右侧一行状态提示。
按键随平台变（`nav-keys.ts`，纯函数 + 单测）：

| 设备 | 投屏下面（导航键，居中） | 面板头（电源） |
|---|---|---|
| Android / 模拟器 | 返回 · 桌面 · 最近任务 | 电源 |
| iOS | 只有 主页 | 电源（侧边按钮） |
| macOS 本机窗口（kind=`windows`） | **一个都没有**（并说明"没有实体导航键"） | **没有**（`MAC_KEYS` 里没有 power） |
| mock / 未知来源 | 返回 · 桌面 · 最近任务 | 电源 |

- iOS 那一格只有 `主页` 不是省事：引擎 `devices/ios.py: NAMED_BUTTONS` 把 `back`/`recents`
  **都映射成 Home**，界面照搬 Android 的话，用户按「返回」其实按的是 Home；
- **居中是三栏网格**（`grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]`）：左 1fr · 按键 · 右 1fr 放提示，
  两侧等宽所以按键是真居中 —— 用 `flex + justify-center` 会被右边那句提示顶偏；
- 它属于 **`SCREEN_LAYOUT` 的 `view` 面板**（画面那一格）：拖高"识别读数"时不会被推走；
- 设备没连上时按键变灰，`title` 里说明原因；状态全在 store（`session.store.pressKey`）。

## 面板头：两个模式开关 + 电源

在 `ScreenPane.tsx` 的 `PanelShell actions` 里（画面栏标题那一行）：

- `控制`：开/关画面上的鼠标操作（`ui.store.controlMode`）；
- `录操作`：把点击/滑动录成脚本步骤（`ui.store.recordActionMode`），设备没连上时**置灰并说明原因**；
  开着时它旁边多出 `+等0.5s/1s/3s`（录一步等待属于"录操作"这件事，跟着它走）；
- `电源`：不是导航键，所以不占投屏下面那条；`powerKeyFor(kind)` 为 null 的设备（macOS 本机窗口）
  干脆不显示 —— 而不是摆一个点了必报错的按钮；
- 面板头是 `flex-wrap` + `min-h-7` 的：窄了会换行变高，不会把按钮压成竖排文字
  （由来见 `layout/PanelShell.tsx` 顶部注释）。

规则：**App 自己的开关 + 非导航的设备功能键放上面，导航键留下面对齐手机**。
分界的理由只有一条：让人一眼看出"哪些是 App 的、哪些是手机上的"。

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

## 底部「识别读数」（筛选 / 改名 / 收起）

`ScreenPane.tsx` 的 `RecognizerReadout` —— 画面栏下半格那串识别器读数：

- **全部 / 命中 切换**：`命中 = state !== 'idle'`（待确认 + 稳定）。识别器一多，
  "这一帧谁在命中"才是要看的信息；两个按钮上都带计数，不用切过去数。
  选择存 `ui.store.readoutFilter`（换设备、面板重挂之后还在），默认 `all`（和以前一样）。
  筛完一条不剩时给**空态文案指路**（"切到「全部」看全部 N 个"），不是一片空白。
- **行内改名**：双击名字 → 输入框（内容全选）→ `Enter` 保存 / `Esc` 取消 / 点别处也算保存。
- **整区收起**：点标题（`识别读数`）收起/展开，也可以把上面的横线**拖到底**。
  状态在 `ui.store.readoutOpen`，尺寸由 `Panel` 的 `collapse/expand` 执行
  （和底部调试抽屉同一套做法）。收起后只留 26px 标题行，并显示"命中 N"作为唯一读数；
  **不能收到 0** —— 分隔线贴到面板底边就抓不住了（CONVENTIONS §12.6-6）。
  拖动折叠时 `Panel` 的 `onResize` 会把状态回写 store，否则标题上的箭头会和真实状态相反。

**这一列没有删除，也别加回去**：它是实时监控（分数每帧在跳），而删除是销毁性操作；
被引用时还会被引擎拒绝。摆在这里的结果就是"点一下吃一个报错"（真踩过）。
删除在 `features/recognizers/RecognizerPane.tsx`（右栏「识别器」Tab）—— 那里能同时看到
缩略图、阈值和"被谁引用"，被引用时按钮直接置灰。

规则：

- 提交改名只走 **blur 一条路**（`Enter` = 主动失焦）：两条路各提交一次会把同一个改名发两遍，
  第二遍必然报"识别器不存在"。输入框卸载时浏览器补的那个 blur 用 `finished` ref 挡掉。
- 校验：`features/recognizers/recognizer-name.ts` 是**纯逻辑**，规则和引擎的
  `core/graph.py: validate_recognizer_label` 一一对应（非空 / ≤48 / 不带 `/` `\` 与控制字符 /
  不用保留名 `always` / 不重名）。前端拦一道只是为了"即时反馈"，而且**校验不过不关输入框**
  （原因写在行里接着改）；**引擎才是权威**。
- 改名走 store 动作 `renameRecognizer`，引擎返回整张新图 → `applyGraph` 直接换掉本地图，
  **不要自己拼**（引用会被级联改过）；事件栏留一条 `recognizer_renamed`。

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
