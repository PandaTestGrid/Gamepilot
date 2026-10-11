/**
 * 事件栏：事件流 + 时间轴（DESIGN.md §4.2 D/E）。
 *
 * 事件按设备分桶，切换设备标签时自动跟着切；类型用语义色，失败类高亮。
 * 录制产生的 +recognizer / +node / +edge 事件也会出现在这里（可回看每一步）。
 */
import { type ReactNode, useMemo } from 'react';

import { GhostButton, PanelShell, StatusDot, type DotTone } from '@/layout/PanelShell';
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

export function EventPane(): ReactNode {
  const activeId = useDeviceStore((state) => state.activeId);
  const events = useEventStore((state) => state.events[activeId]);
  const filter = useEventStore((state) => state.filter);
  const setFilter = useEventStore((state) => state.setFilter);

  const rows = useMemo(() => (events ?? []).filter((event) => matchFilter(event, filter)), [events, filter]);

  return (
    <PanelShell
      title="事件"
      // 高度由父级纵向 Group 决定（右栏可上下拖），面板自己撑满即可
      className="h-full"
      actions={
        <>
          {FILTERS.map((item) => (
            <GhostButton key={item.id} active={filter === item.id} onClick={() => setFilter(item.id)}>
              {item.label}
            </GhostButton>
          ))}
        </>
      }
      footer={<Timeline total={rows.length} />}
    >
      <div className="h-full overflow-auto">
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
    </PanelShell>
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

function Timeline({ total }: { total: number }): ReactNode {
  // M4 接入真实时间轴：环形缓冲最近 60s 的帧，拖动时画面栏切到历史帧（只读）
  return (
    <div className="shrink-0 border-t border-line px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-badge text-faint">时间轴</span>
        <div className="relative h-1 flex-1 bg-raised">
          <span className="absolute top-[-3px] left-[38%] size-2 rounded-full bg-brand" />
          <span className="absolute inset-y-0 left-0 w-[38%] bg-brand/40" />
        </div>
        <span className="text-badge text-faint">{total} 条 · 60s</span>
      </div>
    </div>
  );
}
