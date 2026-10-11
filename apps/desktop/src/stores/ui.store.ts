/**
 * UI store：录制状态机 + 弹层/布局等跨面板的界面状态。
 *
 * 录制是「手感」的核心（DESIGN.md §4.4），流程写在这里而不是散在组件里：
 *   off ──点录制──▶ marquee / pick ──框选或点选──▶ draft ──确认──▶ 写入 graph + 事件 ──▶ 回到 marquee
 *                                        └──取消（Esc）──┘
 */
import { create } from 'zustand';

import { useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { useSessionStore } from '@/stores/session.store';
import type { DeviceTabId } from '@/features/device/device-kinds';
import type { DockTab, RecordDraft, RecordMode, RightTab } from '@/types';

const DEFAULT_THRESHOLD = 0.82;

/**
 * 识别读数列表的筛选：
 * - `all`：全部识别器（默认，和以前一样）
 * - `hit`：只看这一帧命中的（`state !== 'idle'`）—— 识别器一多，"谁在命中"才是有用的信息
 */
export type ReadoutFilter = 'all' | 'hit';

/**
 * 状态图节点大小：画布上的卡片尺寸档位（小/中/大）。
 *
 * 用户反馈"节点能放大么" —— 卡片里塞了模板缩略图和引脚，默认尺寸在 1080p 下偏小。
 * 写进 ui store 并落 localStorage：这是个人的阅读偏好，重启后应当保持。
 */
export type NodeScale = 'sm' | 'md' | 'lg';

export const NODE_SCALES: readonly NodeScale[] = ['sm', 'md', 'lg'];

const NODE_SCALE_KEY = 'gamepilot.node-scale';

function loadNodeScale(): NodeScale {
  try {
    const raw = window.localStorage.getItem(NODE_SCALE_KEY);
    return raw === 'sm' || raw === 'md' || raw === 'lg' ? raw : 'md';
  } catch {
    return 'md';
  }
}

/** 中间区域打开过的状态图：只记绝对路径；读不出来就当没开过（不拦启动）。 */
const OPEN_GRAPHS_KEY = 'gamepilot.open-graphs';

function loadOpenGraphs(): string[] {
  try {
    const raw = window.localStorage.getItem(OPEN_GRAPHS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function saveOpenGraphs(roots: readonly string[]): void {
  try {
    window.localStorage.setItem(OPEN_GRAPHS_KEY, JSON.stringify(roots));
  } catch {
    // 记不住就算了，本次会话内照常生效
  }
}

interface UiState {
  readonly recordMode: RecordMode;
  readonly draft: RecordDraft | null;
  readonly devicePopoverOpen: boolean;
  /** 设备弹层选中的分类（上次选哪类，下次打开还在那类） */
  readonly deviceTab: DeviceTabId;
  readonly rightTab: RightTab;
  /** 底部调试抽屉：当前 Tab + 是否展开（点同一个 Tab = 收起） */
  readonly dockTab: DockTab;
  readonly dockOpen: boolean;
  readonly sequence: number;
  readonly setRecordMode: (mode: RecordMode) => void;
  readonly toggleRecording: () => void;
  /** 控制模式：开启后画面栏的鼠标操作会直接作用于设备（scrcpy 那样） */
  readonly controlMode: boolean;
  readonly toggleControl: () => void;
  /** 录操作：把画面上的每次点击/滑动录成脚本里的一步 */
  readonly recordActionMode: boolean;
  readonly toggleRecordAction: () => void;
  /** 画面栏「识别读数」列表的筛选：全部（默认）/ 只看命中的 */
  readonly readoutFilter: ReadoutFilter;
  readonly setReadoutFilter: (filter: ReadoutFilter) => void;
  /** 画布节点卡片尺寸（小/中/大） */
  readonly nodeScale: NodeScale;
  readonly setNodeScale: (scale: NodeScale) => void;
  /** 画面栏下半格（识别读数）是否展开：收起时只留一行标题，画面拿走全部高度 */
  readonly readoutOpen: boolean;
  /**
   * 中间区域打开过的状态图（IDE 式标签，绝对路径，按打开顺序）。
   *
   * 引擎同一时刻只加载一个任务目录（`switchProject` 会热重载所有设备的状态图），
   * 所以"多标签"= 记住开过哪几张 + 点哪张就切哪张；关标签只从这份列表里移除，
   * **不删文件、也不动引擎的当前目录**（关掉的那个正好是当前图时由 GraphTabs 切到相邻的）。
   * 落 localStorage：重启后上午开着的那几张还在。
   */
  readonly openGraphs: readonly string[];
  /** 打开一张状态图（已经在列表里就只激活，不重复加） */
  readonly openGraph: (root: string) => void;
  /** 关掉一个标签（只关界面） */
  readonly closeGraph: (root: string) => void;
  /** 面板尺寸跟着它走（`Panel` 的 collapse/expand，见 ScreenPane） */
  readonly setReadoutOpen: (open: boolean) => void;
  readonly toggleDevicePopover: (open?: boolean) => void;
  readonly setDeviceTab: (tab: DeviceTabId) => void;
  readonly setRightTab: (tab: RightTab) => void;
  readonly toggleDock: (tab: DockTab) => void;
  readonly closeDock: () => void;
  readonly beginDraft: (input: { rect: readonly [number, number, number, number]; score: number }) => void;
  readonly updateDraft: (patch: Partial<RecordDraft>) => void;
  readonly cancelDraft: () => void;
  /** 确认草稿：一次交互内同时落 识别器 + 节点 + 边，并写事件（可撤销的原子操作） */
  readonly commitDraft: () => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  recordMode: 'off',
  controlMode: true,
  recordActionMode: false,
  readoutFilter: 'all',
  nodeScale: loadNodeScale(),
  readoutOpen: true,
  openGraphs: loadOpenGraphs(),
  draft: null,
  devicePopoverOpen: false,
  deviceTab: 'all',
  rightTab: 'library',
  dockTab: 'events',
  dockOpen: false,
  sequence: 1,

  setRecordMode: (mode) => set({ recordMode: mode, draft: mode === 'off' ? null : get().draft }),
  toggleRecording: () =>
    set((state) => ({ recordMode: state.recordMode === 'off' ? 'marquee' : 'off', draft: null })),
  toggleControl: () => set((state) => ({ controlMode: !state.controlMode })),
  toggleRecordAction: () => set((state) => ({ recordActionMode: !state.recordActionMode })),
  setReadoutFilter: (readoutFilter) => set({ readoutFilter }),
  setNodeScale: (nodeScale) => {
    try {
      window.localStorage.setItem(NODE_SCALE_KEY, nodeScale);
    } catch {
      // 记不住就算了，本次会话内照常生效
    }
    set({ nodeScale });
  },
  setReadoutOpen: (readoutOpen) => set({ readoutOpen }),
  openGraph: (root) =>
    set((state) => {
      if (!root || state.openGraphs.includes(root)) {
        return state; // 已经开着：只激活，不重排（IDE 里点资源管理器也不会把标签挪位置）
      }
      const openGraphs = [...state.openGraphs, root];
      saveOpenGraphs(openGraphs);
      return { openGraphs };
    }),
  closeGraph: (root) =>
    set((state) => {
      if (!state.openGraphs.includes(root)) {
        return state;
      }
      const openGraphs = state.openGraphs.filter((item) => item !== root);
      saveOpenGraphs(openGraphs);
      return { openGraphs };
    }),
  toggleDevicePopover: (open) => set((state) => ({ devicePopoverOpen: open ?? !state.devicePopoverOpen })),
  setDeviceTab: (deviceTab) => set({ deviceTab }),
  setRightTab: (rightTab) => set({ rightTab }),
  toggleDock: (tab) =>
    set((state) =>
      state.dockOpen && state.dockTab === tab ? { dockOpen: false } : { dockTab: tab, dockOpen: true },
    ),
  closeDock: () => set({ dockOpen: false }),

  beginDraft: ({ rect, score }) => {
    const sequence = get().sequence;
    set({
      sequence: sequence + 1,
      draft: {
        // 草稿跟着**当前**设备走：之后用户在多开网格里切到别的格子，
        // 确认时也仍然写进这一台的状态图（见 RecordDraft.deviceId 注释）
        deviceId: useDeviceStore.getState().activeId || undefined,
        rect,
        label: '',
        threshold: DEFAULT_THRESHOLD,
        score,
        asEnter: true,
        asActionTarget: true,
        targetMode: 'new',
        targetNodeId: null,
        newNodeName: '新界面',
        /*
         * 这个 id 只在界面里用（草稿上的占位/临时素材名），**不是**最终节点 id：
         * 序号每次开会话从 1 重数，落库时会撞上老界面，所以「新建」走
         * `allocateNodeId`，由引擎分配真实 id（见 session.store.record）。
         */
        newNodeId: `node_${sequence}`,
      },
    });
  },

  updateDraft: (patch) => set((state) => (state.draft ? { draft: { ...state.draft, ...patch } } : state)),

  cancelDraft: () => set({ draft: null }),

  commitDraft: () => {
    const { draft } = get();
    // 落盘目标是**草稿自己的设备**（录制时记下的那台），不是"现在界面看的那台"：
    // 多开时框完再点别的格子看一眼是常规操作，用 activeId 就会写错图
    const deviceId = draft?.deviceId || useDeviceStore.getState().activeId;
    if (!draft || !deviceId) {
      return;
    }
    // 录制需要真实画面：没连设备就明确告诉用户，而不是偷偷改本地假数据
    if (!useSessionStore.getState().isReady(deviceId)) {
      useEventStore.getState().append(deviceId, 'error', {
        message: '录制需要先连接设备：顶栏「未连接设备」→ 选择设备 → 连接',
      });
      return;
    }
    void useSessionStore.getState().record(deviceId, draft);
    set({ draft: null });
  },
}));
