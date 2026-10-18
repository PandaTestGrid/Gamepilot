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
import { condGroupsFromParams, condParamsFromGroups } from '@/features/graph/flow/flow-cond-params';
import { loopProgressMapFromExtra, type LoopProgress } from '@/features/graph/flow/flow-loop-progress';
import { unconnectedFlowRunError } from '@/features/graph/flow/flow-layout';
import { flowStepTitle } from '@/features/graph/flow/flow-step-meta';
import { useUiStore, workflowRootInList, workflowRootKey, withWorkflowRoot } from '@/stores/ui.store';
import { isWorkflowLive } from '@/lib/flow-edit-lock';
import { isUnknownMethodError, staleEngineHint } from '@/lib/engine-methods';
import { queueManualInput } from '@/lib/manual-input';
import { PREVIEW_FPS } from '@/lib/stream-policy';

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
  recordOcr as recordOcrRpc,
  recordTemplate as recordTemplateRpc,
  removeRecognizer as removeRecognizerRpc,
  renameRecognizer as renameRecognizerRpc,
  runStart,
  runStep,
  runStop,
  runResume,
  setBreakpoint,
  setRecognizerSearch as setRecognizerSearchRpc,
  setRecognizerThreshold,
  type DeviceNotificationPayload,
  type OcrRecognizeResult,
  type OcrStatusPayload,
} from '@/lib/rpc';
import { useOcrStore } from '@/stores/ocr.store';
import { toGraphData } from '@/lib/graph-adapter';
import { connectedDevices, useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { WORKFLOW_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useLogStore } from '@/stores/log.store';
import { setPositionScope } from '@/lib/node-positions';
import { setActiveWorkflowRoot } from '@/lib/workflow-active-root';
import { clearTemplateCache } from '@/stores/template.store';
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
  /** 当前这次运行是从哪个步骤启动的（未传 stepId 或从头启动时记为 null，停止后清空） */
  readonly runningStartStep: Readonly<Record<string, string | null>>;
  /** 每台设备正在执行的工作流目录列表（每个 Tab 独立，切走之后也算还活着） */
  readonly runningWorkflowRoots: Readonly<Record<string, readonly string[]>>;
  /** 正在执行的循环：stepId → 当前次 / 总次数（节点头部「2 / 12」） */
  readonly loopProgress: Readonly<Record<string, Readonly<Record<string, LoopProgress>>>>;
  /** 断点暂停在哪一步（null = 没暂停）；由引擎的 `breakpoint_hit` 事件驱动 */
  readonly paused: Readonly<Record<string, string | null>>;
  /** 每台设备上的断点（步骤 id）。引擎是唯一真源，这里只是回显副本 */
  readonly breakpoints: Readonly<Record<string, readonly string[]>>;
  readonly ready: Readonly<Record<string, boolean>>;
  /** 投屏通道（Android scrcpy / iOS dvt / macOS quartz）与说明，底栏显示 */
  readonly links: Readonly<Record<string, { channel: string; note: string }>>;
  /** 当前工作流（`project.get` 返回，RPC 名仍是 project） */
  readonly currentWorkflow: ProjectInfo | null;
  /** 正在切工作流 / 工作区：界面在「运行中」前转圈，避免热重载把停止态闪出来 */
  readonly switchingWorkflow: boolean;
  /** 正在切过去的目录（空串 = 没在切）；标签转圈钉在目标 Tab 上，不要留在旧的那张 */
  readonly switchingWorkflowRoot: string;
  /** 切入时已经在跑：交接期间继续画「运行中」（图重载后 running 会先变 false） */
  readonly holdRunningDuringSwitch: boolean;
  readonly connectingPhase: Readonly<Record<string, string>>;
  readonly error: string | null;
  readonly enterWorkflowSwitch: (root?: string) => void;
  readonly leaveWorkflowSwitch: () => void;
  readonly init: () => Promise<() => void>;
  /** 返回是否连接成功（组件据此决定是否收起设备弹层） */
  readonly connect: (deviceId: string, uri: string) => Promise<boolean>;
  readonly disconnect: (deviceId: string) => Promise<void>;
  readonly startRun: (deviceId: string, stepId?: string) => Promise<void>;
  readonly stopRun: (deviceId: string, workflowRoot?: string) => Promise<void>;
  /** 断点暂停后继续（`run.resume`） */
  readonly resumeRun: (deviceId: string) => Promise<void>;
  /** 单步：执行完当前这一步再停（`run.step`） */
  readonly stepRun: (deviceId: string) => Promise<void>;
  /** 给某个步骤设/清断点（`run.breakpoint`，参数名仍叫 edgeId，语义是步骤 id） */
  readonly setStepBreakpoint: (deviceId: string, stepId: string, enabled: boolean) => Promise<void>;
  readonly record: (deviceId: string, draft: RecordDraft) => Promise<void>;
  readonly setThreshold: (deviceId: string, label: string, threshold: number) => Promise<void>;
  /** 切换模板搜索范围：region（只在录制区域找）/ full（整帧找，目标位置不固定时用） */
  readonly setRecognizerSearch: (deviceId: string, label: string, search: 'region' | 'full') => Promise<void>;
  /** 识别器改名：引擎级联改掉所有引用，返回改了几处（界面拿它做提示） */
  readonly renameRecognizer: (
    deviceId: string,
    label: string,
    to: string,
  ) => Promise<{ refs: { nodes: number; edges: number; scores: number } } | null>;
  /** 删除识别器/模板；被节点或边引用时引擎拒绝，原因进错误条 + 事件栏 */
  readonly removeRecognizer: (deviceId: string, label: string) => Promise<boolean>;
  readonly isReady: (deviceId: string) => boolean;
  /** 扫描结果里引擎还在带的设备 → 对齐成"已连接"（界面重载/重启后不再显示"未连接"） */
  readonly adoptLiveDevices: () => void;
  readonly clearError: () => void;
  /** 引擎重启时同时清掉拉帧定时器和推流策略缓存。 */
  readonly resetForEngineRestart: () => void;
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
  readonly touch: (deviceId: string, phase: 'down' | 'move' | 'up', x: number, y: number) => Promise<boolean>;
  /** 刷新当前工作流信息（右栏「工作区」回显 + 中间画布） */
  /** 把一步操作录进当前工作流（返回新边 id，失败返回 null） */
  readonly recordStep: (deviceId: string, action: Record<string, unknown>) => Promise<string | null>;
  readonly refreshCurrentWorkflow: () => Promise<void>;
  /** 切换工作流目录：引擎热重载 graph.json（`project.set`） */
  readonly switchWorkflow: (dir: string) => Promise<void>;
  /**
   * 引擎已切好工作流（`workflow.*` 写操作后会切），界面回显 + 拉 graph，不重复 `project.set`。
   */
  readonly syncCurrentWorkflow: () => Promise<void>;
}

