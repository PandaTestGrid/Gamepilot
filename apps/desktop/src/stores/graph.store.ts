/**
 * 工作流 store —— **项目一份结构（flow.steps），设备只叠运行态**。
 *
 * - `graph.json` 属于当前工作流目录，与设备无关；
 * - 画布 / 画面栏读 `graphForDevice(activeId)`：结构来自当前工作流，分数与当前节点来自该设备的 live 层；
 * - 不再在每次 refresh / 改图时给每台设备复制一整份结构（切设备、切工作流时容易看到旧图或互相覆盖）。
 */
import { create } from 'zustand';

import { coerceStr } from '@/lib/coerce';
import { getActiveWorkflowRoot } from '@/lib/workflow-active-root';
import { toGraphData } from '@/lib/graph-adapter';
import {
  applyPositions,
  clearStoredPositions,
  loadStoredPositions,
  preservePositions,
  storePositions,
  storeStepPositions,
} from '@/lib/node-positions';
import { preloadTemplates } from '@/stores/template.store';
import { devLog, graphGet, graphSave, type GraphPayload } from '@/lib/rpc';
import { normalizeDelayMs } from '@/features/graph/flow/flow-delay-params';
import {
  appendPaletteModule,
  insertPaletteModuleAfter as buildInsertPaletteModuleAfter,
  insertPaletteModuleBefore as buildInsertPaletteModuleBefore,
  storePositionsForInsertedSteps,
  type PaletteInsertOutcome,
} from '@/features/graph/flow/flow-palette-insert';
import { disconnectSteps } from '@/features/graph/flow/flow-disconnect';
import { structureFromCanvasLink, structureFromStepReorder } from '@/features/graph/flow/flow-mutations';
import {
  migrateFlowSteps,
  removeStepKeepingGap,
  removeStepsFromChain,
} from '@/features/graph/flow/flow-structure';
import { sanitizeCondParamsForSave } from '@/features/graph/flow/flow-cond-params';
import type { FlowSourceHandleId } from '@/features/graph/flow/flow-step-ports';
import { type PaletteModule } from '@/features/graph/flow/flow-step-meta';
import { wrapSelectionInLoop } from '@/features/graph/flow/flow-wrap-loop';
import {
  captureFlowHistory,
  FLOW_HISTORY_LIMIT,
  flowStepsEqual,
  type FlowHistoryEntry,
} from '@/features/graph/flow/flow-history';
import { FLOW_EDIT_LOCKED_HINT, isWorkflowLive } from '@/lib/flow-edit-lock';
import type { FlowStep, GraphData, RecognizerView } from '@/types';

/** 某台设备上「实时识别 + 运行指针」，不写入 graph.json */
interface DeviceLive {
  readonly node: string | null;
  readonly pending: string | null;
  readonly detections: ReadonlyArray<{ label: string; score: number; state: string }>;
}

interface WorkflowSnapshot {
  readonly graph: GraphData;
  readonly raw?: GraphPayload;
}

