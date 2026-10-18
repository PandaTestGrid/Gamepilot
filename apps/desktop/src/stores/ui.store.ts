/**
 * UI store：录制状态机 + 弹层/布局等跨面板的界面状态。
 *
 * 录制是「手感」的核心（DESIGN.md §4.4），流程写在这里而不是散在组件里：
 *   off ──点录制──▶ marquee / pick ──框选或点选──▶ draft ──确认──▶ 写入 graph + 事件 ──▶ 回到 marquee
 *                                        └──取消（Esc / 点到画面外）──┘
 */
import { create } from 'zustand';

import { clearStoredPositions, storeStepPositions } from '@/lib/node-positions';
import { gridPositionsForSteps } from '@/features/graph/flow/flow-layout';
import { flowNodeSizeLookup, measureFlowNodesFromDom } from '@/features/graph/flow/flow-node-size';
import { useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { SCRIPT_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import type { DeviceTabId } from '@/features/device/device-kinds';
import type { DockTab, RecordDraft, RecordMode, RightTab } from '@/types';

const DEFAULT_THRESHOLD = 0.82;
/** OCR 的默认置信度阈值：文字识别的分数整体偏低，0.82 会几乎永远不命中 */
const OCR_DEFAULT_THRESHOLD = 0.6;

/** 录制要落盘进当前工作流（模板 → `templates/`、识别器与边 → `graph.json`）。 */
const NO_WORKFLOW_HINT = '还没有工作流：先在左栏新建一个工作流';

/** 当前工作流目录；空串 = 没选工作流。 */
function currentWorkflowRoot(): string {
  return useSessionStore.getState().currentWorkflow?.root ?? '';
}

function noWorkflowHint(): void {
  useSessionStore.setState({ error: NO_WORKFLOW_HINT });
}

/**
 * 素材区列表的筛选：
 * - `all`：全部识别器（默认，和以前一样）
 * - `hit`：只看这一帧命中的（`state !== 'idle'`）—— 识别器一多，"谁在命中"才是有用的信息
 */
export type MaterialFilter = 'all' | 'hit';

/**
 * 滑动录制方式（`SwipeStepFields` 顶部「方式」选择框；点对点只显示单次按钮，连续只显示连续按钮）：
 * - `single` = 单次滑动：起止点 + 时长，直线，不写轨迹；
 * - `track` = 连续滑动：额外记轨迹（弯线）与末端按住（推摇杆）。
 */
export type SwipeRecordMode = 'single' | 'track';

/**
 * 状态图节点大小：画布上的卡片尺寸档位（小/中/大）。
 *
 * 偏好存 ui store + localStorage。
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

const OPEN_WORKFLOW_TABS_KEY = 'gamepilot.open-workflow-tabs';
const LEGACY_OPEN_GRAPHS_KEY = 'gamepilot.open-graphs';

function loadOpenWorkflowTabs(): string[] {
  try {
    const raw =
      window.localStorage.getItem(OPEN_WORKFLOW_TABS_KEY) ??
      window.localStorage.getItem(LEGACY_OPEN_GRAPHS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function saveOpenWorkflowTabs(roots: readonly string[]): void {
  try {
    window.localStorage.setItem(OPEN_WORKFLOW_TABS_KEY, JSON.stringify(roots));
  } catch {
    // 记不住就算了，本次会话内照常生效
  }
}

/** 工作流目录比较用（Windows 斜杠 / 大小写 / 尾部分隔符）。 */
export function workflowRootKey(value: string): string {
  return value
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

export function workflowRootInList(roots: readonly string[] | undefined, root: string): boolean {
  const key = workflowRootKey(root);
  if (!key) {
    return false;
  }
  return (roots ?? []).some((item) => workflowRootKey(item) === key);
}

export function withWorkflowRoot(
  roots: readonly string[] | undefined,
  root: string,
  present: boolean,
): string[] {
  if (present) {
    if (!workflowRootKey(root) || workflowRootInList(roots, root)) {
      return [...(roots ?? [])];
    }
    return [...(roots ?? []), root];
  }
  return (roots ?? []).filter((item) => workflowRootKey(item) !== workflowRootKey(root));
}

interface UiState {
  readonly recordMode: RecordMode;
  /**
   * 这一轮框选要产出的识别器种类：普通框选/点选是 `template`（图像匹配）；
   * 从「文字识别」入口进来是 `ocr` —— 框出来的草稿会换成 OCR 表单（`OcrRecognizerDialog`）。
   * 两种识别器的交互（拖框、四角缩放、Esc 取消）完全一样，只有表单字段不同。
   */
  readonly recordKind: 'template' | 'ocr';
  readonly draft: RecordDraft | null;
  readonly devicePopoverOpen: boolean;
  /** 设备弹层选中的分类（上次选哪类，下次打开还在那类） */
  readonly deviceTab: DeviceTabId;
  readonly rightTab: RightTab;
  /** 底部调试抽屉：当前 Tab + 是否展开（点同一个 Tab = 收起） */
  readonly dockTab: DockTab;
  readonly dockOpen: boolean;
  readonly sequence: number;
  /**
   * 点选录制时的正方形边长（**设备像素**，默认 120，范围 32~320）。
   * 归一化 w/h 由草稿里的 `resolution` 换算：w = px / 宽，h = px / 高 ——
   * 这样在竖屏上也是真正的像素正方形，而不是归一化正方形（会变成细长条）。
   */
  readonly pickSize: number;
  readonly setPickSize: (size: number) => void;
  readonly setRecordMode: (mode: RecordMode) => void;
  readonly toggleRecording: () => void;
  /** 控制模式：开启后画面栏的鼠标操作会直接作用于设备（scrcpy 那样） */
  readonly controlMode: boolean;
  readonly toggleControl: () => void;
  /** 录操作：把画面上的每次点击/滑动录成工作流里的一步 */
  readonly recordActionMode: boolean;
  readonly toggleRecordAction: () => void;
  /**
   * 关掉框选 / 点选 / 录操作（以及未确认草稿、模块上的点选/框选/滑动录制）。
   * 点到画面和工具栏以外、或按 Esc 时走这里。
   */
  readonly cancelCaptureTools: () => void;
  /** 画面栏「素材区」列表的筛选：全部（默认）/ 只看命中的 */
  readonly materialFilter: MaterialFilter;
  readonly setMaterialFilter: (filter: MaterialFilter) => void;
  /** 画布节点卡片尺寸（小/中/大） */
  readonly nodeScale: NodeScale;
  readonly setNodeScale: (scale: NodeScale) => void;
  /** 画面栏下半格（素材区）是否展开：收起时只留一行标题，画面拿走全部高度 */
  readonly materialOpen: boolean;
  /**
   * 中间栏打开过的工作流（IDE 式标签，绝对路径，按打开顺序）。
   * 引擎同一时刻只加载一个工作流（`switchWorkflow`）；关标签不删文件。
   */
  readonly openWorkflowTabs: readonly string[];
  readonly pruneOpenWorkflowTabs: (keepRoots: readonly string[]) => void;
  /** 工作区/工作流都没了时清空标签（含 localStorage），避免只剩历史 Tab。 */
  readonly clearOpenWorkflowTabs: () => void;
  readonly renameOpenWorkflowTab: (fromRoot: string, toRoot: string) => void;
  readonly openWorkflowTab: (root: string) => void;
  readonly closeWorkflowTab: (root: string) => void;
  /** 左右并排两个打开的工作流（副栏为快照，引擎仍只加载当前目录） */
  readonly workflowSplitOpen: boolean;
  readonly toggleWorkflowSplit: () => void;
  /** 工作流画布「重新布局」：清 localStorage 摆位并让 FlowCanvas 回到默认网格 */
  readonly flowRelayoutGeneration: number;
  readonly relayoutFlowCanvas: () => void;
  /** 面板尺寸跟着它走（`Panel` 的 collapse/expand，见 ScreenPane） */
  readonly setMaterialOpen: (open: boolean) => void;
  /** 左侧栏（画面栏）、工作流下方控制台/配置抽屉、右侧栏（工作区/识别器）的展开/收起状态 */
  readonly leftPaneOpen: boolean;
  readonly flowDockOpen: boolean;
  readonly flowDockTab: 'config' | 'console';
  readonly rightPaneOpen: boolean;
  /** 画布右侧弹出的「工作流全局配置」抽屉 */
  readonly flowGlobalSettingsOpen: boolean;
  readonly setLeftPaneOpen: (open: boolean) => void;
  readonly setFlowDockOpen: (open: boolean) => void;
  readonly setFlowDockTab: (tab: 'config' | 'console') => void;
  readonly openFlowConfig: () => void;
  readonly setRightPaneOpen: (open: boolean) => void;
  readonly setFlowGlobalSettingsOpen: (open: boolean) => void;
  readonly toggleFlowGlobalSettings: () => void;
  readonly toggleLeftPane: () => void;
  readonly toggleFlowDock: () => void;
  readonly toggleRightPane: () => void;
  /** 录制完成后把新识别器写入该 flow 步骤的 `params.rec`（或条件模块的指定条件槽位） */
  readonly pendingFlowRecStepId: string | null;
  readonly pendingFlowRecSlot: { readonly groupIndex: number; readonly rowIndex: number } | null;
  readonly beginRecordRecognizerForFlowStep: (
    stepId: string,
    slot?: { readonly groupIndex: number; readonly rowIndex: number },
  ) => void;
  /**
   * 新建「文字识别」识别器：进入框选态，并让接下来的草稿使用 OCR 表单。
   *
   * 传 `stepId`/`slot` 时，保存后识别器自动填进该步骤的条件槽位 ——
   * 与「录制模板」走同一套 `pendingFlowRec*`，只是录的是 `record.ocr`。
   */
  readonly beginOcrRecognizerCapture: (options?: {
    readonly stepId?: string;
    readonly slot?: { readonly groupIndex: number; readonly rowIndex: number };
  }) => void;
  readonly clearPendingFlowRecStep: () => void;
  /** 在画面栏框选点击随机范围（写入 flow 步骤的 rect） */
  readonly pendingFlowClickRegionStepId: string | null;
  readonly beginPickClickRegionForFlowStep: (stepId: string) => void;
  readonly clearPendingFlowClickRegionStep: () => void;
  /** 在画面栏点选点击坐标（写入 flow 步骤的 x/y） */
  readonly pendingFlowClickCoordStepId: string | null;
  readonly beginPickClickCoordForFlowStep: (stepId: string) => void;
  readonly clearPendingFlowClickCoordStep: () => void;
  /** 在画面栏拖出滑动轨迹（写入 flow 滑动步骤的起止坐标与时长） */
  readonly pendingFlowSwipeStepId: string | null;
  /**
   * 滑动录制方式：
   * - `single`：只管起止点 + 时长（直线，最常用，graph.json 不会变长）
   * - `track`：额外记轨迹（连续滑动）与末端按住（推摇杆）
   */
  readonly pendingFlowSwipeMode: SwipeRecordMode;
  readonly beginRecordSwipeForFlowStep: (stepId: string, mode?: SwipeRecordMode) => void;
  readonly clearPendingFlowSwipeStep: () => void;
  readonly toggleDevicePopover: (open?: boolean) => void;
  readonly setDeviceTab: (tab: DeviceTabId) => void;
  readonly setRightTab: (tab: RightTab) => void;
  readonly toggleDock: (tab: DockTab) => void;
  readonly closeDock: () => void;
  readonly beginDraft: (input: {
    rect: readonly [number, number, number, number];
    score: number;
    mode?: 'marquee' | 'pick';
    pickCenter?: readonly [number, number];
    /** 点选草稿的设备像素分辨率（用来在改大小时保持像素正方形） */
    resolution?: readonly [number, number];
    label?: string;
    /**
     * 覆盖这枚草稿的识别器种类（默认取 `recordKind`）。
     * 画面栏 OCR 扫描后点文字框走这里：直接开 OCR 表单并带上读到的字。
     */
    kind?: 'template' | 'ocr';
    /** kind=ocr 的初始「要识别的文字」 */
    text?: string;
  }) => void;
  readonly updateDraft: (patch: Partial<RecordDraft>) => void;
  readonly cancelDraft: () => void;
  /** 确认草稿：一次交互内同时落 识别器 + 节点 + 边，并写事件（可撤销的原子操作） */
  readonly commitDraft: () => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  recordMode: 'off',
  recordKind: 'template',
  pickSize: 120,
  controlMode: true,
  recordActionMode: false,
  materialFilter: 'all',
  nodeScale: loadNodeScale(),
  materialOpen: true,
  leftPaneOpen: true,
  flowDockOpen: false,
  flowDockTab: 'config',
  rightPaneOpen: true,
  flowGlobalSettingsOpen: false,
  openWorkflowTabs: loadOpenWorkflowTabs(),
  workflowSplitOpen: false,
  flowRelayoutGeneration: 0,
  pendingFlowRecStepId: null,
  pendingFlowRecSlot: null,
  pendingFlowClickRegionStepId: null,
  pendingFlowClickCoordStepId: null,
  pendingFlowSwipeStepId: null,
  pendingFlowSwipeMode: 'track',

  clearPendingFlowRecStep: () => set({ pendingFlowRecStepId: null, pendingFlowRecSlot: null }),

  clearPendingFlowClickRegionStep: () => set({ pendingFlowClickRegionStepId: null }),

  clearPendingFlowClickCoordStep: () => set({ pendingFlowClickCoordStepId: null }),

  clearPendingFlowSwipeStep: () => set({ pendingFlowSwipeStepId: null, pendingFlowSwipeMode: 'track' }),

  beginPickClickRegionForFlowStep: (stepId) => {
    if (!currentWorkflowRoot()) {
      noWorkflowHint();
      return;
    }
    const activeId = useDeviceStore.getState().activeId;
    if (!activeId || !useSessionStore.getState().isReady(activeId)) {
      useSessionStore.setState({
        error: '框选范围需先连接设备：顶部 ＋ → 选设备 → 连接，再到画面栏拖框',
      });
      set({ devicePopoverOpen: true });
      return;
    }
    set({
      pendingFlowClickRegionStepId: stepId,
      pendingFlowClickCoordStepId: null,
      pendingFlowSwipeStepId: null,
      pendingFlowRecStepId: null,
      pendingFlowRecSlot: null,
      recordMode: 'marquee',
      recordActionMode: false,
      draft: null,
      materialOpen: true,
      // 要从画面栏拖/框/点：左栏收着的话用户会以为按钮没反应
      leftPaneOpen: true,
    });
    useGraphStore.getState().selectNode(stepId);
    useSessionStore.setState({ error: null });
    useEventStore.getState().append(activeId, 'action_executed', {
      message: '框选随机点击范围：在画面栏拖出一个矩形，松手即写入本模块',
    });
  },

  beginPickClickCoordForFlowStep: (stepId) => {
    if (!currentWorkflowRoot()) {
      noWorkflowHint();
      return;
    }
    const activeId = useDeviceStore.getState().activeId;
    if (!activeId || !useSessionStore.getState().isReady(activeId)) {
      useSessionStore.setState({
        error: '点选坐标需先连接设备：顶部 ＋ → 选设备 → 连接，再到画面栏单击落点',
      });
      set({ devicePopoverOpen: true });
      return;
    }
    set({
      pendingFlowClickCoordStepId: stepId,
      pendingFlowClickRegionStepId: null,
      pendingFlowSwipeStepId: null,
      pendingFlowRecStepId: null,
      pendingFlowRecSlot: null,
      recordMode: 'pick',
      recordActionMode: false,
      draft: null,
      materialOpen: true,
      // 要从画面栏拖/框/点：左栏收着的话用户会以为按钮没反应
      leftPaneOpen: true,
    });
    useGraphStore.getState().selectNode(stepId);
    useSessionStore.setState({ error: null });
    useEventStore.getState().append(activeId, 'action_executed', {
      message: '点选点击坐标：在画面栏单击一次，落点即写入本模块',
    });
  },

  beginRecordSwipeForFlowStep: (stepId, mode = 'track') => {
    if (!currentWorkflowRoot()) {
      noWorkflowHint();
      return;
    }
    const activeId = useDeviceStore.getState().activeId;
    if (!activeId || !useSessionStore.getState().isReady(activeId)) {
      useSessionStore.setState({
        error: '录制滑动需先连接设备：顶部 ＋ → 选设备 → 连接，再到画面栏拖出滑动',
      });
      set({ devicePopoverOpen: true });
      return;
    }
    set({
      pendingFlowSwipeStepId: stepId,
      pendingFlowSwipeMode: mode,
      pendingFlowClickRegionStepId: null,
      pendingFlowClickCoordStepId: null,
      pendingFlowRecStepId: null,
      pendingFlowRecSlot: null,
      recordMode: 'off',
      recordActionMode: false,
      controlMode: true,
      draft: null,
      materialOpen: true,
      // 要从画面栏拖/框/点：左栏收着的话用户会以为按钮没反应
      leftPaneOpen: true,
    });
    useGraphStore.getState().selectNode(stepId);
    useSessionStore.setState({ error: null });
    useEventStore.getState().append(activeId, 'action_executed', {
      message:
        mode === 'single'
          ? '录制单次滑动：在画面栏拖一下松手，只记起止点与时长（直线，轻点无效）'
          : '录制连续滑动：按住拖出弯线，松手写入轨迹；到终点先停 0.2 秒再松手 = 记成「按住」',
    });
  },

  beginRecordRecognizerForFlowStep: (stepId, slot) => {
    if (!currentWorkflowRoot()) {
      noWorkflowHint();
      return;
    }
    const activeId = useDeviceStore.getState().activeId;
    if (!activeId || !useSessionStore.getState().isReady(activeId)) {
      useSessionStore.setState({
        error: '录制图像需先连接设备：顶部 ＋ → 选设备 → 连接，再到画面栏框选区域',
      });
      set({ devicePopoverOpen: true });
      return;
    }
    set({
      pendingFlowRecStepId: stepId,
      pendingFlowRecSlot: slot ?? null,
      pendingFlowSwipeStepId: null,
      recordKind: 'template',
      recordMode: 'marquee',
      recordActionMode: false,
      materialOpen: true,
      // 要从画面栏拖/框/点：左栏收着的话用户会以为按钮没反应
      leftPaneOpen: true,
    });
    useGraphStore.getState().selectNode(stepId);
    useSessionStore.setState({
      error: null,
    });
    useEventStore.getState().append(activeId, 'action_executed', {
      message: '录制点击目标：在画面栏拖框选 → 填名称 → 确定，将自动填入本模块',
    });
  },

  beginOcrRecognizerCapture: (options) => {
    if (!currentWorkflowRoot()) {
      noWorkflowHint();
      return;
    }
    const activeId = useDeviceStore.getState().activeId;
    if (!activeId || !useSessionStore.getState().isReady(activeId)) {
      useSessionStore.setState({
        error: '文字识别需先连接设备：顶部 ＋ → 选设备 → 连接，再到画面栏框出要读字的区域',
      });
      set({ devicePopoverOpen: true });
      return;
    }
    set({
      // 框出来的草稿交给 OCR 表单（RecordOverlay 只负责图像模板）
      recordKind: 'ocr',
      recordMode: 'marquee',
      recordActionMode: false,
      draft: null,
      pendingFlowRecStepId: options?.stepId ?? null,
      pendingFlowRecSlot: options?.slot ?? null,
      pendingFlowClickRegionStepId: null,
      pendingFlowClickCoordStepId: null,
      pendingFlowSwipeStepId: null,
      materialOpen: true,
      // 要从画面栏拖/框/点：左栏收着的话用户会以为按钮没反应
      leftPaneOpen: true,
    });
    if (options?.stepId) {
      useGraphStore.getState().selectNode(options.stepId);
    }
    useSessionStore.setState({ error: null });
    useEventStore.getState().append(activeId, 'action_executed', {
      message: '新建文字识别：在画面栏框出要读字的区域 → 填要识别的文字 → 保存',
    });
  },

  relayoutFlowCanvas: () => {
    clearStoredPositions();
    const steps = useGraphStore.getState().graphs[SCRIPT_SCOPE]?.flow?.steps ?? [];
    if (steps.length > 0) {
      // 按画布上卡片的真实高度排：条件卡片有几行条件就有多高，写死行距会压住下面的分支
      storeStepPositions(gridPositionsForSteps(steps, flowNodeSizeLookup(measureFlowNodesFromDom())));
    }
    set((state) => ({ flowRelayoutGeneration: state.flowRelayoutGeneration + 1 }));
  },

  toggleWorkflowSplit: () => {
    const current = currentWorkflowRoot();
    const state = get();
    if (state.workflowSplitOpen) {
      set({ workflowSplitOpen: false });
      return;
    }
    const peer = state.openWorkflowTabs.find((root) => root && root !== current);
    if (!peer) {
      useSessionStore.setState({ error: '再打开一个工作流标签才能左右分屏' });
      return;
    }
    useGraphStore.getState().cacheActiveWorkflowSnapshot();
    set({ workflowSplitOpen: true });
  },

  pruneOpenWorkflowTabs: (keepRoots) => {
    set((state) => {
      const keep = new Set(keepRoots.filter(Boolean).map(workflowRootKey));
      if (keep.size === 0) {
        return {};
      }
      // 只保留「仍在工作区树里」的工作流标签；不能按工作区根前缀保留，
      // 否则删了 hello 后标签还在，点一下 project.set 又会把目录建回来。
      const kept = state.openWorkflowTabs.filter((root) => keep.has(workflowRootKey(root)));
      if (kept.length === state.openWorkflowTabs.length) {
        return {};
      }
      saveOpenWorkflowTabs(kept);
      return { openWorkflowTabs: kept };
    });
  },
  clearOpenWorkflowTabs: () =>
    set((state) => {
      if (state.openWorkflowTabs.length === 0) {
        return state;
      }
      saveOpenWorkflowTabs([]);
      return { openWorkflowTabs: [], workflowSplitOpen: false };
    }),
  renameOpenWorkflowTab: (fromRoot, toRoot) =>
    set((state) => {
      if (!fromRoot || !toRoot) {
        return state;
      }
      const fromKey = workflowRootKey(fromRoot);
      const toKey = workflowRootKey(toRoot);
      if (!state.openWorkflowTabs.some((item) => workflowRootKey(item) === fromKey)) {
        return state;
      }
      const seen = new Set<string>();
      const openWorkflowTabs: string[] = [];
      for (const item of state.openWorkflowTabs) {
        const mapped = workflowRootKey(item) === fromKey ? toRoot : item;
        const key = workflowRootKey(mapped);
        if (!seen.has(key)) {
          seen.add(key);
          openWorkflowTabs.push(mapped);
        }
      }
      saveOpenWorkflowTabs(openWorkflowTabs);
      return { openWorkflowTabs: toKey ? openWorkflowTabs : state.openWorkflowTabs };
    }),
  draft: null,
  devicePopoverOpen: false,
  deviceTab: 'all',
  rightTab: 'library',
  dockTab: 'events',
  dockOpen: false,
  sequence: 1,

  setPickSize: (size) => {
    const clamped = Math.min(320, Math.max(32, Math.round(size)));
    set((state) => {
      const draft = state.draft;
      const resolution = draft?.resolution;
      if (draft?.mode === 'pick' && draft.pickCenter && resolution) {
        const [screenW, screenH] = resolution;
        if (screenW > 0 && screenH > 0) {
          // 像素正方形：宽高都取 clamped 像素，再各自归一化（竖屏不会变成细长条）
          const w = clamped / screenW;
          const h = clamped / screenH;
          const [cx, cy] = draft.pickCenter;
          const x = Math.min(Math.max(0, cx - w / 2), Math.max(0, 1 - w));
          const y = Math.min(Math.max(0, cy - h / 2), Math.max(0, 1 - h));
          return {
            pickSize: clamped,
            draft: { ...draft, rect: [x, y, w, h] },
          };
        }
      }
      return { pickSize: clamped };
    });
  },
  setRecordMode: (mode) => {
    // 没有当前工作流就不进录制（模板不知道往哪写）
    if (mode !== 'off' && !currentWorkflowRoot()) {
      noWorkflowHint();
      return;
    }
    set({
      recordMode: mode,
      // 手动切框选/点选 = 回到图像模板；文字识别走 beginOcrRecognizerCapture
      recordKind: 'template',
      // 框选/点选与录操作互斥：开启框选/点选时自动关闭录操作
      recordActionMode: mode !== 'off' ? false : get().recordActionMode,
      draft: mode === 'off' ? null : get().draft,
      pendingFlowRecStepId: mode === 'off' ? null : get().pendingFlowRecStepId,
      pendingFlowRecSlot: mode === 'off' ? null : get().pendingFlowRecSlot,
      pendingFlowClickRegionStepId: mode === 'off' ? null : get().pendingFlowClickRegionStepId,
      pendingFlowClickCoordStepId: mode === 'off' ? null : get().pendingFlowClickCoordStepId,
      pendingFlowSwipeStepId: mode === 'off' ? get().pendingFlowSwipeStepId : null,
    });
  },
  toggleRecording: () => {
    if (get().recordMode === 'off' && !currentWorkflowRoot()) {
      noWorkflowHint();
      return;
    }
    set((state) => ({
      recordMode: state.recordMode === 'off' ? 'marquee' : 'off',
      recordKind: 'template',
      recordActionMode: state.recordMode === 'off' ? false : state.recordActionMode,
      draft: null,
      pendingFlowRecStepId: state.recordMode === 'off' ? state.pendingFlowRecStepId : null,
      pendingFlowRecSlot: state.recordMode === 'off' ? state.pendingFlowRecSlot : null,
      pendingFlowClickRegionStepId: state.recordMode === 'off' ? state.pendingFlowClickRegionStepId : null,
      pendingFlowClickCoordStepId: state.recordMode === 'off' ? state.pendingFlowClickCoordStepId : null,
      pendingFlowSwipeStepId: state.recordMode === 'off' ? state.pendingFlowSwipeStepId : null,
    }));
  },
  toggleControl: () => set((state) => ({ controlMode: !state.controlMode })),
  toggleRecordAction: () => {
    // 录操作写的是工作流里的一条边，同样要先有当前工作流
    if (!get().recordActionMode && !currentWorkflowRoot()) {
      noWorkflowHint();
      return;
    }
    set((state) => {
      const next = !state.recordActionMode;
      // 录操作与框选/点选互斥：开启录操作时自动关闭框选/点选并清空未提交草稿
      return next
        ? {
            recordActionMode: true,
            recordMode: 'off',
            draft: null,
            pendingFlowRecStepId: null,
            pendingFlowRecSlot: null,
            pendingFlowClickRegionStepId: null,
            pendingFlowClickCoordStepId: null,
            pendingFlowSwipeStepId: null,
          }
        : { recordActionMode: false };
    });
  },
  cancelCaptureTools: () => {
    const state = get();
    if (
      state.recordMode === 'off' &&
      !state.recordActionMode &&
      !state.draft &&
      !state.pendingFlowRecStepId &&
      !state.pendingFlowClickRegionStepId &&
      !state.pendingFlowClickCoordStepId &&
      !state.pendingFlowSwipeStepId
    ) {
      return;
    }
    set({
      recordMode: 'off',
      recordActionMode: false,
      draft: null,
      pendingFlowRecStepId: null,
      pendingFlowRecSlot: null,
      pendingFlowClickRegionStepId: null,
      pendingFlowClickCoordStepId: null,
      pendingFlowSwipeStepId: null,
    });
  },
  setMaterialFilter: (materialFilter) => set({ materialFilter }),
  setNodeScale: (nodeScale) => {
    try {
      window.localStorage.setItem(NODE_SCALE_KEY, nodeScale);
    } catch {
      // 记不住就算了，本次会话内照常生效
    }
    set({ nodeScale });
  },
  setMaterialOpen: (materialOpen) => set({ materialOpen }),
  setLeftPaneOpen: (leftPaneOpen) => set({ leftPaneOpen }),
  setFlowDockOpen: (flowDockOpen) => set({ flowDockOpen }),
  setFlowDockTab: (flowDockTab) => set({ flowDockTab }),
  openFlowConfig: () => set({ flowDockOpen: true, flowDockTab: 'config' }),
  setRightPaneOpen: (rightPaneOpen) => set({ rightPaneOpen }),
  setFlowGlobalSettingsOpen: (flowGlobalSettingsOpen) => set({ flowGlobalSettingsOpen }),
  toggleFlowGlobalSettings: () => set((state) => ({ flowGlobalSettingsOpen: !state.flowGlobalSettingsOpen })),
  toggleLeftPane: () => set((state) => ({ leftPaneOpen: !state.leftPaneOpen })),
  toggleFlowDock: () => set((state) => ({ flowDockOpen: !state.flowDockOpen })),
  toggleRightPane: () => set((state) => ({ rightPaneOpen: !state.rightPaneOpen })),
  openWorkflowTab: (root) =>
    set((state) => {
      if (!root || state.openWorkflowTabs.includes(root)) {
        return state;
      }
      const openWorkflowTabs = [...state.openWorkflowTabs, root];
      saveOpenWorkflowTabs(openWorkflowTabs);
      return { openWorkflowTabs };
    }),
  closeWorkflowTab: (root) =>
    set((state) => {
      const key = workflowRootKey(root);
      if (!state.openWorkflowTabs.some((item) => workflowRootKey(item) === key)) {
        return state;
      }
      const openWorkflowTabs = state.openWorkflowTabs.filter((item) => workflowRootKey(item) !== key);
      saveOpenWorkflowTabs(openWorkflowTabs);
      const workflowSplitOpen =
        state.workflowSplitOpen &&
        openWorkflowTabs.length >= 2 &&
        openWorkflowTabs.some((item) => item !== currentWorkflowRoot());
      return { openWorkflowTabs, workflowSplitOpen };
    }),
  toggleDevicePopover: (open) => set((state) => ({ devicePopoverOpen: open ?? !state.devicePopoverOpen })),
  setDeviceTab: (deviceTab) => set({ deviceTab }),
  setRightTab: (rightTab) => set({ rightTab }),
  toggleDock: (tab) =>
    set((state) =>
      state.dockOpen && state.dockTab === tab ? { dockOpen: false } : { dockTab: tab, dockOpen: true },
    ),
  closeDock: () => set({ dockOpen: false }),

  beginDraft: ({ rect, score, mode, pickCenter, resolution, label, kind, text }) => {
    const sequence = get().sequence;
    const activeId = useDeviceStore.getState().activeId;
    const script = useGraphStore.getState().graphs[SCRIPT_SCOPE];
    const flowMode = (script?.flow?.steps?.length ?? 0) > 0;
    const resolvedMode = mode ?? (get().recordMode === 'pick' ? 'pick' : 'marquee');
    const resolvedKind = kind ?? get().recordKind;
    set({
      sequence: sequence + 1,
      draft: {
        // 草稿跟着**当前**设备走：之后用户在多开网格里切到别的格子，
        // 确认时也仍然写进这一台的状态图（见 RecordDraft.deviceId 注释）
        deviceId: activeId || undefined,
        mode: resolvedMode,
        kind: resolvedKind,
        pickCenter,
        resolution,
        rect,
        label: label ?? '',
        threshold: resolvedKind === 'ocr' ? OCR_DEFAULT_THRESHOLD : DEFAULT_THRESHOLD,
        score,
        // 默认原区域（与老行为一致）：目标位置不固定的按钮，录制时手动勾「全屏查找」
        search: 'region',
        ...(resolvedKind === 'ocr' ? { text: text ?? '', ocrMode: 'contains' as const } : {}),
        asEnter: !flowMode,
        asActionTarget: !flowMode,
        targetMode: 'new',
        targetNodeId: null,
        newNodeName: label || '新界面',
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
        message: '录制需要先连接设备：画面栏的「连接设备」（或设备标签条那一行的 ＋）→ 选一台 → 连接',
      });
      return;
    }
    // 兜底：录制中途把当前工作流切成「(无)」（草稿留着，建完工作流直接点确定）
    if (!currentWorkflowRoot()) {
      noWorkflowHint();
      useEventStore.getState().append(deviceId, 'error', { message: NO_WORKFLOW_HINT });
      return;
    }
    void useSessionStore.getState().record(deviceId, draft);
    set({ draft: null });
  },
}));
