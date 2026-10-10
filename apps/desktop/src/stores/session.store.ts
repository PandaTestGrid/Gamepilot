/**
 * 会话 store：与引擎的真实运行时对接（第 2~6 块）。
 *
 * 这里是"引擎 → 界面"的唯一入口：
 *   engine.frame  → 每帧画面（data URL）+ 当帧识别结果 + 节点状态
 *   engine.event  → 状态机事件（写进 event store，事件栏展示）
 *   device.*      → 连接阶段/失败/断开
 *
 * 约定：**引擎是唯一真源**。本地 store 只做展示态缓存，不反向假设引擎状态。
 */
import { create } from 'zustand';

import {
  connectDevice,
  disconnectDevice,
  type EngineEventPayload,
  type FramePayload,
  type GraphPayload,
  onEngineMessage,
  recordTemplate as recordTemplateRpc,
  runStart,
  runStop,
  setRecognizerThreshold,
  type DeviceNotificationPayload,
} from '@/lib/rpc';
import { toGraphData } from '@/lib/graph-adapter';
import { useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { useGraphStore } from '@/stores/graph.store';
import type { RecordDraft } from '@/types';

export interface FrameState {
  readonly imageUrl: string;
  readonly index: number;
  readonly resolution: readonly [number, number];
  readonly node: string | null;
  readonly pending: string | null;
  readonly tick: number;
  readonly fps: number;
  readonly captureMs: number;
  readonly detections: FramePayload['detections'];
  readonly ts: number;
}

interface SessionState {
  readonly frames: Readonly<Record<string, FrameState>>;
  readonly running: Readonly<Record<string, boolean>>;
  readonly ready: Readonly<Record<string, boolean>>;
  readonly connectingPhase: Readonly<Record<string, string>>;
  readonly error: string | null;
  readonly init: () => Promise<() => void>;
  readonly connect: (deviceId: string, uri: string) => Promise<void>;
  readonly disconnect: (deviceId: string) => Promise<void>;
  readonly startRun: (deviceId: string) => Promise<void>;
  readonly stopRun: (deviceId: string) => Promise<void>;
  readonly record: (deviceId: string, draft: RecordDraft) => Promise<void>;
  readonly setThreshold: (deviceId: string, label: string, threshold: number) => Promise<void>;
  readonly isReady: (deviceId: string) => boolean;
}

function applyGraph(deviceId: string, payload: GraphPayload, live?: FrameState): void {
  useGraphStore.getState().setGraph(deviceId, toGraphData(deviceId, payload, live));
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  frames: {},
  running: {},
  ready: {},
  connectingPhase: {},
  error: null,

  init: async () => {
    const unlisten = await onEngineMessage((method, params) => {
      if (method === 'engine.frame') {
        const frame = params as unknown as FramePayload;
        const state: FrameState = {
          imageUrl: `data:image/jpeg;base64,${frame.jpeg}`,
          index: frame.index,
          resolution: frame.resolution,
          node: frame.node,
          pending: frame.pending,
          tick: frame.tick,
          fps: frame.fps,
          captureMs: frame.captureMs,
          detections: frame.detections,
          ts: frame.ts,
        };
        set((current) => ({ frames: { ...current.frames, [frame.deviceId]: state } }));
        // 每帧同步识别分数 + 节点高亮（引擎是唯一真源）
        useGraphStore.getState().updateLive(frame.deviceId, {
          node: frame.node,
          pending: frame.pending,
          detections: frame.detections,
        });
        return;
      }

      if (method === 'engine.event') {
        const event = params as unknown as EngineEventPayload;
        useEventStore.getState().appendEngineEvent(event);
        return;
      }

      if (method === 'device.connecting') {
        const payload = params as unknown as DeviceNotificationPayload;
        set((current) => ({
          connectingPhase: { ...current.connectingPhase, [payload.deviceId]: payload.phase ?? '' },
        }));
        return;
      }

      if (method === 'device.connected') {
        const payload = params as unknown as DeviceNotificationPayload;
        useEventStore.getState().clearDevice(payload.deviceId);
        set((current) => ({
          ready: { ...current.ready, [payload.deviceId]: true },
          connectingPhase: { ...current.connectingPhase, [payload.deviceId]: '' },
        }));
        if (payload.graph) {
          applyGraph(payload.deviceId, payload.graph, get().frames[payload.deviceId]);
        }
        useEventStore.getState().append(payload.deviceId, 'device_reconnected', {
          message:
            `已连接 ${payload.uri ?? ''} ${payload.resolution ? payload.resolution.join('×') : ''}`.trim(),
        });
        return;
      }

      if (method === 'device.disconnected') {
        const payload = params as unknown as DeviceNotificationPayload;
        set((current) => ({ ready: { ...current.ready, [payload.deviceId]: false } }));
        useEventStore.getState().append(payload.deviceId, 'device_lost', { message: '已断开' });
        return;
      }

      if (method === 'device.failed') {
        const payload = params as unknown as DeviceNotificationPayload;
        useDeviceStore.getState().failConnect(payload.deviceId, payload.error ?? '连接失败');
        useEventStore.getState().append(payload.deviceId, 'error', { message: payload.error ?? '连接失败' });
      }
    });
    return unlisten;
  },

  connect: async (deviceId, uri) => {
    set({ error: null });
    useDeviceStore.getState().connect(deviceId);
    try {
      const result = await connectDevice(uri);
      useDeviceStore.getState().markConnectedWith(result.deviceId, result.resolution, uri);
      applyGraph(result.deviceId, result.graph, get().frames[result.deviceId]);
      set((current) => ({ ready: { ...current.ready, [result.deviceId]: true } }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      useDeviceStore.getState().failConnect(deviceId, message);
      useEventStore.getState().append(deviceId, 'error', { message });
    }
  },

  disconnect: async (deviceId) => {
    try {
      await disconnectDevice(deviceId);
    } catch (error) {
      // 引擎侧已经断开时不算错误
      set({ error: error instanceof Error ? error.message : String(error) });
    }
    useDeviceStore.getState().disconnect(deviceId);
    set((current) => ({ ready: { ...current.ready, [deviceId]: false } }));
  },

  startRun: async (deviceId) => {
    try {
      await runStart(deviceId);
      set((current) => ({ running: { ...current.running, [deviceId]: true } }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  stopRun: async (deviceId) => {
    try {
      await runStop(deviceId);
    } finally {
      set((current) => ({ running: { ...current.running, [deviceId]: false } }));
    }
  },

  record: async (deviceId, draft) => {
    try {
      const result = await recordTemplateRpc({
        deviceId,
        rect: draft.rect,
        label: draft.label,
        threshold: draft.threshold,
        nodeId: draft.targetMode === 'new' ? draft.newNodeId : (draft.targetNodeId ?? undefined),
        nodeName: draft.targetMode === 'new' ? draft.newNodeName : undefined,
        asEnter: draft.asEnter,
        asActionTarget: draft.asActionTarget,
      });
      applyGraph(deviceId, result.graph, get().frames[deviceId]);
      useEventStore.getState().append(deviceId, 'recognizer_added', {
        message: `+${result.label} (${result.mode}) → ${result.template}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      useEventStore.getState().append(deviceId, 'error', { message: `录制失败: ${message}` });
    }
  },

  setThreshold: async (deviceId, label, threshold) => {
    try {
      await setRecognizerThreshold(deviceId, label, threshold);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  isReady: (deviceId) => Boolean(get().ready[deviceId]),
}));