interface GraphState {
  /** 工作流结构（`graphs[WORKFLOW_SCOPE]`）；设备 key 只在有 live 时出现 */
  readonly graphs: Readonly<Record<string, GraphData>>;
  readonly raws: Readonly<Record<string, GraphPayload>>;
  readonly workflowSnapshots: Readonly<Record<string, WorkflowSnapshot>>;
  readonly liveByDevice: Readonly<Record<string, DeviceLive>>;
  readonly selectedNodeId: string | null;
  readonly selectedNodeIds: readonly string[];
  readonly ensure: (deviceId: string) => void;
  readonly refresh: (deviceId?: string) => Promise<void>;
  /** 换工作流 / 热重载后清掉各设备的运行态缓存（结构由下一次 load 写入） */
  readonly clearDeviceLive: () => void;
  readonly updateRecognizerThreshold: (deviceId: string, label: string, threshold: number) => void;
  /** 切换搜索范围（region = 只在 roi 里找；full = 整帧找） */
  readonly updateRecognizerSearch: (deviceId: string, label: string, search: 'region' | 'full') => void;
  /** 兼容引擎仍可能带回 nodes 时的本地摆位（步骤链用 `node-positions` 的 step 键） */
  readonly moveNode: (deviceId: string, nodeId: string, x: number, y: number) => void;
  readonly selectNode: (nodeId: string | null) => void;
  readonly focusNodeRequest: { readonly nodeId: string; readonly seq: number } | null;
  readonly focusNode: (nodeId: string) => void;
  readonly setNodeSelection: (nodeIds: readonly string[], primaryId?: string | null) => void;
  readonly setGraph: (
    deviceId: string,
    graph: GraphData,
    raw?: GraphPayload,
    options?: {
      resetPositions?: boolean;
      /** 默认 true；设备连接/切设备传 false，只更新该设备 live，不覆盖 flow.steps */
      applyStructure?: boolean;
      /** 录模板/改名等：本地步骤链更长时不被引擎旧图覆盖 */
      preferLocalFlowIfLonger?: boolean;
    },
  ) => void;
  readonly setVariables: (
    deviceId: string,
    variables: Record<string, { type?: string; value?: string | number | boolean }>,
  ) => Promise<void>;
  /** 更新工作流全局默认配置（写入 graph.json -> defaults） */
  readonly patchDefaults: (patch: Record<string, unknown>) => Promise<void>;
  readonly updateLive: (
    deviceId: string,
    live: {
      node: string | null;
      pending: string | null;
      detections: ReadonlyArray<{ label: string; score: number; state: string }>;
    },
  ) => void;
  /** 步骤链（Automa）：整链保存 */
  /** 把当前画布步骤链写入 graph.json 并让已连接设备热重载（运行前必须一致） */
  readonly flushWorkflowToEngine: (options?: { force?: boolean }) => Promise<void>;
  /** 整链保存：画布**先**更新（乐观），磁盘按顺序合并写入；只有最新一次的回包才会覆盖画布 */
  readonly saveFlowSteps: (
    steps: readonly FlowStep[],
    options?: { readonly recordHistory?: boolean },
  ) => Promise<void>;
  /** 流程图撤销栈（当前工作流）；切工作流会清空 */
  readonly flowUndo: readonly FlowHistoryEntry[];
  readonly flowRedo: readonly FlowHistoryEntry[];
  readonly flowHistoryRoot: string;
  readonly undoFlow: () => Promise<boolean>;
  readonly redoFlow: () => Promise<boolean>;
  /** 追加到链尾（未接入段，需要连线才会执行） */
  readonly appendFlowModule: (
    module: PaletteModule,
    options?: { position?: { x: number; y: number } },
  ) => Promise<string | null>;
  /** 新模块接在某模块的某个出口后面（拖到输出口 / 模块身上松手、右键插入） */
  readonly insertFlowModuleAfter: (
    afterStepId: string,
    module: PaletteModule,
    options?: { handle?: FlowSourceHandleId },
  ) => Promise<string | null>;
  /** 新模块插到某模块之前（拖到输入口松手） */
  readonly insertFlowModuleBefore: (beforeStepId: string, module: PaletteModule) => Promise<string | null>;
  readonly updateFlowStep: (
    stepId: string,
    patch: { type?: string; params?: Record<string, unknown>; disabled?: boolean },
  ) => Promise<void>;
  readonly removeFlowStep: (stepId: string) => Promise<void>;
  readonly removeFlowSteps: (stepIds: readonly string[]) => Promise<void>;
  /** 删掉一个模块但保留缺口：下游就地变「未接入」，不会被自动接上 */
  readonly removeFlowStepKeepingGap: (stepId: string) => Promise<void>;
  /** 多选连续模块外包 loop/loopend（M2 套循环） */
  readonly wrapFlowSelectionInLoop: (count?: number) => Promise<string | null>;
  /** 出口 → 入口连线；成功返回 null，被拒绝返回原因（同时写进 `flowNotice`） */
  readonly connectFlowSteps: (
    sourceId: string,
    targetId: string,
    sourceHandle?: string | null,
    targetHandle?: string | null,
  ) => Promise<string | null>;
  /** 断开画布上的一条推导连线；成功返回 null，被拒绝返回原因 */
  readonly disconnectFlowEdge: (
    sourceId: string,
    targetId: string,
    sourceHandle?: string | null,
    targetHandle?: string | null,
  ) => Promise<string | null>;
  readonly moveFlowStepAfter: (
    stepId: string,
    afterStepId: string,
    options?: { readonly handle?: FlowSourceHandleId },
  ) => Promise<void>;
  readonly reorderFlowStepBefore: (stepId: string, beforeStepId: string) => Promise<void>;
  /** 画布上的一次性提示（连线被拒、保存失败…） */
  readonly flowNotice: { readonly id: number; readonly text: string } | null;
  readonly reportFlowNotice: (text: string) => void;
  readonly clearFlowNotice: (id?: number) => void;
  readonly cacheActiveWorkflowSnapshot: () => void;
  /** 没有当前工作流时清空画布与选中态，防止残留旧节点 */
  readonly clearWorkflowGraph: () => void;
  readonly removeWorkflowSnapshot: (root: string) => void;
  readonly renameWorkflowSnapshot: (fromRoot: string, toRoot: string) => void;
  readonly pruneWorkflowSnapshots: (keepRoots: readonly string[]) => void;
}

/** 项目级 graph 在 store 里的固定 key（与设备 id 无关） */
export const WORKFLOW_SCOPE = '__script__';
/** @deprecated 用 `WORKFLOW_SCOPE` */
export const SCRIPT_SCOPE = WORKFLOW_SCOPE;

export function graphForDevice(
  state: { graphs: Readonly<Record<string, GraphData>> },
  deviceId: string,
): GraphData | undefined {
  if (deviceId && state.graphs[deviceId]) {
    return state.graphs[deviceId];
  }
  return state.graphs[SCRIPT_SCOPE];
}

/** 连线/断开/删缺口后打一行结构（`*` = 未接入），排错时一眼能看出谁被自动接上了 */
function flowStepDebug(steps: readonly FlowStep[]): string {
  return steps.map((step) => `${step.id}${step.params?._pendingLink ? '*' : ''}`).join(' | ');
}

export function rawFor(
  state: { raws: Readonly<Record<string, GraphPayload>> },
  _deviceId: string,
): GraphPayload | undefined {
  return state.raws[SCRIPT_SCOPE];
}