/** 嵌套的切目录（Tab + 工作区）共用一个计数，谁先结束都不能提前摘掉转圈。 */
let workflowSwitchDepth = 0;

function applyWorkflowGraph(
  deviceId: string,
  payload: GraphPayload,
  live?: FrameState,
  options?: { applyStructure?: boolean },
): void {
  useGraphStore.getState().setGraph(deviceId, toGraphData(deviceId, payload, live), payload, options);
}

/** 每台设备一个拉帧定时器；framePollTick 是"当前已拉到的帧号"，避免重复拉取 */
const framePollers = new Map<string, ReturnType<typeof setInterval>>();
const framePollTick = new Map<string, number>();
/** 正在拉取的设备：事件驱动与定时兜底会撞在同一帧上，别叠成两次 IPC */
const framePullInFlight = new Set<string>();

function stopFramePolling(deviceId: string): void {
  const timer = framePollers.get(deviceId);
  if (timer) {
    clearInterval(timer);
    framePollers.delete(deviceId);
  }
  framePollTick.delete(deviceId);
}

/**
 * 按需拉帧：只有引擎报了新帧号才去取字节，避免无谓的 IPC。
 *
 * 触发有两条路：`engine.frame` 事件到的那一刻（主路，延迟最小），
 * 以及定时器兜底（丢了事件也能自己追上）。
 */
