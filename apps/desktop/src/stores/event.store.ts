/**
 * 事件 store：按设备分桶保存事件流。
 *
 * 关键约定（CONVENTIONS §4.5）：`seq` 单调递增，前端发现跳号要告警
 * ——那说明丢帧或引擎重启。
 */
import { create } from 'zustand';

import type { TraceEventType, TraceEventView } from '@/types';

export type EventFilter = 'all' | 'failed' | 'recovery' | 'device';

interface EngineEvent {
  deviceId: string;
  seq: number;
  ts: number;
  type: TraceEventType;
  node: string | null;
  edge: string | null;
  message: string;
  extra?: Readonly<Record<string, unknown>>;
}

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
  /** 接入真引擎时清掉该设备的 mock 事件（避免真假事件混在一起） */
  readonly clearDevice: (deviceId: string) => void;
  /** 引擎推来的事件（seq 由引擎维护，前端只做展示与去重） */
  readonly appendEngineEvent: (payload: EngineEvent) => void;
  readonly appendEngineEvents: (payloads: readonly EngineEvent[]) => void;
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
      // 事件全部来自引擎推送；没连接时就是空的，不塞演示数据
      return { events: { ...state.events, [deviceId]: [] } };
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

  clearDevice: (deviceId) => set((state) => ({ events: { ...state.events, [deviceId]: [] } })),

  appendEngineEvent: (payload) => get().appendEngineEvents([payload]),

  appendEngineEvents: (payloads) =>
    set((state) => {
      const additions = new Map<string, TraceEventView[]>();
      const seen = new Map<string, Set<string>>();
      let seq = state.seq;
      for (const payload of payloads) {
        let keys = seen.get(payload.deviceId);
        if (!keys) {
          keys = new Set((state.events[payload.deviceId] ?? []).map((item) => `${item.seq}:${item.type}`));
          seen.set(payload.deviceId, keys);
        }
        const key = `${payload.seq}:${payload.type}`;
        if (keys.has(key)) continue;
        keys.add(key);
        const list = additions.get(payload.deviceId) ?? [];
        list.push({ ...payload });
        additions.set(payload.deviceId, list);
        seq = Math.max(seq, payload.seq);
      }
      if (additions.size === 0) return state;
      const events = { ...state.events };
      for (const [deviceId, list] of additions) {
        events[deviceId] = [...(events[deviceId] ?? []), ...list].slice(-500);
      }
      return { seq, events };
    }),
}));
