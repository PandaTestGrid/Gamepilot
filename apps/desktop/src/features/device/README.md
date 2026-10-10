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
