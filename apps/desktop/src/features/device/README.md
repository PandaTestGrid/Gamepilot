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
