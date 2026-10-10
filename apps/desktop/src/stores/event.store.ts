/**
 * 事件 store：按设备分桶保存事件流。
 *
 * 关键约定（CONVENTIONS §4.5）：`seq` 单调递增，前端发现跳号要告警
 * ——那说明丢帧或引擎重启。
 */
import { create } from 'zustand';

import { mockEvents } from '@/mock/seed';
import type { TraceEventType, TraceEventView } from '@/types';

export type EventFilter = 'all' | 'failed' | 'recovery' | 'device';

interface EventState {
  readonly events: Readonly<Record<string, readonly TraceEventView[]>>;
  readonly filter: EventFilter;
  readonly seq: number;
  readonly ensure: (deviceId: string) => void;
  readonly append: (
    deviceId: string,
    type: TraceEventType,
    detail?: { node?: string | null; edge?: string | null; message?: string },
  ) => void;
  readonly setFilter: (filter: EventFilter) => void;
}

export function matchFilter(event: TraceEventView, filter: EventFilter): boolean {
  switch (filter) {
    case 'failed':
      return event.type.includes('failed') || event.type === 'error' || event.type === 'device_lost';
    case 'recovery':
      return event.type.startsWith('recovery');
    case 'device':
      return event.type.startsWith('device');
    default:
      return true;
  }
}

export const useEventStore = create<EventState>()((set, get) => ({
  events: {},
  filter: 'all',
  seq: 0,

  ensure: (deviceId) =>
    set((state) => {
      if (state.events[deviceId]) {
        return state;
      }
      const seeded = mockEvents(deviceId);
      return {
        events: { ...state.events, [deviceId]: seeded },
        seq: Math.max(
          state.seq,
          seeded.reduce((max, item) => Math.max(max, item.seq), 0),
        ),
      };
    }),

  append: (deviceId, type, detail) => {
    const seq = get().seq + 1;
    const event: TraceEventView = {
      seq,
      ts: Date.now() / 1000,
      type,
      deviceId,
      node: detail?.node ?? null,
      edge: detail?.edge ?? null,
      message: detail?.message ?? '',
    };
    set((state) => ({
      seq,
      events: { ...state.events, [deviceId]: [...(state.events[deviceId] ?? []), event].slice(-500) },
    }));
  },

  setFilter: (filter) => set({ filter }),
}));
