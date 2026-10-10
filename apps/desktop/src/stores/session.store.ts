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
  devLog,
  fetchFrame,
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
  /** 投屏通道（scrcpy / screencap）与说明，底栏显示 */
  readonly links: Readonly<Record<string, { channel: string; note: string }>>;
  readonly connectingPhase: Readonly<Record<string, string>>;
  readonly error: string | null;
  readonly init: () => Promise<() => void>;
  /** 返回是否连接成功（组件据此决定是否收起设备弹层） */
  readonly connect: (deviceId: string, uri: string) => Promise<boolean>;
  readonly disconnect: (deviceId: string) => Promise<void>;
  readonly startRun: (deviceId: string) => Promise<void>;
  readonly stopRun: (deviceId: string) => Promise<void>;
  readonly record: (deviceId: string, draft: RecordDraft) => Promise<void>;
  readonly setThreshold: (deviceId: string, label: string, threshold: number) => Promise<void>;
  readonly isReady: (deviceId: string) => boolean;
  readonly clearError: () => void;
}

function applyGraph(deviceId: string, payload: GraphPayload, live?: FrameState): void {
  useGraphStore.getState().setGraph(deviceId, toGraphData(deviceId, payload, live));
}

/** 每台设备一个拉帧定时器；framePollTick 是"当前已拉到的帧号"，避免重复拉取 */
const framePollers = new Map<string, ReturnType<typeof setInterval>>();
const framePollTick = new Map<string, number>();

function stopFramePolling(deviceId: string): void {
  const timer = framePollers.get(deviceId);
  if (timer) {
    clearInterval(timer);
    framePollers.delete(deviceId);
  }
  framePollTick.delete(deviceId);
}

/** 按需拉帧：只有引擎报了新帧号才去取字节，避免无谓的 IPC */
async function pullFrame(deviceId: string): Promise<void> {
  const state = useSessionStore.getState();
  const meta = state.frames[deviceId];
  if (!meta || framePollTick.get(deviceId) === meta.index) {
    return;
  }
  try {
    const buffer = await fetchFrame(deviceId);
    if (!buffer) {
      devLog(`pull: 第 ${meta.index} 帧没拿到字节（引擎缓存为空？）`);
      return;
    }
    if (framePollTick.get(deviceId) === undefined) {
      devLog(`pull: 首次拉到第 ${meta.index} 帧 ${buffer.byteLength} 字节`);
    }
    framePollTick.set(deviceId, meta.index);
    const url = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }));
    verifyImage(url, meta.index);
    useSessionStore.setState((current) => {
      const previous = current.frames[deviceId];
      if (previous?.imageUrl.startsWith('blob:')) {
        URL.revokeObjectURL(previous.imageUrl);
      }
      return { frames: { ...current.frames, [deviceId]: { ...previous, imageUrl: url } as FrameState } };
    });
  } catch (error) {
    // 拉帧失败（引擎挂了/设备断开）不刷屏：停掉轮询，把原因交给错误条
    stopFramePolling(deviceId);
    useSessionStore.setState({
      error: `拉取画面失败: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * 用浏览器自己的解码器验一遍刚拉到的字节。
 *
 * 排查"字节到了但画面不出来"时，这一步能区分是**字节/解码问题**还是**渲染/布局问题**：
 * 能 onload 说明 <img> 一定能显示，问题就在布局或 store 选择器上。
 */
function verifyImage(url: string, index: number): void {
  const probe = new Image();
  probe.onload = () => {
    if (index % 300 < 20) {
      devLog(`pull: 第 ${index} 帧解码成功 ${probe.naturalWidth}x${probe.naturalHeight}`);
    }
  };
  probe.onerror = () => devLog(`pull: 第 ${index} 帧解码失败（字节可能坏了）`);
  probe.src = url;
}

function startFramePolling(deviceId: string): void {
  if (framePollers.has(deviceId)) {
    return;
  }
  devLog(`pull: 开始为 ${deviceId} 拉帧`);
  framePollers.set(
    deviceId,
    setInterval(() => void pullFrame(deviceId), 70),
  );
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  frames: {},
  running: {},
  ready: {},
  links: {},
  connectingPhase: {},
  error: null,

  init: async () => {
    devLog('session: 开始订阅 engine://event');
    let seen = 0;
    const unlisten = await onEngineMessage((method, params) => {
      seen += 1;
      if (seen <= 3) {
        devLog(`session: 收到通知 #${seen} ${method}`);
      }
      if (method === 'engine.frame') {
        const frame = params as unknown as FramePayload;
        // 有两处订阅（引擎状态 + 会话），同一条通知会进来两次：索引没变就直接跳过
        if (get().frames[frame.deviceId]?.index === frame.index) {
          return;
        }
        if (frame.index % 60 === 1) {
          devLog(`frame #${frame.index} ${String(frame.deviceId)} capture=${String(frame.captureMs)}ms`);
        }
        const previous = get().frames[frame.deviceId];
        const state: FrameState = {
          // 画面优先用轮询拉到的 blob；事件里的 base64 只是老引擎的兜底
          imageUrl: previous?.imageUrl?.startsWith('blob:')
            ? previous.imageUrl
            : frame.jpeg
              ? `data:image/jpeg;base64,${frame.jpeg}`
              : (previous?.imageUrl ?? ''),
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
        startFramePolling(payload.deviceId);
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
      set((current) => ({
        links: { ...current.links, [result.deviceId]: { channel: result.channel, note: result.linkNote } },
      }));
      applyGraph(result.deviceId, result.graph, get().frames[result.deviceId]);
      set((current) => ({ ready: { ...current.ready, [result.deviceId]: true } }));
      startFramePolling(result.deviceId);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      useDeviceStore.getState().failConnect(deviceId, message);
      useEventStore.getState().append(deviceId, 'error', { message });
      return false;
    }
  },

  disconnect: async (deviceId) => {
    try {
      await disconnectDevice(deviceId);
    } catch (error) {
      // 引擎侧已经断开时不算错误
      set({ error: error instanceof Error ? error.message : String(error) });
    }
    stopFramePolling(deviceId);
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

  clearError: () => set({ error: null }),
}));
