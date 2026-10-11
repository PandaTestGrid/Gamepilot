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
  graphGet,
  deviceKey,
  deviceSwipe,
  deviceTap,
  deviceTouch,
  devLog,
  projectGet,
  projectSet,
  fetchFrame,
  fetchFrameDataUrl,
  recordAction,
  setStreamFps,
  type ProjectInfo,
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
import { useLogStore } from '@/stores/log.store';
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
  /** 当前脚本（工程）目录 */
  readonly project: ProjectInfo | null;
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
  /** blob 渲染失败时改用 data URL（保证画面一定显示得出来） */
  readonly recoverImage: (deviceId: string) => Promise<void>;
  /** 界面告诉引擎：这台设备我需要多少帧（0 = 停推） */
  readonly setStreamPolicy: (deviceId: string, fps: number) => void;
  /** 手动控制：轻触 / 滑动 / 功能键 */
  readonly tap: (deviceId: string, x: number, y: number) => Promise<void>;
  readonly swipe: (
    deviceId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
  ) => Promise<void>;
  readonly pressKey: (deviceId: string, key: string) => Promise<void>;
  /** 实时触控事件（down/move/up）；move 是高频的，不等待响应 */
  readonly touch: (deviceId: string, phase: 'down' | 'move' | 'up', x: number, y: number) => void;
  /** 刷新脚本目录信息（顶栏显示） */
  /** 把一步操作录进脚本（返回新边 id，失败返回 null） */
  readonly recordStep: (deviceId: string, action: Record<string, unknown>) => Promise<string | null>;
  readonly refreshProject: () => Promise<void>;
  /** 切换脚本目录：引擎会热重载所有设备的状态图 */
  readonly switchProject: (dir: string) => Promise<void>;
  /**
   * 引擎那边已经切好脚本了（脚本库的 create/duplicate/rename/delete 都会切），
   * 界面只做两件事：回显当前脚本信息 + 重新拉每台设备的状态图。不重复发 project.set。
   */
  readonly applyProjectChange: () => Promise<void>;
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
        // 延迟回收：<img> 可能还没来得及加载完就换 src，
        // 立刻 revoke 会让浏览器拿不到数据 → 画面一直空白（14fps 下必然会撞上）
        const stale = previous.imageUrl;
        setTimeout(() => URL.revokeObjectURL(stale), 3000);
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
  // 只验前 3 帧：探针本身也要完整解码一次，14fps 下等于把解码开销翻倍（应用会卡）
  if (index > 3) {
    return;
  }
  const probe = new Image();
  probe.onload = () => {
    devLog(`pull: 第 ${index} 帧解码成功 ${probe.naturalWidth}x${probe.naturalHeight}`);
  };
  probe.onerror = () => devLog(`pull: 第 ${index} 帧解码失败（字节可能坏了）`);
  probe.src = url;
}

/** 每台设备当前应用的推流帧率（避免重复发同样的 RPC） */
const streamPolicy = new Map<string, number>();

/**
 * 按需拉帧：间隔与"界面想看多少帧"一致，fps<=0 直接停（引擎那边同时停止推帧）。
 *
 * 单画面 10fps、多开每台 4~6fps、窗口不可见 0fps —— 不这么限，
 * 两台设备就是 ~4MB/s 的文本流，界面必然卡。
 */
function startFramePolling(deviceId: string, fps = 10): void {
  const existing = framePollers.get(deviceId);
  if (existing) {
    clearInterval(existing);
    framePollers.delete(deviceId);
  }
  framePollTick.delete(deviceId);
  const effective = Math.max(0, fps);
  if (effective <= 0) {
    return;
  }
  framePollers.set(
    deviceId,
    setInterval(() => void pullFrame(deviceId), Math.max(50, Math.round(1000 / effective))),
  );
}

