# features/events — 事件流与时间轴

**职责**：消费引擎事件（`node_entered` / `edge_matched` / `recovery_done` / `transition_failed` …），
做实时展示与回溯。

| 文件 | 职责 |
|---|---|
| `EventFeed.tsx` | 事件列表 + 过滤（全部/仅失败/中断/设备）。**一处实现，多处挂载**：底部抽屉的「事件流」Tab、独立窗口 `?pane=events` |
| `TimelinePane.tsx` | 时间轴（M4 接真实帧环形缓冲前的占位：当前帧/tick/节点/fps/截图耗时） |

计划内容（M4）：
- 帧环形缓冲 + 可拖滑块：拖动时画面栏切到历史帧（**只读，不影响设备**）
- 事件 → 跳帧联动（点一条失败事件跳到那一帧的画面）

规则：

- 事件类型名由引擎定义（`engine/src/gamepilot/protocol.py`），前端不得自造。
- 事件按 `seq` 单调递增处理；发现跳号要显示告警（说明前端丢帧/引擎重启）。
