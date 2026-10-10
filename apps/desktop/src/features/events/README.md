# features/events — 事件流与时间轴

**职责**：消费引擎事件（`node_entered` / `edge_matched` / `recovery_done` / `transition_failed` …），
做实时展示与回溯跳帧。

计划内容（M2~M4）：
- `EventStream.tsx` — 虚拟滚动列表、类型着色、按类型/节点过滤
- `Timeline.tsx` — 最近 60s 帧序列滑块；拖动时画面栏切到历史帧（**只读，不影响设备**）
- `eventStore.ts` — Zustand store：环形缓冲事件、`seq` 去重、跳帧联动
- `eventTone.ts` — 事件类型 → 语义色 的纯映射（**必须单测**）

规则：
- 事件类型名由引擎定义（`engine/src/gamepilot/protocol.py`），前端不得自造。
- 事件按 `seq` 单调递增处理；发现跳号要显示告警（说明前端丢帧/引擎重启）。