/** 应用推流策略：通知引擎 + 调整拉帧节奏 */
function applyStreamPolicy(deviceId: string, fps: number): void {
  startFramePolling(deviceId, fps);
  if (!useSessionStore.getState().ready[deviceId] || streamPolicy.get(deviceId) === fps) {
    return;
  }
  streamPolicy.set(deviceId, fps);
  void setStreamFps(deviceId, fps).catch((error: unknown) => {
    devLog(`push: 设置推流帧率失败 ${String(error)}`);
  });
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  frames: {},
  running: {},
  ready: {},
  links: {},
  project: null,
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

      if (method === 'engine.log') {
        // 引擎结构化日志 → 底部抽屉的「日志」Tab（stderr 那条路照旧）
        useLogStore.getState().appendEngine(params);
        return;
      }

      if (method === 'project.changed') {
        const info = params as unknown as ProjectInfo;
        set({ project: info });
        devLog(`脚本目录已切换: ${info.root}`);
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
        applyStreamPolicy(payload.deviceId, 10);
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
    // 连接的设备必须同时成为"活动设备"：否则画面栏渲染的还是原来那台（多半没连上），
    // 用户点了连接、设备也连上了，画面栏却一直是空态——"看不到画面"就是这么来的
    useDeviceStore.getState().setActive(deviceId);
    try {
      const result = await connectDevice(uri);
      useDeviceStore.getState().markConnectedWith(result.deviceId, result.resolution, uri);
      useDeviceStore.getState().setActive(result.deviceId);
      set((current) => ({
        links: { ...current.links, [result.deviceId]: { channel: result.channel, note: result.linkNote } },
      }));
      applyGraph(result.deviceId, result.graph, get().frames[result.deviceId]);
      set((current) => ({ ready: { ...current.ready, [result.deviceId]: true } }));
      // 连接即要 10fps：引擎默认不推帧（避免灌满控制通道），
      // 独立窗口（?pane=screen）里没有 App 的策略 effect，靠这一步也能出画面
      applyStreamPolicy(result.deviceId, 10);
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
    streamPolicy.delete(deviceId);
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

  setStreamPolicy: (deviceId, fps) => applyStreamPolicy(deviceId, fps),

  recordStep: async (deviceId, action) => {
    if (!get().ready[deviceId]) {
      set({ error: '设备未连接：录操作需要先连上设备（否则不知道该录到哪个界面）' });
      return null;
    }
    try {
      const result = await recordAction(deviceId, action);
      useGraphStore
        .getState()
        .setGraph(deviceId, toGraphData(deviceId, result.graph, get().frames[deviceId]), result.graph);
      devLog(`录制步骤 ${result.edgeId}: ${String(action.type)}`);
      return result.edgeId;
    } catch (error) {
      set({ error: `录制失败: ${error instanceof Error ? error.message : String(error)}` });
      return null;
    }
  },

  refreshProject: async () => {
    // 只回显信息，不动各设备的状态图（切换/库操作请用 applyProjectChange）
    try {
      set({ project: await projectGet() });
    } catch (error) {
      devLog(`project.get 失败: ${String(error)}`);
    }
  },

  switchProject: async (dir) => {
    try {
      await projectSet(dir);
      await get().applyProjectChange();
      set({ error: null });
    } catch (error) {
      set({ error: `切换脚本目录失败: ${error instanceof Error ? error.message : String(error)}` });
    }
  },

  applyProjectChange: async () => {
    try {
      const info = await projectGet();
      set({ project: info, error: null });
      // 换脚本后每台设备的状态图都变了：重新拉一遍（引擎侧已热重载，当前节点与运行态保留）
      for (const deviceId of Object.keys(get().ready)) {
        if (!get().ready[deviceId]) {
          continue;
        }
        const graph = await graphGet(deviceId);
        applyGraph(deviceId, graph, get().frames[deviceId]);
      }
    } catch (error) {
      set({ error: `读取脚本目录失败: ${error instanceof Error ? error.message : String(error)}` });
    }
  },

  touch: (deviceId, phase, x, y) => {
    if (!get().ready[deviceId]) {
      if (phase === 'down') {
        set({ error: '设备未连接：先在设备面板连接一台，再操作画面' });
      }
      return;
    }
    // 拖动时 move 是高频事件：不 await，也不因为个别失败就弹错误条（否则会刷屏）
    void deviceTouch(deviceId, phase, x, y).catch((error: unknown) => {
      if (phase !== 'move') {
        set({ error: `触控失败: ${error instanceof Error ? error.message : String(error)}` });
      }
    });
  },

  tap: async (deviceId, x, y) => {
    if (!get().ready[deviceId]) {
      set({ error: '设备未连接：先在设备面板连接一台，再操作画面' });
      return;
    }
    try {
      await deviceTap(deviceId, x, y);
    } catch (error) {
      set({ error: `点击失败: ${error instanceof Error ? error.message : String(error)}` });
    }
  },

  swipe: async (deviceId, x1, y1, x2, y2, durationMs) => {
    if (!get().ready[deviceId]) {
      set({ error: '设备未连接：先在设备面板连接一台，再操作画面' });
      return;
    }
    try {
      await deviceSwipe(deviceId, x1, y1, x2, y2, durationMs);
    } catch (error) {
      set({ error: `滑动失败: ${error instanceof Error ? error.message : String(error)}` });
    }
  },

  pressKey: async (deviceId, key) => {
    if (!get().ready[deviceId]) {
      set({ error: '设备未连接：先在设备面板连接一台，再操作画面' });
      return;
    }
    try {
      await deviceKey(deviceId, key);
    } catch (error) {
      set({ error: `按键失败: ${error instanceof Error ? error.message : String(error)}` });
    }
  },

  recoverImage: async (deviceId) => {
    devLog(`画面栏: blob 加载失败，改用 base64 兜底 (${deviceId})`);
    try {
      const dataUrl = await fetchFrameDataUrl(deviceId);
      if (!dataUrl) {
        set({ error: '画面渲染失败，且兜底数据为空（引擎可能已断开）' });
        return;
      }
      set((current) => {
        const previous = current.frames[deviceId];
        return {
          frames: {
            ...current.frames,
            [deviceId]: { ...previous, imageUrl: dataUrl } as FrameState,
          },
        };
      });
    } catch (error) {
      set({ error: `画面渲染失败: ${error instanceof Error ? error.message : String(error)}` });
    }
  },
}));