function normalizeSnapshotKey(value: string): string {
  return value
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

/** 分屏侧栏：当前工作流走 live 图，其它标签用最近快照（引擎同时只加载一个目录）。 */
export function graphForWorkflowRoot(
  state: {
    graphs: Readonly<Record<string, GraphData>>;
    workflowSnapshots: Readonly<Record<string, WorkflowSnapshot>>;
  },
  workflowRoot: string,
  deviceId: string,
): GraphData | undefined {
  const active = getActiveWorkflowRoot();
  if (workflowRoot && active && normalizeSnapshotKey(workflowRoot) === normalizeSnapshotKey(active)) {
    return graphForDevice(state, deviceId);
  }
  const direct = state.workflowSnapshots[workflowRoot]?.graph;
  if (direct) {
    return direct;
  }
  const key = normalizeSnapshotKey(workflowRoot);
  for (const [k, snap] of Object.entries(state.workflowSnapshots)) {
    if (normalizeSnapshotKey(k) === key) {
      return snap.graph;
    }
  }
  return undefined;
}

function sameSelection(
  state: { selectedNodeId: string | null; selectedNodeIds: readonly string[] },
  ids: readonly string[],
  primary: string | null,
): boolean {
  return (
    state.selectedNodeId === primary &&
    state.selectedNodeIds.length === ids.length &&
    state.selectedNodeIds.every((id, index) => id === ids[index])
  );
}

function mergeWorkflowSnapshot(
  state: GraphState,
  partial: Pick<GraphState, 'graphs' | 'raws'>,
): Partial<GraphState> {
  const root = getActiveWorkflowRoot();
  if (!root) {
    return partial;
  }
  const script = partial.graphs[SCRIPT_SCOPE];
  if (!script) {
    return partial;
  }
  const raw = partial.raws[SCRIPT_SCOPE];
  return {
    ...partial,
    workflowSnapshots: {
      ...state.workflowSnapshots,
      [root]: { graph: script, ...(raw ? { raw } : {}) },
    },
  };
}

/**
 * 旧图没有 flow 时写入的默认触发块（打开即落盘，不再保留 nodes/edges 编辑）。
 *
 * 触发方式必须是 `manual`：写 `schedule`（曾经是 `at: '09:00'`）等于"用户只是打开了一次旧图，
 * 就给它装了一个每天 9 点自动跑的定时任务"——引擎的 `_arm_auto_trigger` 会真的执行。
 */
export const DEFAULT_WORKFLOW_FLOW: GraphPayload['flow'] = {
  steps: [{ id: 'trigger', type: 'manual', params: {} }],
};

async function ensureFlowPayload(raw: GraphPayload): Promise<GraphPayload> {
  if (raw.flow !== undefined) {
    const nodes = raw.nodes ?? [];
    const edges = raw.edges ?? [];
    if (nodes.length > 0 || edges.length > 0) {
      return graphSave({ ...raw, nodes: [], edges: [] });
    }
    return raw;
  }
  return graphSave({
    ...raw,
    nodes: [],
    edges: [],
    flow: DEFAULT_WORKFLOW_FLOW,
  });
}

function flowStepsFromRaw(raw: GraphPayload | undefined): FlowStep[] {
  if (!raw?.flow?.steps) {
    return [];
  }
  return raw.flow.steps.map((item) => {
    const step = item;
    return {
      id: coerceStr(step.id),
      type: coerceStr(step.type),
      params:
        typeof step.params === 'object' && step.params !== null
          ? (step.params as Record<string, unknown>)
          : {},
      disabled: step.disabled === true,
    };
  });
}

/** 画布真源优先：避免 raw 被引擎旧回包写短后，改一步就把整链存成只剩触发器 */
function flowStepsInStore(state: GraphState): FlowStep[] {
  const fromScript = scriptGraph(state)?.flow?.steps ?? [];
  const fromRaw = flowStepsFromRaw(rawFor(state, SCRIPT_SCOPE));
  const steps = fromScript.length >= fromRaw.length ? fromScript : fromRaw;
  return [...steps];
}

/** 引擎回包（录模板/改名）可能只带了磁盘上的短链，保留内存里更长的 flow */
function mergeIncomingPayloadWithLocalFlow(incoming: GraphPayload, state: GraphState): GraphPayload {
  const localSteps = flowStepsInStore(state);
  const incomingSteps = flowStepsFromRaw(incoming);
  if (localSteps.length <= incomingSteps.length) {
    return incoming;
  }
  return {
    ...incoming,
    flow: flowStepsToPayload(localSteps),
  };
}

function flowStepsToPayload(steps: readonly FlowStep[]): GraphPayload['flow'] {
  return {
    steps: migrateFlowSteps(steps).map((step) => {
      const params =
        step.type === 'cond' && step.params ? sanitizeCondParamsForSave(step.params) : step.params;
      return {
        id: step.id,
        type: step.type,
        ...(params && Object.keys(params).length > 0 ? { params } : {}),
        ...(step.disabled ? { disabled: true } : {}),
      };
    }),
  };
}

function scriptGraph(state: GraphState): GraphData | undefined {
  return state.graphs[SCRIPT_SCOPE];
}

function liveUnchanged(prev: DeviceLive | undefined, live: DeviceLive): boolean {
  if (!prev) {
    return false;
  }
  if (prev.node !== live.node || prev.pending !== live.pending) {
    return false;
  }
  if (prev.detections.length !== live.detections.length) {
    return false;
  }
  for (let i = 0; i < prev.detections.length; i += 1) {
    const a = prev.detections[i];
    const b = live.detections[i];
    if (!a || !b || a.label !== b.label || a.state !== b.state) {
      return false;
    }
    if (Math.round(a.score * 1000) !== Math.round(b.score * 1000)) {
      return false;
    }
  }
  return true;
}

function applyLiveToGraph(base: GraphData, live: DeviceLive | undefined): GraphData {
  if (!live) {
    return base;
  }
  const hits = new Map(live.detections.map((item) => [item.label, item] as const));
  const recognizers = base.recognizers.map((item) => {
    const hit = hits.get(item.label);
    return hit
      ? { ...item, score: hit.score, state: hit.state as RecognizerView['state'] }
      : { ...item, score: 0, state: 'idle' as const };
  });
  return {
    ...base,
    recognizers,
    activeNodeId: live.node ?? base.activeNodeId,
    pendingNodeId: live.pending,
  };
}

function rebuildDeviceViews(
  script: GraphData,
  liveByDevice: Readonly<Record<string, DeviceLive>>,
): Readonly<Record<string, GraphData>> {
  const graphs: Record<string, GraphData> = { [SCRIPT_SCOPE]: script };
  for (const [deviceId, live] of Object.entries(liveByDevice)) {
    graphs[deviceId] = applyLiveToGraph(script, live);
  }
  return graphs;
}

function placed(payload: GraphPayload, previousScript: GraphData | undefined): GraphData {
  const mapped = toGraphData(SCRIPT_SCOPE, payload, undefined);
  preloadTemplates(mapped.recognizers.map((item) => item.label));
  const withStored = applyPositions(mapped, loadStoredPositions());
  return preservePositions(withStored, previousScript);
}

function publishFlowDraft(
  state: GraphState,
  steps: readonly FlowStep[],
): Pick<GraphState, 'graphs' | 'raws'> | null {
  const raw = rawFor(state, SCRIPT_SCOPE);
  const script = scriptGraph(state) ?? (raw ? toGraphData(SCRIPT_SCOPE, raw, undefined) : undefined);
  if (!script) {
    return null;
  }
  const flowPayload = flowStepsToPayload(steps);
  const nextScript: GraphData = {
    ...script,
    flow: { steps: [...steps] },
  };
  const nextRaw = raw ? { ...raw, flow: flowPayload } : undefined;
  return publishScript(state, nextScript, nextRaw);
}

/** 画布上有尚未成功写入 graph.json 的步骤链改动（运行前据此决定要不要 flush） */
let flowDirty = false;

let writeTimer: number | undefined;
function remember(graph: GraphData): void {
  if (writeTimer !== undefined) {
    window.clearTimeout(writeTimer);
  }
  writeTimer = window.setTimeout(() => {
    writeTimer = undefined;
    storePositions(graph);
  }, 250);
}

function publishScript(
  state: GraphState,
  script: GraphData,
  raw?: GraphPayload,
): Pick<GraphState, 'graphs' | 'raws'> {
  const graphs = rebuildDeviceViews(script, state.liveByDevice);
  const raws = raw ? { ...state.raws, [SCRIPT_SCOPE]: raw } : state.raws;
  return { graphs, raws };
}

function patchScript(
  state: GraphState,
  updater: (script: GraphData) => GraphData,
  raw?: GraphPayload,
): Pick<GraphState, 'graphs' | 'raws'> | null {
  const current = scriptGraph(state);
  if (!current) {
    return null;
  }
  return publishScript(state, updater(current), raw);
}

export const useGraphStore = create<GraphState>()((set, get) => ({
  graphs: {},
  raws: {},
  workflowSnapshots: {},
  liveByDevice: {},
  selectedNodeId: null,
  selectedNodeIds: [],
  focusNodeRequest: null,
  flowUndo: [],
  flowRedo: [],
  flowHistoryRoot: '',

  cacheActiveWorkflowSnapshot: () => {
    const root = getActiveWorkflowRoot();
    if (!root) {
      return;
    }
    const state = get();
    const script = scriptGraph(state);
    if (!script) {
      return;
    }
    const raw = state.raws[SCRIPT_SCOPE];
    set({
      workflowSnapshots: {
        ...state.workflowSnapshots,
        [root]: { graph: script, ...(raw ? { raw } : {}) },
      },
    });
  },

  clearWorkflowGraph: () => {
    if (writeTimer !== undefined) {
      window.clearTimeout(writeTimer);
      writeTimer = undefined;
    }
    pendingFlowSteps = null;
    pendingFlowRoot = '';
    flowDirty = false;
    set({
      graphs: {},
      raws: {},
      selectedNodeId: null,
      selectedNodeIds: [],
      flowUndo: [],
      flowRedo: [],
      flowHistoryRoot: '',
    });
  },

  removeWorkflowSnapshot: (root) =>
    set((state) => {
      if (!root) {
        return state;
      }
      const target = normalizeSnapshotKey(root);
      const next: Record<string, WorkflowSnapshot> = {};
      let changed = false;
      for (const [key, value] of Object.entries(state.workflowSnapshots)) {
        if (normalizeSnapshotKey(key) === target) {
          changed = true;
        } else {
          next[key] = value;
        }
      }
      return changed ? { workflowSnapshots: next } : state;
    }),

  renameWorkflowSnapshot: (fromRoot, toRoot) =>
    set((state) => {
      if (!fromRoot || !toRoot) {
        return state;
      }
      const fromKey = normalizeSnapshotKey(fromRoot);
      const next: Record<string, WorkflowSnapshot> = {};
      let moved: WorkflowSnapshot | undefined;
      for (const [key, value] of Object.entries(state.workflowSnapshots)) {
        if (normalizeSnapshotKey(key) === fromKey) {
          moved = value;
        } else {
          next[key] = value;
        }
      }
      if (!moved) {
        return state;
      }
      next[toRoot] = moved;
      return { workflowSnapshots: next };
    }),

  pruneWorkflowSnapshots: (keepRoots) =>
    set((state) => {
      const keep = new Set(keepRoots.filter(Boolean).map(normalizeSnapshotKey));
      if (keep.size === 0) {
        return Object.keys(state.workflowSnapshots).length === 0 ? state : { workflowSnapshots: {} };
      }
      const next: Record<string, WorkflowSnapshot> = {};
      let changed = false;
      for (const [key, value] of Object.entries(state.workflowSnapshots)) {
        if (keep.has(normalizeSnapshotKey(key))) {
          next[key] = value;
        } else {
          changed = true;
        }
      }
      return changed ? { workflowSnapshots: next } : state;
    }),

  clearDeviceLive: () =>
    set((state) => {
      const script = scriptGraph(state);
      if (!script) {
        return { liveByDevice: {} };
      }
      return { liveByDevice: {}, graphs: { [SCRIPT_SCOPE]: script } };
    }),

  refresh: async () => {
    try {
      const raw = await ensureFlowPayload(await graphGet());
      set((state) =>
        mergeWorkflowSnapshot(state, publishScript(state, placed(raw, scriptGraph(state)), raw)),
      );
    } catch (error) {
      devLog(`拉工作流失败: ${String(error)}`);
    }
  },

  ensure: () =>
    set((state) => {
      if (scriptGraph(state)) {
        return state;
      }
      const empty: GraphData = {
        deviceId: SCRIPT_SCOPE,
        nodes: [],
        edges: [],
        recognizers: [],
        variables: [],
        activeNodeId: null,
        pendingNodeId: null,
        flow: { steps: [] },
      };
      return mergeWorkflowSnapshot(state, publishScript(state, empty));
    }),

  updateRecognizerThreshold: (_deviceId, label, threshold) =>
    set((state) => {
      const currentRaw = rawFor(state, SCRIPT_SCOPE);
      const nextRaw =
        currentRaw && currentRaw.recognizers?.[label]
          ? {
              ...currentRaw,
              recognizers: {
                ...currentRaw.recognizers,
                [label]: { ...currentRaw.recognizers[label], threshold },
              },
            }
          : currentRaw;
      const next = patchScript(
        state,
        (script) => ({
          ...script,
          recognizers: script.recognizers.map((item) =>
            item.label === label ? { ...item, threshold } : item,
          ),
        }),
        nextRaw,
      );
      return next ? mergeWorkflowSnapshot(state, next) : state;
    }),

  updateRecognizerSearch: (_deviceId, label, search) =>
    set((state) => {
      const currentRaw = rawFor(state, SCRIPT_SCOPE);
      const spec = currentRaw?.recognizers?.[label];
      let nextRaw = currentRaw;
      if (currentRaw && spec) {
        const nextSpec: Record<string, unknown> = { ...spec };
        if (search === 'full') {
          nextSpec.search = 'full';
        } else {
          // 默认值不落盘（与引擎一致）：切回 region 就删掉，graph.json 保持干净
          delete nextSpec.search;
        }
        nextRaw = {
          ...currentRaw,
          recognizers: { ...currentRaw.recognizers, [label]: nextSpec },
        };
      }
      const next = patchScript(
        state,
        (script) => ({
          ...script,
          recognizers: script.recognizers.map((item) => (item.label === label ? { ...item, search } : item)),
        }),
        nextRaw,
      );
      return next ? mergeWorkflowSnapshot(state, next) : state;
    }),

  moveNode: (_deviceId, nodeId, x, y) =>
    set((state) => {
      const script = scriptGraph(state);
      if (!script) {
        return state;
      }
      const nodes = script.nodes.map((item) => (item.id === nodeId ? { ...item, x, y } : item));
      const next = { ...script, nodes };
      remember(next);
      return mergeWorkflowSnapshot(state, publishScript(state, next));
    }),

  // 选中没变就别写 store：画布的选中监听和 store 互相回写，每次都换新数组会让它们无限互相触发
  selectNode: (nodeId) =>
    set((state) =>
      sameSelection(state, nodeId ? [nodeId] : [], nodeId)
        ? state
        : { selectedNodeId: nodeId, selectedNodeIds: nodeId ? [nodeId] : [] },
    ),

  focusNode: (nodeId) => {
    if (!nodeId) {
      return;
    }
    set({
      selectedNodeId: nodeId,
      selectedNodeIds: [nodeId],
      focusNodeRequest: { nodeId, seq: ++focusNodeSeq },
    });
  },

  setNodeSelection: (nodeIds, primaryId) =>
    set((state) => {
      const primary = primaryId !== undefined ? primaryId : (nodeIds[0] ?? null);
      return sameSelection(state, nodeIds, primary)
        ? state
        : { selectedNodeIds: nodeIds, selectedNodeId: primary };
    }),

  setGraph: (deviceId, graph, raw, options) => {
    preloadTemplates(graph.recognizers.map((item) => item.label));
    if (options?.resetPositions) {
      clearStoredPositions();
    }
    set((state) => {
      const existingScript = scriptGraph(state);
      // 默认写结构；设备连接/重连的调用点显式传 applyStructure: false（只叠 live）
      const applyStructure = options?.applyStructure ?? true;

      let script = graph;
      let rawForPublish: GraphPayload | undefined;

      if (raw && applyStructure) {
        const preferLocalFlow =
          options?.preferLocalFlowIfLonger ?? (Boolean(deviceId) && deviceId !== SCRIPT_SCOPE);
        const payload = preferLocalFlow ? mergeIncomingPayloadWithLocalFlow(raw, state) : raw;
        script = options?.resetPositions
          ? toGraphData(SCRIPT_SCOPE, payload, undefined)
          : placed(payload, existingScript);
        rawForPublish = payload;
      } else if (raw && !applyStructure) {
        // 设备连上/重连带回的 graph 与项目级 graph.json 同源，但内存里可能有未落盘步骤；
        // 只叠该设备的 live，不要用这份回包覆盖 flow.steps。
        script = existingScript ?? placed(raw, undefined);
        rawForPublish = existingScript ? undefined : raw;
      } else if (!options?.resetPositions) {
        const withStored = applyPositions(graph, loadStoredPositions());
        script = preservePositions(withStored, existingScript);
      }

      const liveByDevice = { ...state.liveByDevice };
      if (deviceId && deviceId !== SCRIPT_SCOPE) {
        liveByDevice[deviceId] = {
          node: graph.activeNodeId,
          pending: graph.pendingNodeId,
          detections: graph.recognizers.map((item) => ({
            label: item.label,
            score: item.score,
            state: item.state,
          })),
        };
      }

      const next = publishScript({ ...state, liveByDevice }, script, rawForPublish);
      const root = getActiveWorkflowRoot();
      const switchedWorkflow =
        applyStructure &&
        (!deviceId || deviceId === SCRIPT_SCOPE) &&
        normalizeSnapshotKey(root) !== normalizeSnapshotKey(state.flowHistoryRoot);
      return {
        ...mergeWorkflowSnapshot(state, next),
        liveByDevice,
        ...(switchedWorkflow ? { flowUndo: [], flowRedo: [], flowHistoryRoot: root } : {}),
      };
    });
  },

  setVariables: async (_deviceId, variables) => {
    const raw = rawFor(get(), SCRIPT_SCOPE);
    if (!raw) {
      return;
    }
    await graphSave({ ...raw, variables });
    const saved = await graphGet();
    set((state) =>
      mergeWorkflowSnapshot(state, publishScript(state, placed(saved, scriptGraph(state)), saved)),
    );
  },

  patchDefaults: async (patch) => {
    if (await currentWorkflowIsLive()) {
      get().reportFlowNotice(FLOW_EDIT_LOCKED_HINT);
      return;
    }
    const raw = rawFor(get(), SCRIPT_SCOPE);
    if (!raw) {
      return;
    }
    const nextDefaults: Record<string, unknown> = { ...(raw.defaults ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete nextDefaults[key];
      } else {
        nextDefaults[key] = value;
      }
    }
    const nextRaw: GraphPayload = { ...raw, defaults: nextDefaults };
    set((state) => {
      const script = scriptGraph(state);
      if (!script) {
        return { raws: { ...state.raws, [SCRIPT_SCOPE]: nextRaw } };
      }
      return mergeWorkflowSnapshot(state, publishScript(state, script, nextRaw));
    });
    try {
      await graphSave(nextRaw);
    } catch (error) {
      devLog(`保存全局配置失败: ${String(error)}`);
    }
  },

  updateLive: (deviceId, live) =>
    set((state) => {
      const script = scriptGraph(state);
      if (!script || !deviceId) {
        return state;
      }
      const normalized: DeviceLive = {
        node: live.node,
        pending: live.pending,
        detections: live.detections,
      };
      if (liveUnchanged(state.liveByDevice[deviceId], normalized)) {
        return state;
      }
      const liveByDevice = {
        ...state.liveByDevice,
        [deviceId]: normalized,
      };
      return {
        liveByDevice,
        graphs: rebuildDeviceViews(script, liveByDevice),
      };
    }),

  flushWorkflowToEngine: async (options) => {
    // 先等在途的保存落地：否则会拿到半新不旧的结构
    if (saving) {
      await saving;
    }
    // 已有设备在跑这份工作流：禁止 graph.save（会热重载丢掉执行指针，
    // 第二台设备开跑同一份脚本时也会被引擎当成「改图」拒绝）。
    if (await currentWorkflowIsLive()) {
      return;
    }
    // 没有未落盘改动就不重存：重存会让引擎热重载，白白重置识别投票
    if (!flowDirty && !options?.force) {
      return;
    }
    const raw = rawFor(get(), SCRIPT_SCOPE);
    const script = scriptGraph(get());
    if (!raw || !script?.flow) {
      throw new Error('还没有可同步的工作流');
    }
    const payload = { ...raw, flow: flowStepsToPayload(script.flow.steps) };
    const saved = await graphSave(payload);
    flowDirty = false;
    set((state) =>
      mergeWorkflowSnapshot(state, publishScript(state, placed(saved, scriptGraph(state)), saved)),
    );
  },

  saveFlowSteps: async (steps, options) => {
    if (!rawFor(get(), SCRIPT_SCOPE)) {
      return;
    }
    if (await currentWorkflowIsLive()) {
      get().reportFlowNotice(FLOW_EDIT_LOCKED_HINT);
      return;
    }
    const normalized = migrateFlowSteps(steps);
    if (options?.recordHistory !== false) {
      recordFlowHistory(set, get, normalized);
    }
    flowDirty = true;
    // 1) 画布先更新：用户看到的永远是最新操作的结果，不用等引擎往返
    set((state) => {
      const patch = publishFlowDraft(state, normalized);
      return patch ? mergeWorkflowSnapshot(state, patch) : state;
    });
    // 2) 磁盘合并写入（只写最新草稿），见 `drainFlowSaves`
    pendingFlowSteps = [...normalized];
    pendingFlowRoot = getActiveWorkflowRoot();
    await drainFlowSaves(set, get);
  },

  undoFlow: async () => applyFlowHistory(set, get, 'undo'),
  redoFlow: async () => applyFlowHistory(set, get, 'redo'),

  appendFlowModule: async (module, options) => {
    const raw = rawFor(get(), SCRIPT_SCOPE);
    if (!raw) {
      return null;
    }
    const previous = flowStepsInStore(get());
    const built = appendPaletteModule(previous, module);
    if (!built) {
      get().reportFlowNotice(`「${module.label}」不能单独添加`);
      return null;
    }
    const insertIndex = built.steps.findIndex((step) => step.id === built.primaryId);
    const afterStepId = insertIndex > 0 ? (built.steps[insertIndex - 1]?.id ?? null) : null;
    const positions = loadStoredPositions();
    storeStepPositions(
      storePositionsForInsertedSteps(
        built.steps,
        built.insertedIds,
        options?.position ? null : afterStepId,
        positions,
        options?.position,
        { appended: true },
      ),
    );
    await get().saveFlowSteps(built.steps);
    return built.primaryId;
  },

  insertFlowModuleAfter: async (afterStepId, module, options) => {
    const raw = rawFor(get(), SCRIPT_SCOPE);
    if (!raw?.flow) {
      return null;
    }
    const previous = flowStepsInStore(get());
    if (!previous.some((step) => step.id === afterStepId)) {
      return get().appendFlowModule(module);
    }
    const built = buildInsertPaletteModuleAfter(previous, afterStepId, module, options?.handle);
    return commitInsert(get, built, afterStepId, false);
  },

  insertFlowModuleBefore: async (beforeStepId, module) => {
    const raw = rawFor(get(), SCRIPT_SCOPE);
    if (!raw?.flow) {
      return null;
    }
    const previous = flowStepsInStore(get());
    if (!previous.some((step) => step.id === beforeStepId)) {
      return get().appendFlowModule(module);
    }
    const built = buildInsertPaletteModuleBefore(previous, beforeStepId, module);
    return commitInsert(get, built, beforeStepId, true);
  },

  updateFlowStep: async (stepId, patch) => {
    const state = get();
    const raw = rawFor(state, SCRIPT_SCOPE);
    if (!raw?.flow && !scriptGraph(state)?.flow?.steps?.length) {
      return;
    }
    const steps = flowStepsInStore(state).map((step) => {
      if (step.id !== stepId) {
        return step;
      }
      const type = patch.type ?? step.type;
      let params = patch.params !== undefined ? patch.params : step.params;
      if (type === 'delay' && params && params.ms !== undefined) {
        params = { ...params, ms: normalizeDelayMs(params.ms) };
      }
      return {
        ...step,
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(params !== undefined ? { params } : {}),
        ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
      };
    });
    await get().saveFlowSteps(steps);
  },

  removeFlowSteps: async (stepIds) => {
    const state = get();
    if (stepIds.length === 0) {
      return;
    }
    const steps = flowStepsInStore(state);
    if (steps.length <= 1) {
      return;
    }
    const { steps: next, removed } = removeStepsFromChain(steps, stepIds);
    if (removed.size === 0 || next.length === steps.length || next.length < 1) {
      return;
    }
    await get().saveFlowSteps(next);
    set((current) => {
      const selectedNodeIds = current.selectedNodeIds.filter((id) => !removed.has(id));
      const selectedNodeId =
        current.selectedNodeId && removed.has(current.selectedNodeId)
          ? (selectedNodeIds[0] ?? null)
          : current.selectedNodeId;
      return { selectedNodeIds, selectedNodeId };
    });
  },

  removeFlowStep: async (stepId) => {
    await get().removeFlowSteps([stepId]);
  },

  removeFlowStepKeepingGap: async (stepId) => {
    devLog(`删除并保留缺口: ${stepId}`);
    const steps = flowStepsInStore(get());
    if (steps.length <= 1) {
      return;
    }
    const result = removeStepKeepingGap(steps, stepId);
    if (!result.ok) {
      get().reportFlowNotice(result.error);
      return;
    }
    await get().saveFlowSteps(result.steps);
    devLog(`删除后: ${flowStepDebug(result.steps)}`);
    set((current) => {
      const selectedNodeIds = current.selectedNodeIds.filter((id) => id !== stepId);
      const selectedNodeId =
        current.selectedNodeId === stepId ? (selectedNodeIds[0] ?? null) : current.selectedNodeId;
      return { selectedNodeIds, selectedNodeId };
    });
  },

  wrapFlowSelectionInLoop: async (count = 10) => {
    const steps = flowStepsInStore(get());
    const selectedIds = get().selectedNodeIds;
    const result = wrapSelectionInLoop(steps, selectedIds, count);
    if (!result.ok) {
      get().reportFlowNotice(result.error);
      return null;
    }
    const beforeIds = new Set(steps.map((step) => step.id));
    const newLoop = result.steps.find((step) => step.type === 'loop' && !beforeIds.has(step.id));
    await get().saveFlowSteps(result.steps);
    if (newLoop) {
      get().selectNode(newLoop.id);
    }
    return newLoop?.id ?? null;
  },

  moveFlowStepAfter: async (stepId, afterStepId, options) => {
    const previousSteps = flowStepsInStore(get());
    if (previousSteps.length === 0 || stepId === afterStepId) {
      return;
    }
    const result = structureFromStepReorder(previousSteps, stepId, {
      anchorStepId: afterStepId,
      placement: 'after',
      ...(options?.handle ? { handleId: options.handle } : {}),
    });
    if (!result.ok) {
      get().reportFlowNotice(result.error);
      return;
    }
    await get().saveFlowSteps(result.steps);
  },

  reorderFlowStepBefore: async (stepId, beforeStepId) => {
    const previousSteps = flowStepsInStore(get());
    if (previousSteps.length === 0 || stepId === beforeStepId) {
      return;
    }
    const result = structureFromStepReorder(previousSteps, stepId, {
      anchorStepId: beforeStepId,
      placement: 'before',
    });
    if (!result.ok) {
      get().reportFlowNotice(result.error);
      return;
    }
    await get().saveFlowSteps(result.steps);
  },

  connectFlowSteps: async (sourceId, targetId, sourceHandle, targetHandle) => {
    devLog(`连线: ${sourceId}.${sourceHandle ?? 'out'} → ${targetId}.${targetHandle ?? 'in'}`);
    const previousSteps = flowStepsInStore(get());
    if (previousSteps.length === 0) {
      return null;
    }
    const result = structureFromCanvasLink(previousSteps, sourceId, targetId, sourceHandle, targetHandle);
    if (!result.ok) {
      get().reportFlowNotice(result.error);
      return result.error;
    }
    await get().saveFlowSteps(result.steps);
    devLog(`连线后: ${flowStepDebug(result.steps)}`);
    return null;
  },

  disconnectFlowEdge: async (sourceId, targetId, sourceHandle, targetHandle) => {
    const previousSteps = flowStepsInStore(get());
    if (previousSteps.length === 0) {
      return null;
    }
    const result = disconnectSteps(previousSteps, {
      sourceId,
      targetId,
      sourceHandle,
      targetHandle,
    });
    if (!result.ok) {
      devLog(`断开失败: ${sourceId} → ${targetId} (${result.error})`);
      get().reportFlowNotice(result.error);
      return result.error;
    }
    devLog(`断开: ${sourceId}.${sourceHandle ?? 'out'} → ${targetId}.${targetHandle ?? 'in'}`);
    await get().saveFlowSteps(result.steps);
    devLog(`断开后: ${flowStepDebug(result.steps)}`);
    return null;
  },

  flowNotice: null,

  reportFlowNotice: (text) => {
    devLog(`工作流提示: ${text}`);
    set({ flowNotice: { id: ++flowNoticeSeq, text } });
  },

  clearFlowNotice: (id) =>
    set((state) => (id === undefined || state.flowNotice?.id === id ? { flowNotice: null } : state)),
}));

let flowNoticeSeq = 0;
let focusNodeSeq = 0;

/** 把插入结果写进画布 + 摆位；失败就提示原因，不改任何东西 */
async function commitInsert(
  get: () => GraphState,
  built: PaletteInsertOutcome,
  anchorId: string,
  before: boolean,
): Promise<string | null> {
  if (!built.ok) {
    get().reportFlowNotice(built.error);
    return null;
  }
  const positions = loadStoredPositions();
  storeStepPositions(
    storePositionsForInsertedSteps(built.steps, built.insertedIds, anchorId, positions, undefined, {
      before,
    }),
  );
  await get().saveFlowSteps(built.steps);
  return built.primaryId;
}

// ---------------------------------------------------------------------------
// 保存队列：连续操作（敲数字、连着拖线）只写最新那一份；回包晚到不会覆盖更新的画布
// ---------------------------------------------------------------------------

let pendingFlowSteps: FlowStep[] | null = null;
let pendingFlowRoot = '';
let saving: Promise<void> | null = null;

type StoreSet = (updater: (state: GraphState) => Partial<GraphState>) => void;

async function currentWorkflowIsLive(): Promise<boolean> {
  const { useSessionStore } = await import('@/stores/session.store');
  const session = useSessionStore.getState();
  return isWorkflowLive(session.currentWorkflow?.root ?? '', session.runningWorkflowRoots);
}

function recordFlowHistory(set: StoreSet, get: () => GraphState, nextSteps: readonly FlowStep[]): void {
  const root = getActiveWorkflowRoot();
  const current = flowStepsInStore(get());
  if (flowStepsEqual(current, nextSteps)) {
    return;
  }
  const entry = captureFlowHistory(current, loadStoredPositions());
  set((state) => {
    const sameRoot = normalizeSnapshotKey(state.flowHistoryRoot) === normalizeSnapshotKey(root);
    const stacked = [...(sameRoot ? state.flowUndo : []), entry];
    return {
      flowHistoryRoot: root,
      flowUndo: stacked.length > FLOW_HISTORY_LIMIT ? stacked.slice(-FLOW_HISTORY_LIMIT) : stacked,
      flowRedo: [],
    };
  });
}

async function applyFlowHistory(
  set: StoreSet,
  get: () => GraphState,
  direction: 'undo' | 'redo',
): Promise<boolean> {
  const root = getActiveWorkflowRoot();
  const state = get();
  if (normalizeSnapshotKey(state.flowHistoryRoot) !== normalizeSnapshotKey(root)) {
    set(() => ({ flowUndo: [], flowRedo: [], flowHistoryRoot: root }));
    return false;
  }
  const from = direction === 'undo' ? state.flowUndo : state.flowRedo;
  if (from.length === 0) {
    return false;
  }
  const entry = from[from.length - 1];
  if (!entry) {
    return false;
  }
  const current = captureFlowHistory(flowStepsInStore(state), loadStoredPositions());
  set(() =>
    direction === 'undo'
      ? { flowUndo: from.slice(0, -1), flowRedo: [...state.flowRedo, current] }
      : { flowRedo: from.slice(0, -1), flowUndo: [...state.flowUndo, current] },
  );
  storeStepPositions({ ...entry.positions });
  await get().saveFlowSteps(entry.steps, { recordHistory: false });
  return true;
}

function drainFlowSaves(set: StoreSet, get: () => GraphState): Promise<void> {
  if (saving) {
    return saving;
  }
  saving = (async () => {
    while (pendingFlowSteps) {
      const steps = pendingFlowSteps;
      const targetRoot = pendingFlowRoot;
      pendingFlowSteps = null;
      // 如果排队期间用户已经切换或删除了工作流，丢弃旧工作流的待落盘草稿，防止写串目录
      if (targetRoot && normalizeSnapshotKey(getActiveWorkflowRoot()) !== normalizeSnapshotKey(targetRoot)) {
        flowDirty = false;
        continue;
      }
      const raw = rawFor(get(), SCRIPT_SCOPE);
      if (!raw) {
        continue;
      }
      const payload: GraphPayload = { ...raw, flow: flowStepsToPayload(steps) };
      try {
        const saved = await graphSave(payload);
        if (pendingFlowSteps) {
          continue; // 期间又有新操作：这份回包已经过时，直接写下一份
        }
        if (
          targetRoot &&
          normalizeSnapshotKey(getActiveWorkflowRoot()) !== normalizeSnapshotKey(targetRoot)
        ) {
          continue;
        }
        flowDirty = false;
        set((state) =>
          mergeWorkflowSnapshot(state, publishScript(state, placed(saved, scriptGraph(state)), saved)),
        );
      } catch (error) {
        devLog(`保存步骤链失败（画布已先更新，补全条件/循环配对后会再次尝试）: ${String(error)}`);
        get().reportFlowNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  })().finally(() => {
    saving = null;
  });
  return saving;
}
