/**
 * 事件流（列表 + 过滤）：**一处实现，多处挂载**（底部调试抽屉的「事件流」Tab）。
 *
 * 事件按设备分桶，切设备标签自动跟着切；类型用语义色，失败类高亮。
 * 录制产生的 +recognizer / +node / +edge 事件也会出现在这里（可回看每一步）。
 */
import { type ReactNode, useMemo } from 'react';

import { GhostButton, StatusDot, type DotTone } from '@/layout/PanelShell';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { matchFilter, useEventStore, type EventFilter } from '@/stores/event.store';
import type { TraceEventType } from '@/types';

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
  node_added: 'confirmed',
  edge_added: 'confirmed',
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
          <div
            key={`${event.deviceId}-${event.seq}`}
            className="flex h-[26px] items-center gap-2 px-2 hover:bg-raised"
          >
            <span className="w-16 shrink-0 text-badge text-faint">
              {new Date(event.ts * 1000).toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
            <StatusDot tone={TONE[event.type] ?? 'idle'} />
            <span className={cn('w-32 shrink-0 truncate text-body', toneClass(event.type))}>
              {event.type}
            </span>
            <span className="min-w-0 flex-1 truncate text-badge text-dim">{event.message}</span>
            {event.node && <span className="text-badge text-faint">{event.node}</span>}
          </div>
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