async function pullFrame(deviceId: string): Promise<void> {
  if (framePullInFlight.has(deviceId)) {
    // 上一帧还没回来。等它回来时 finally 里会看最新帧号再补一次，不用排队。
    return;
  }
  const state = useSessionStore.getState();
  const meta = state.frames[deviceId];
  if (!meta || framePollTick.get(deviceId) === meta.index) {
    return;
  }
  framePullInFlight.add(deviceId);
  // 只有"真的拿到了字节"才允许在 finally 里补拉下一次：
  // 失败 / 拿到空字节时立刻补拉会变成死循环（每轮都失败、每轮都重试），
  // 也就是 e2e 里那个把 jsdom worker 撑到 OOM 的写法。
  let advanced = false;
  try {
    const buffer = await fetchFrame(deviceId);
    if (!buffer) {
      devLog(`pull: 第 ${meta.index} 帧没拿到字节（引擎缓存为空？）`);
      return;
    }
    if (framePollTick.get(deviceId) === undefined) {
      devLog(`pull: 首次拉到第 ${meta.index} 帧 ${buffer.byteLength} 字节`);
    }
    advanced = true;
    framePollTick.set(deviceId, meta.index);
    const url = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }));
    verifyImage(url, meta.index);
    useSessionStore.setState((current) => {
      const previous = current.frames[deviceId];
      if (previous?.imageUrl.startsWith('blob:')) {
        // 延迟回收：<img> 可能还没来得及加载完就换 src，
        // 立刻 revoke 会让浏览器拿不到数据 → 画面一直空白（30fps 下必然会撞上）
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
  } finally {
    framePullInFlight.delete(deviceId);
    // 拉取期间又来了新帧：立刻补一次，别等下一个定时拍（否则帧率越高丢得越多）
    const latest = useSessionStore.getState().frames[deviceId];
    if (advanced && latest && framePollTick.get(deviceId) !== latest.index) {
      void pullFrame(deviceId);
    }
  }
}

/**
 * 用浏览器自己的解码器验一遍刚拉到的字节。
 *
 * 排查"字节到了但画面不出来"时，这一步能区分是**字节/解码问题**还是**渲染/布局问题**：
 * 能 onload 说明 <img> 一定能显示，问题就在布局或 store 选择器上。
 */
function verifyImage(url: string, index: number): void {
  // 只验前 3 帧：探针本身也要完整解码一次，30fps 下等于把解码开销翻倍（应用会卡）
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
const reconnectingDevices = new Map<string, Promise<boolean>>();

function fallbackUriForDeviceId(deviceId: string): string | null {
  if (deviceId.startsWith('android:')) {
    const rest = deviceId.slice('android:'.length);
    const [serial, physical] = rest.split(':');
    if (serial) {
      return physical
        ? `Android:///?serial=${encodeURIComponent(serial)}&physical=${encodeURIComponent(physical)}`
        : `Android:///?serial=${encodeURIComponent(serial)}`;
    }
  }
  return null;
}

/**
 * 引擎进程重启或会话丢失后，前端仍持有设备 URI 时自动重连会话；
 * 无法重连时把假「已连接」状态复位，避免界面一直报 `设备未连接: xxx`。
 */
export async function recoverDisconnectedSession(deviceId: string): Promise<boolean> {
  if (!deviceId) return false;
  const inflight = reconnectingDevices.get(deviceId);
  if (inflight) return inflight;
  const task = (async () => {
    try {
      const device = useDeviceStore.getState().devices.find((item) => item.id === deviceId);
      const uri =
        (device?.uri && device.uri.includes('://') ? device.uri : null) ?? fallbackUriForDeviceId(deviceId);
      if (!uri) {
        stopFramePolling(deviceId);
        streamPolicy.delete(deviceId);
        useDeviceStore.getState().disconnect(deviceId);
        useSessionStore.setState((current) => ({ ready: { ...current.ready, [deviceId]: false } }));
        return false;
      }
      devLog(`session: 检测到引擎端设备未连接 (${deviceId})，正在自动重连 ${uri}`);
      return await useSessionStore.getState().connect(deviceId, uri);
    } finally {
      reconnectingDevices.delete(deviceId);
    }
  })();
  reconnectingDevices.set(deviceId, task);
  return task;
}

export async function withDeviceSession<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('设备未连接')) {
      const ok = await recoverDisconnectedSession(deviceId);
      if (ok) {
        return await fn();
      }
    }
    throw error;
  }
}

/**
 * 按需拉帧：间隔与"界面想看多少帧"一致，fps<=0 直接停（引擎那边同时停止推帧）。
 *
 * 主路是 `engine.frame` 事件（到达即拉）；这个定时器只是兜底 ——
 * 事件丢了也能自己追上。单画面 PREVIEW_FPS、多开每台 4~6fps、不可见 0fps。
 */
