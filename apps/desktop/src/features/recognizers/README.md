# features/recognizers — 识别器面板

**职责**：录制产出的识别器素材管理、实时分数查看、阈值现场调参。

计划内容（M2）：
- `RecognizerList.tsx` — 缩略图墙：模板图、类型徽标（模板/颜色/OCR）、实时分数条
- `ThresholdSlider.tsx` — 拖动时通过引擎重算当前帧匹配分数，画面框同步变化；松手写回 `graph.json`
- `useRecognizerScores.ts` — 从 `engine.frame`/`engine.event` 通知里取出每帧分数

规则：
- 阈值语义统一：`0.0 ~ 1.0` 的 float，越大越严格；默认模板 0.82、颜色不看阈值看覆盖度。
- 搜索范围：`region`（默认，只在 `roi` 里找）/ `full`（整帧找）。只有模板识别器可切；
  颜色识别固定按原区域。全屏命中后 `Detection.rect` 是目标当前位置，点击跟着它走。
  这里改的是**模板默认**；步骤链的点击/等待/条件可以在步骤里覆盖（`StepSearchScope`）。
- 模板文件命名 = **录制时**的识别器名（`main_start.png`）；**改名不会改文件名**，
  对应关系看 `graph.json` 的 `recognizers[标签].template`。

## 删除识别器（为什么在这里）

**这里是唯一的删除入口**：`RecognizerPane.tsx` 每行末尾的「删」。

- 画面栏的「识别读数」是**实时监控**（分数每帧在跳），销毁性操作摆在跳动的东西旁边误点代价太大。
  这一列有缩略图 + 阈值 + "被谁引用"，是"看清代价再删"的地方
  （删除前须检查引用）；
- **被引用时按钮置灰**，并在同一行写出原因：
  `正在被引用：新界面（node_1）、界面1（n_1）、e_ai（判断条件 + 动作目标）`。
  这是 `lib/recognizer-usage.ts`（纯函数，有单测）算出来的，规则和引擎
  `session.py: remove_recognizer` 一一对应 —— **别让它俩漂移**，
  否则会出现"界面说能删、引擎说不能删"；
- 节点在提示里必须带 id：脚本里两个节点都叫「新界面」时（只差 id），光写名字等于没说；
- 置灰只是**预判**，引擎仍是权威（动作里的 `$score` 引用界面模型看不到）：
  真删失败时原因照样进错误条 + 事件栏；
- 走 `session.store.removeRecognizer` → `recognizer.remove`：spec 与 `templates/<名字>.png` 一起删，
  返回的新图直接 `applyGraph` 换掉本地图；事件栏留一条 `recognizer_removed`。
