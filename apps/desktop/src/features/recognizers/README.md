# features/recognizers — 识别器面板

**职责**：录制产出的识别器素材管理、实时分数查看、阈值现场调参。

计划内容（M2）：
- `RecognizerList.tsx` — 缩略图墙：模板图、类型徽标（模板/颜色/OCR）、实时分数条
- `ThresholdSlider.tsx` — 拖动时通过引擎重算当前帧匹配分数，画面框同步变化；松手写回 `graph.json`
- `useRecognizerScores.ts` — 从 `engine.frame`/`engine.event` 通知里取出每帧分数

规则：
- 阈值语义统一：`0.0 ~ 1.0` 的 float，越大越严格；默认模板 0.82、颜色不看阈值看覆盖度。
- 模板文件命名 = 识别器 label（`main_start.png`），由录制动作保证，不手工改名。