function startFramePolling(deviceId: string, fps = PREVIEW_FPS): void {
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
    const msg = error instanceof Error ? error.message : String(error);
    devLog(`push: 设置推流帧率失败 ${msg}`);
    if (msg.includes('设备未连接')) {
      streamPolicy.delete(deviceId);
      void recoverDisconnectedSession(deviceId);
    }
  });
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  frames: {},
  running: {},
  runningStartStep: {},
  runningWorkflowRoots: {},
  loopProgress: {},
  paused: {},
  breakpoints: {},
  ready: {},
  links: {},
  currentWorkflow: null,
  switchingWorkflow: false,
  switchingWorkflowRoot: '',
  holdRunningDuringSwitch: false,
  connectingPhase: {},
  error: null,

  enterWorkflowSwitch: (root) => {
    workflowSwitchDepth += 1;
    const target = (root || '').trim();
    const currentRoot = get().currentWorkflow?.root ?? '';
    const liveLists = Object.values(get().runningWorkflowRoots);
    const isLive = (value: string): boolean =>
      Boolean(value) && liveLists.some((roots) => workflowRootInList(roots, value));
    const hold = isLive(target) || isLive(currentRoot) || get().holdRunningDuringSwitch;
    set({
      switchingWorkflow: true,
      holdRunningDuringSwitch: hold,
      switchingWorkflowRoot: root || get().switchingWorkflowRoot,
    });
  },

  leaveWorkflowSwitch: () => {
    workflowSwitchDepth = Math.max(0, workflowSwitchDepth - 1);
    if (
      workflowSwitchDepth === 0 &&
      (get().switchingWorkflow || get().holdRunningDuringSwitch || get().switchingWorkflowRoot)
    ) {
      set({ switchingWorkflow: false, holdRunningDuringSwitch: false, switchingWorkflowRoot: '' });
    }
  },

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
        // 帧事件一到就抓字节：Rust 只缓存最新一帧，早拉早显示。
        // 只靠定时器等于给每一帧白加最多"一个轮询间隔"的延迟（原来是 100ms）。
        void pullFrame(frame.deviceId);
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
        const deviceId = event.deviceId;
        const eventRoot = event.workflowRoot ?? '';
        const currentRoot = get().currentWorkflow?.root ?? '';
        const forCurrent = !eventRoot || workflowRootKey(eventRoot) === workflowRootKey(currentRoot);
        if (!forCurrent) {
          return;
        }
        const loops = loopProgressMapFromExtra(event.extra);
        if (event.type === 'flow_finished') {
          set((current) => ({
            loopProgress: { ...current.loopProgress, [deviceId]: {} },
          }));
        } else if (loops !== null) {
          set((current) => ({
            loopProgress: { ...current.loopProgress, [deviceId]: loops },
          }));
        }
        // 断点暂停 / 继续：引擎的 breakpoint_hit 是唯一入口（事件里带暂停所在的步骤）
        if (event.type === 'breakpoint_hit') {
          set((current) => ({
            paused: { ...current.paused, [deviceId]: event.node ?? null },
          }));
        } else if (
          event.type === 'step_started' ||
          event.type === 'flow_started' ||
          event.type === 'flow_finished'
        ) {
          // 跑过任何一步 / 重新开始 / 结束都不再处于暂停态（否则横幅会一直挂着）
          set((current) =>
            current.paused[deviceId] ? { paused: { ...current.paused, [deviceId]: null } } : current,
          );
        }
        // 未开画面推流时不会收到 engine.frame，但仍要靠事件更新「当前跑到哪一步」
        if (
          event.node &&
          (event.type === 'flow_started' ||
            event.type === 'step_started' ||
            event.type === 'step_skipped' ||
            event.type === 'breakpoint_hit')
        ) {
          const previous = get().frames[deviceId];
          useGraphStore.getState().updateLive(deviceId, {
            node: event.node,
            pending: previous?.pending ?? null,
            detections: previous?.detections ?? [],
          });
        }
        return;
      }
      if (method === 'run.started' || method === 'run.stopped') {
        const id = String(params.deviceId);
        const isRunning = method === 'run.started';
        const fromEngine = typeof params.workflowRoot === 'string' ? params.workflowRoot : '';
        set((current) => {
          const root = fromEngine || current.currentWorkflow?.root || '';
          const nextRoots =
            !isRunning && !fromEngine
              ? []
              : withWorkflowRoot(current.runningWorkflowRoots[id], root, isRunning);
          const stillRunning = isRunning || nextRoots.length > 0;
          return {
            running: { ...current.running, [id]: stillRunning },
            runningStartStep:
              isRunning || stillRunning
                ? current.runningStartStep
                : { ...current.runningStartStep, [id]: null },
            runningWorkflowRoots: { ...current.runningWorkflowRoots, [id]: nextRoots },
            // 开跑/停跑都不是暂停态
            paused: current.paused[id] ? { ...current.paused, [id]: null } : current.paused,
            loopProgress:
              isRunning || stillRunning ? current.loopProgress : { ...current.loopProgress, [id]: {} },
          };
        });
        return;
      }

      if (method === 'run.resumed') {
        // 引擎已经继续了：本地暂停态要立刻清，别等下一步的 step_started
        const id = String(params.deviceId);
        set((current) => (current.paused[id] ? { paused: { ...current.paused, [id]: null } } : current));
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

      if (method === 'ocr.progress') {
        useOcrStore.getState().applyProgress(params as unknown as OcrStatusPayload);
        return;
      }

      if (method === 'ocr.result') {
        useOcrStore.getState().applyRecognizeResult(params as unknown as OcrRecognizeResult);
        return;
      }

      if (method === 'project.changed') {
        const info = params as unknown as ProjectInfo;
        setPositionScope(info.root);
        setActiveWorkflowRoot(info.root);
        clearTemplateCache();
        if (!info.root) {
          useGraphStore.getState().clearWorkflowGraph();
        }
        set({ currentWorkflow: info });
        devLog(`当前工作流已切换: ${info.root}`);
        return;
      }

      if (method === 'device.connected') {
        const payload = params as unknown as DeviceNotificationPayload;
        useEventStore.getState().clearDevice(payload.deviceId);
        set((current) => ({
          ready: { ...current.ready, [payload.deviceId]: true },
          connectingPhase: { ...current.connectingPhase, [payload.deviceId]: '' },
          links: payload.channel
            ? {
                ...current.links,
                [payload.deviceId]: { channel: payload.channel, note: payload.linkNote ?? '' },
              }
            : current.links,
        }));
        if (payload.resolution) {
          useDeviceStore
            .getState()
            .markConnectedWith(payload.deviceId, payload.resolution, payload.uri, payload.name, payload.kind);
        }
        if (payload.graph) {
          applyWorkflowGraph(payload.deviceId, payload.graph, get().frames[payload.deviceId], {
            applyStructure: false,
          });
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
        stopFramePolling(payload.deviceId);
        streamPolicy.delete(payload.deviceId);
        useDeviceStore.getState().disconnect(payload.deviceId);
        set((current) => ({ ready: { ...current.ready, [payload.deviceId]: false } }));
        useEventStore.getState().append(payload.deviceId, 'device_lost', { message: '已断开' });
        return;
      }

      if (method === 'device.failed') {
        const payload = params as unknown as DeviceNotificationPayload;
        const message = payload.error ?? '连接失败';
        const previous = useDeviceStore.getState().devices.find((device) => device.id === payload.deviceId);
        if (payload.channel) {
          set((current) => ({
            links: {
              ...current.links,
              [payload.deviceId]: { channel: payload.channel!, note: payload.linkNote ?? '' },
            },
          }));
        }
        if (previous?.status !== 'failed' || previous.error !== message) {
          useDeviceStore.getState().failConnect(payload.deviceId, message);
          useEventStore.getState().append(payload.deviceId, 'error', { message });
          set({ error: message });
        }
        return;
      }

      if (method === 'device.recovered') {
        const payload = params as unknown as DeviceNotificationPayload;
        if (!get().ready[payload.deviceId]) return;
        const previous = useDeviceStore.getState().devices.find((device) => device.id === payload.deviceId);
        useDeviceStore.getState().markConnected(payload.deviceId);
        set((current) => ({
          error: current.error === previous?.error ? null : current.error,
          links: payload.channel
            ? {
                ...current.links,
                [payload.deviceId]: { channel: payload.channel, note: payload.linkNote ?? '' },
              }
            : current.links,
        }));
        useEventStore.getState().append(payload.deviceId, 'device_reconnected', { message: '画面已恢复' });
      }
    });
    return unlisten;
  },

  connect: async (deviceId, uri) => {
    set({ error: null });
    const previousActiveId = useDeviceStore.getState().activeId;
    useDeviceStore.getState().connect(deviceId);
    // 连接的设备必须同时成为"活动设备"：否则画面栏渲染的还是原来那台（多半没连上），
    // 用户点了连接、设备也连上了，画面栏却一直是空态——"看不到画面"就是这么来的
    useDeviceStore.getState().setActive(deviceId);
    try {
      const result = await connectDevice(uri);
      // 引擎回传人类可读的名字与类型（iOS 型号 / macOS 窗口标题），界面直接用它显示
      useDeviceStore
        .getState()
        .markConnectedWith(result.deviceId, result.resolution, uri, result.name, result.kind);
      // 用户在连接等待期间可能已切到别的窗口：迟到的结果不能把画面又抢回去。
      if (useDeviceStore.getState().activeId === deviceId) {
        useDeviceStore.getState().setActive(result.deviceId);
      }
      set((current) => ({
        links: { ...current.links, [result.deviceId]: { channel: result.channel, note: result.linkNote } },
      }));
      applyWorkflowGraph(result.deviceId, result.graph, get().frames[result.deviceId], {
        applyStructure: false,
      });
      set((current) => ({ ready: { ...current.ready, [result.deviceId]: true } }));
      // 连接即要画面：引擎默认不推帧（避免灌满控制通道），
      // 独立窗口随后由 App 的推流策略接着管（主窗口隐藏时，windowed 设备也不能被掐成 0）
      applyStreamPolicy(result.deviceId, PREVIEW_FPS);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      const previous = useDeviceStore.getState().devices.find((device) => device.id === deviceId);
      useDeviceStore.getState().failConnect(deviceId, message);
      // 新窗口连不上时继续显示之前的画面；失败原因留在错误条与该窗口的标题中。
      if (previousActiveId && useDeviceStore.getState().activeId === deviceId) {
        useDeviceStore.getState().setActive(previousActiveId);
      }
      if (previous?.status !== 'failed' || previous.error !== message) {
        useEventStore.getState().append(deviceId, 'error', { message });
      }
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

  startRun: async (deviceId, stepId) => {
    try {
      const workflowRoot = get().currentWorkflow?.root ?? '';
      // 画布只画用户连过的线：没接进来的模块不跑，先把"哪个没连"说清楚
      const flowSteps = useGraphStore.getState().graphs[WORKFLOW_SCOPE]?.flow?.steps ?? [];
      const orphanError = unconnectedFlowRunError(flowSteps, stepId, flowStepTitle);
      if (orphanError) {
        set({ error: orphanError });
        return;
      }
      // 第一台开跑前把画布刷到引擎；已有设备在跑同一份脚本时不能再 save
      // （引擎会当成改图拒绝，已经在跑的那台也会被热重载冲掉）。
      if (!isWorkflowLive(workflowRoot, get().runningWorkflowRoots)) {
        await useGraphStore.getState().flushWorkflowToEngine({ force: true });
      }
      if (stepId) {
        const steps = useGraphStore.getState().graphs[WORKFLOW_SCOPE]?.flow?.steps ?? [];
        if (!steps.some((step) => step.id === stepId)) {
          set({ error: `找不到模块「${stepId}」：可能已被删除，请刷新工作流后再试` });
          return;
        }
      }
      await withDeviceSession(deviceId, () => runStart(deviceId, stepId, workflowRoot));
      set((current) => ({
        running: { ...current.running, [deviceId]: true },
        runningStartStep: { ...current.runningStartStep, [deviceId]: stepId ?? null },
        runningWorkflowRoots: {
          ...current.runningWorkflowRoots,
          [deviceId]: withWorkflowRoot(current.runningWorkflowRoots[deviceId], workflowRoot, true),
        },
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  stopRun: async (deviceId, workflowRoot) => {
    const root = workflowRoot ?? get().currentWorkflow?.root ?? '';
    try {
      await runStop(deviceId, root);
    } finally {
      set((current) => {
        const roots = withWorkflowRoot(current.runningWorkflowRoots[deviceId], root, false);
        const still = roots.length > 0;
        return {
          running: { ...current.running, [deviceId]: still },
          runningStartStep: still
            ? current.runningStartStep
            : { ...current.runningStartStep, [deviceId]: null },
          runningWorkflowRoots: { ...current.runningWorkflowRoots, [deviceId]: roots },
          loopProgress: still ? current.loopProgress : { ...current.loopProgress, [deviceId]: {} },
        };
      });
    }
  },

  resumeRun: async (deviceId) => {
    try {
      await runResume(deviceId);
      set((current) => ({ paused: { ...current.paused, [deviceId]: null } }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  stepRun: async (deviceId) => {
    try {
      await runStep(deviceId);
      set((current) => ({ paused: { ...current.paused, [deviceId]: null } }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  setStepBreakpoint: async (deviceId, stepId, enabled) => {
    try {
      const result = await setBreakpoint(deviceId, stepId, enabled);
      set((current) => ({
        breakpoints: { ...current.breakpoints, [deviceId]: result.breakpoints },
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  record: async (deviceId, draft) => {
    try {
      // OCR 识别器是另一种录制：框一块区域 + 填要认的字（不裁模板图）
      const isOcr = draft.kind === 'ocr';
      const shared = {
        deviceId,
        rect: draft.rect,
        label: draft.label,
        nodeId: draft.targetMode === 'new' ? draft.newNodeId : (draft.targetNodeId ?? undefined),
        nodeName: draft.targetMode === 'new' ? draft.newNodeName : undefined,
        // 「新建界面」的 id 交给引擎分配：界面上那个 `node_${sequence}` 是本地序号，
        // 应用一重启就从 1 重新数 → 必然撞上上次会话建的界面，录着录着把老界面"换了脸"。
        allocateNodeId: draft.targetMode === 'new',
        asEnter: draft.asEnter,
        asActionTarget: draft.asActionTarget,
        search: draft.search,
      };
      const result = await withDeviceSession(deviceId, () =>
        isOcr
          ? recordOcrRpc({
              ...shared,
              text: (draft.text ?? '').trim(),
              mode: draft.ocrMode ?? 'contains',
              threshold: draft.threshold,
            })
          : recordTemplateRpc({ ...shared, threshold: draft.threshold }),
      );
      // 重新录同一张模板时是同名同路径、内容变了：必须清缓存，否则界面还在显示旧截图
      clearTemplateCache([result.label]);
      applyWorkflowGraph(deviceId, result.graph, get().frames[deviceId], { applyStructure: true });
      const pendingFlowStep = useUiStore.getState().pendingFlowRecStepId;
      const pendingFlowSlot = useUiStore.getState().pendingFlowRecSlot;
      if (pendingFlowStep) {
        const steps = useGraphStore.getState().graphs[WORKFLOW_SCOPE]?.flow?.steps ?? [];
        const targetStep = steps.find((step) => step.id === pendingFlowStep);
        if (targetStep) {
          if (targetStep.type === 'cond') {
            const currentParams = targetStep.params ?? {};
            const groups = condGroupsFromParams(currentParams).map((group) => ({
              all: [...group.all],
            }));
            const gIdx = pendingFlowSlot?.groupIndex ?? 0;
            const rIdx = pendingFlowSlot?.rowIndex ?? 0;
            while (groups.length <= gIdx) {
              groups.push({ all: [''] });
            }
            const group = groups[gIdx]!;
            while (group.all.length <= rIdx) {
              group.all.push('');
            }
            group.all[rIdx] = result.label;
            await useGraphStore.getState().updateFlowStep(pendingFlowStep, {
              params: { ...currentParams, ...condParamsFromGroups(groups) },
            });
          } else {
            await useGraphStore.getState().updateFlowStep(pendingFlowStep, {
              params: { ...(targetStep.params ?? {}), by: '识别器', rec: result.label },
            });
          }
          useGraphStore.getState().selectNode(pendingFlowStep);
        }
        useUiStore.getState().clearPendingFlowRecStep();
      } else if (result.nodeId) {
        // 新建界面时 id 是引擎分配的：录完就把它选中，用户能立刻在画布/详情里看到"录到哪个界面上了"
        useGraphStore.getState().selectNode(result.nodeId);
      }
      useEventStore.getState().append(deviceId, 'recognizer_added', {
        message:
          `+${result.label} (${result.mode}${result.search === 'full' ? '·全屏' : ''})` +
          (result.template ? ` → ${result.template}` : ''),
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

  setRecognizerSearch: async (deviceId, label, search) => {
    try {
      await setRecognizerSearchRpc(deviceId, label, search);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 引擎是旧进程时没有 recognizer.search：界面上已经乐观切过去了，
      // 必须回滚 —— 否则用户看到「全屏」，引擎却还按原区域搜，滚动后只会显示未命中。
      useGraphStore.getState().updateRecognizerSearch(deviceId, label, search === 'full' ? 'region' : 'full');
      set({
        error: isUnknownMethodError(message) ? staleEngineHint(['recognizer.search']) : message,
      });
    }
  },

  renameRecognizer: async (deviceId, label, to) => {
    try {
      const result = await renameRecognizerRpc(deviceId, label, to);
      // 引擎把改完的整张图返回来了（引用都改好了）：直接换掉本地图，别自己拼
      applyWorkflowGraph(deviceId, result.graph, get().frames[deviceId], { applyStructure: true });
      const flowSteps = 'flowSteps' in result.refs ? Number(result.refs.flowSteps) : 0;
      const changed = result.refs.nodes + result.refs.edges + result.refs.scores + flowSteps;
      useEventStore.getState().append(deviceId, 'recognizer_renamed', {
        node: label,
        message:
          `${result.from} → ${result.to}` +
          (changed > 0
            ? `（顺带更新 ${result.refs.nodes} 个界面 / ${result.refs.edges} 条边 / ${flowSteps} 个模块 / ${result.refs.scores} 处 $score 引用）`
            : '（没有被引用，只改了名字）'),
      });
      return { refs: result.refs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      useEventStore.getState().append(deviceId, 'error', { message: `改名失败: ${message}` });
      return null;
    }
  },

  removeRecognizer: async (deviceId, label) => {
    try {
      const result = await removeRecognizerRpc(deviceId, label);
      applyWorkflowGraph(deviceId, result.graph, get().frames[deviceId], { applyStructure: true });
      useEventStore.getState().append(deviceId, 'recognizer_removed', {
        node: label,
        message: `-${label}（模板文件一起删了）`,
      });
      return true;
    } catch (error) {
      // 被节点/边引用时引擎会拒绝并说清被谁用了 —— 那句话必须让用户看见（错误条 + 事件栏），
      // 只写日志的话表现就是"点了删除没反应"
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      useEventStore.getState().append(deviceId, 'error', { message: `删除失败: ${message}` });
      return false;
    }
  },

  isReady: (deviceId) => Boolean(get().ready[deviceId]),

  adoptLiveDevices: () => {
    // 引擎的会话还活着就是连着（界面重载/重启后前端状态是空的，但帧照推）
    const live = connectedDevices(useDeviceStore.getState().devices);
    if (live.length === 0) {
      return;
    }
    set((current) => {
      const ready = { ...current.ready };
      for (const device of live) {
        ready[device.id] = true;
      }
      return { ready };
    });
    for (const device of live) {
      applyStreamPolicy(device.id, PREVIEW_FPS); // 连接即要画面（同 connect）
    }
  },

  clearError: () => set({ error: null }),

  resetForEngineRestart: () => {
    for (const deviceId of [...framePollers.keys()]) stopFramePolling(deviceId);
    streamPolicy.clear();
    workflowSwitchDepth = 0;
    set({
      ready: {},
      frames: {},
      links: {},
      running: {},
      runningWorkflowRoots: {},
      loopProgress: {},
      connectingPhase: {},
      error: null,
      switchingWorkflow: false,
      switchingWorkflowRoot: '',
      holdRunningDuringSwitch: false,
    });
  },

  setStreamPolicy: (deviceId, fps) => applyStreamPolicy(deviceId, fps),

  recordStep: async (deviceId, action) => {
    if (!get().ready[deviceId]) {
      set({ error: '设备未连接：录操作需要先连上设备（否则不知道该录到哪个界面）' });
      return null;
    }
    // 录下来的边要落进当前工作流：没有就先指路
    if (!get().currentWorkflow?.root) {
      set({ error: '还没有工作流：先在右栏「工作区」新建一个工作流' });
      return null;
    }
    try {
      const result = await withDeviceSession(deviceId, () => recordAction(deviceId, action));
      useGraphStore
        .getState()
        .setGraph(deviceId, toGraphData(deviceId, result.graph, get().frames[deviceId]), result.graph, {
          applyStructure: true,
        });
      const stepId = result.stepId ?? result.edgeId;
      if (stepId) {
        useGraphStore.getState().selectNode(stepId);
      }
      devLog(`录制模块 ${stepId}: ${String(action.type)}`);
      return stepId ?? null;
    } catch (error) {
      set({ error: `录制失败: ${error instanceof Error ? error.message : String(error)}` });
      return null;
    }
  },

  refreshCurrentWorkflow: async () => {
    try {
      set({ currentWorkflow: await projectGet(), error: null });
      await get().syncCurrentWorkflow();
    } catch (error) {
      devLog(`project.get 失败: ${String(error)}`);
    }
  },

  switchWorkflow: async (dir) => {
    get().enterWorkflowSwitch(dir);
    try {
      const { useLibraryStore } = await import('@/stores/library.store');
      const key = workflowRootKey(dir);
      let known = useLibraryStore.getState().workflows.some((item) => workflowRootKey(item.root) === key);
      if (!known) {
        await useLibraryStore.getState().refresh();
        known = useLibraryStore.getState().workflows.some((item) => workflowRootKey(item.root) === key);
      }
      if (!known) {
        useUiStore.getState().closeWorkflowTab(dir);
        set({ error: '这个工作流已被删除或不存在，标签已关闭' });
        return;
      }
      useGraphStore.getState().cacheActiveWorkflowSnapshot();
      useUiStore.setState({ recordActionMode: false, draft: null });
      useUiStore.getState().openWorkflowTab(dir);
      await projectSet(dir);
      await get().syncCurrentWorkflow();
      set({ error: null });
    } catch (error) {
      set({ error: `切换工作流失败: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      get().leaveWorkflowSwitch();
    }
  },

  syncCurrentWorkflow: async () => {
    try {
      const info = await projectGet();
      setPositionScope(info.root);
      setActiveWorkflowRoot(info.root);
      clearTemplateCache();
      set({ currentWorkflow: info, error: null });
      if (!info.root) {
        useGraphStore.getState().clearWorkflowGraph();
        useGraphStore.getState().clearDeviceLive();
        return;
      }
      const graph = await graphGet();
      useGraphStore.getState().clearDeviceLive();
      applyWorkflowGraph(WORKFLOW_SCOPE, graph);
      for (const deviceId of Object.keys(get().ready)) {
        if (!get().ready[deviceId]) {
          continue;
        }
        const frame = get().frames[deviceId];
        if (frame) {
          useGraphStore.getState().updateLive(deviceId, {
            node: frame.node,
            pending: frame.pending,
            detections: frame.detections,
          });
        }
      }
    } catch (error) {
      set({ error: `读取工作流失败: ${error instanceof Error ? error.message : String(error)}` });
    }
  },

  touch: (deviceId, phase, x, y) => {
    if (!get().ready[deviceId]) {
      if (phase === 'down') {
        set({ error: '设备未连接：先在设备面板连接一台，再操作画面' });
      }
      return Promise.resolve(false);
    }
    return queueManualInput(
      deviceId,
      phase,
      () => withDeviceSession(deviceId, () => deviceTouch(deviceId, phase, x, y)),
      (error: unknown) => {
        if (phase !== 'move') {
          set({ error: `触控失败: ${error instanceof Error ? error.message : String(error)}` });
        }
      },
    );
  },

  tap: async (deviceId, x, y) => {
    if (!get().ready[deviceId]) {
      set({ error: '设备未连接：先在设备面板连接一台，再操作画面' });
      return;
    }
    try {
      await withDeviceSession(deviceId, () => deviceTap(deviceId, x, y));
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
      await withDeviceSession(deviceId, () => deviceSwipe(deviceId, x1, y1, x2, y2, durationMs));
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
      await withDeviceSession(deviceId, () => deviceKey(deviceId, key));
      if (useUiStore.getState().recordActionMode)
        await get().recordStep(deviceId, { type: 'key', value: key });
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
