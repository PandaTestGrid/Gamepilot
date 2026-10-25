/**
 * 事件流（列表 + 过滤）：**一处实现，多处挂载**（底部调试抽屉的「事件流」Tab）。
 *
 * 事件按设备分桶，切设备标签自动跟着切；类型用语义色，失败类高亮。
 * 录制产生的 +recognizer / +node / +edge 事件也会出现在这里（可回看每一步）。
 */
import { memo, type ReactNode, useMemo } from 'react';

import { GhostButton, StatusDot, type DotTone } from '@/layout/PanelShell';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { matchFilter, useEventStore, type EventFilter } from '@/stores/event.store';
import type { TraceEventType, TraceEventView } from '@/types';

const eventTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const EventRow = memo(function EventRow({ event }: { event: TraceEventView }): ReactNode {
  return (
    <div className="flex h-[26px] items-center gap-2 px-2 hover:bg-raised">
      <span className="w-16 shrink-0 text-badge text-faint">
        {eventTimeFormatter.format(event.ts * 1000)}
      </span>
      <StatusDot tone={TONE[event.type] ?? 'idle'} />
      <span className={cn('w-32 shrink-0 truncate text-body', toneClass(event.type))}>{event.type}</span>
      <span className="min-w-0 flex-1 truncate text-badge text-dim">{event.message}</span>
      {event.node && <span className="text-badge text-faint">{event.node}</span>}
    </div>
  );
});

const TONE: Partial<Record<TraceEventType, DotTone>> = {
  node_entered: 'confirmed',
  edge_matched: 'confirmed',
  action_executed: 'idle',
  recovery_matched: 'pending',
  recovery_done: 'pending',
  transition_failed: 'failed',
  device_lost: 'failed',
  error: 'failed',
  device_reconnected: 'confirmed',
  recognizer_added: 'confirmed',
  recognizer_renamed: 'confirmed',
  recognizer_removed: 'idle',
  step_started: 'idle',
  step_finished: 'idle',
  step_skipped: 'idle',
  step_failed: 'failed',
  step_retry: 'pending',
  breakpoint_hit: 'pending',
  random_delay: 'idle',
  flow_started: 'confirmed',
  flow_finished: 'confirmed',
  action_failed: 'failed',
};

const FILTERS: Array<{ id: EventFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'failed', label: '仅失败' },
  { id: 'recovery', label: '中断' },
  { id: 'device', label: '设备' },
];

export function EventFeed(): ReactNode {
  const activeId = useDeviceStore((state) => state.activeId);
  const events = useEventStore((state) => state.events[activeId]);
  const filter = useEventStore((state) => state.filter);
  const setFilter = useEventStore((state) => state.setFilter);

  const rows = useMemo(() => (events ?? []).filter((event) => matchFilter(event, filter)), [events, filter]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-6 shrink-0 items-center gap-1 border-b border-line px-2">
        {FILTERS.map((item) => (
          <GhostButton key={item.id} active={filter === item.id} onClick={() => setFilter(item.id)}>
            {item.label}
          </GhostButton>
        ))}
        <span className="flex-1" />
        <span className="text-badge text-faint">{rows.length} 条</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 && <div className="px-3 py-6 text-center text-badge text-faint">没有事件</div>}
        {rows.map((event) => (
          <EventRow
            event={event}
            /*
             * key 里必须带 `type`：seq 是"引擎/界面各自发号"的，会和另一路撞号
             * （界面的 `append` 用本地计数、引擎的 `appendEngineEvent` 用引擎的 seq），
             * 只按 `设备-seq` 做键会撞出 `Encountered two children with the same key`。
             * store 里对 `(seq, type)` 去重，所以这三段拼起来是唯一的。
             */
            key={`${event.deviceId}-${event.seq}-${event.type}`}
          />
        ))}
      </div>
    </div>
  );
}

function toneClass(type: TraceEventType): string {
  if (type.includes('failed') || type === 'error') {
    return 'text-failed';
  }
  if (type.startsWith('recovery')) {
    return 'text-recovery';
  }
  if (type.startsWith('device')) {
    return 'text-pending';
  }
  return 'text-brand';
}
