/**
 * 状态图 store：按设备分别保存状态图。
 *
 * 多设备的关键点：**每台设备有自己的 graph**（各自的识别器、节点、运行态），
 * 切换设备标签只是切换"看哪张图"，不重载也不互相污染。
 */
import { create } from 'zustand';

import { toGraphData } from '@/lib/graph-adapter';
import {
  applyPositions,
  clearStoredPositions,
  loadStoredPositions,
  preservePositions,
  storePositions,
} from '@/lib/node-positions';
import { preloadTemplates } from '@/stores/template.store';
import {
  devLog,
  graphGet,
  graphEdgeAdd,
  graphNodeAdd,
  graphNodeRemove,
  graphNodeUpdate,
  graphSave,
  type GraphEdgePayload,
  type GraphPayload,
} from '@/lib/rpc';
import type { GraphData, GraphEdgeView, GraphNodeView, RecognizerView } from '@/types';

interface GraphState {
  readonly graphs: Readonly<Record<string, GraphData>>;
  /** 引擎来的原始 graph.json（改边/改条件后要原样写回，界面模型有损） */
  readonly raws: Readonly<Record<string, GraphPayload>>;
  readonly selectedEdgeId: string | null;
  readonly selectedNodeId: string | null;
  readonly ensure: (deviceId: string) => void;
  /**
   * 重新从引擎拉这张图（真相源只有一份 graph.json）。
   *
   * 界面是按设备各缓存一份的；同一份脚本在多台设备间切换时，另一台的缓存可能是旧的，
   * 看起来就像"切设备把状态图改了"。切换设备时调它即可对齐。
   */
  readonly refresh: (deviceId: string) => Promise<void>;
  readonly addRecognizer: (deviceId: string, recognizer: RecognizerView) => void;
  readonly addNode: (deviceId: string, node: GraphNodeView) => void;
  readonly addEdge: (deviceId: string, edge: GraphEdgeView) => void;
  readonly updateRecognizerThreshold: (deviceId: string, label: string, threshold: number) => void;
  readonly updateNodeEnter: (deviceId: string, nodeId: string, label: string) => void;
  readonly moveNode: (deviceId: string, nodeId: string, x: number, y: number) => void;
  readonly selectEdge: (edgeId: string | null) => void;
  readonly selectNode: (nodeId: string | null) => void;
  /**
   * 引擎给出的状态图（唯一真源）。
   * `resetPositions`：丢弃界面记住的坐标，回到引擎给的网格布局（"重新布局"按钮用）。
   */
  readonly setGraph: (
    deviceId: string,
    graph: GraphData,
    raw?: GraphPayload,
    options?: { resetPositions?: boolean },
  ) => void;
  /** 改一条边（判断条件/动作/优先级等）→ 写回引擎并刷新界面模型 */
  readonly saveEdge: (deviceId: string, edgeId: string, patch: Partial<GraphEdgePayload>) => Promise<void>;
  /** 删除一条边 */
  readonly removeEdge: (deviceId: string, edgeId: string) => Promise<void>;
  /** 图编辑器：加/改/删节点，拖拽连边（RPC 版，和本地 addNode 区分开） */
  readonly createNode: (deviceId: string, name: string, enter?: string[]) => Promise<string | null>;
  readonly updateNode: (
    deviceId: string,
    nodeId: string,
    patch: { name?: string; enter?: string[]; timeout_ms?: number },
  ) => Promise<void>;
  readonly removeNode: (deviceId: string, nodeId: string) => Promise<void>;
  readonly connectNodes: (deviceId: string, from: string, to: string) => Promise<void>;
  /**
   * 带着动作建一步（"＋操作"菜单选完类型/目标后调用）。
   * 一次 RPC 建好并带上 action，省掉"先建再改"的两次往返；返回新边 id。
   */
  readonly addStep: (
    deviceId: string,
    from: string,
    to: string | null,
    patch?: { action?: Record<string, unknown>; when?: string; condition?: Record<string, unknown> },
  ) => Promise<string | null>;
  /** 一键建分支：识别器出现 → 去 A；不出现 → 去 B */
  readonly addBranch: (
    deviceId: string,
    from: string,
    label: string,
    yes: string,
    no: string,
  ) => Promise<void>;
  /** 黑板：保存变量定义（写回 graph.json 的 variables 段） */
  readonly setVariables: (
    deviceId: string,
    variables: Record<string, { type?: string; value?: string | number | boolean }>,
  ) => Promise<void>;
  /** 每帧同步：识别分数 / 当前节点 / pending 目标 */
  readonly updateLive: (
    deviceId: string,
    live: {
      node: string | null;
      pending: string | null;
      detections: ReadonlyArray<{ label: string; score: number; state: string }>;
    },
  ) => void;
}

/**
 * **状态图属于项目（脚本），不属于设备。**
 *
 * 这份 key 下永远存着"当前脚本"本身；某台设备那份（`graphs[deviceId]`）只是它的显示缓存
 * （叠加了那台设备的实时分数/当前节点）。没连设备、或设备还没出帧时，画布就取这一份 ——
 * 以前 `graphs[activeId]` 一取不到就显示"这台设备还没有状态图 / 先连接设备"，
 * 逻辑是反的：脚本在项目里，设备只是"在哪台机器上跑"。
 */
export const SCRIPT_SCOPE = '__script__';

/** 画布显示哪份：优先这台设备的（带实时态），没有就退到脚本本身。返回的是 store 里的原对象（引用稳定）。 */
export function graphForDevice(
  state: { graphs: Readonly<Record<string, GraphData>> },
  deviceId: string,
): GraphData | undefined {
  return state.graphs[deviceId] ?? state.graphs[SCRIPT_SCOPE];
}

/**
 * 结构性改动（改的是**脚本**）：脚本那份总是写；有设备就再写一份它的显示缓存，
 * 这样当前画布立刻能看到，切换设备也不会看到旧内容。
 */
function commit(
  state: GraphState,
  deviceId: string,
  graph: GraphData,
  raw?: GraphPayload,
): Pick<GraphState, 'graphs' | 'raws'> {
  const scoped = deviceId && deviceId !== SCRIPT_SCOPE;
  const graphs = scoped
    ? { ...state.graphs, [SCRIPT_SCOPE]: graph, [deviceId]: graph }
    : { ...state.graphs, [SCRIPT_SCOPE]: graph };
  const raws = !raw
    ? state.raws
    : scoped
      ? { ...state.raws, [SCRIPT_SCOPE]: raw, [deviceId]: raw }
      : { ...state.raws, [SCRIPT_SCOPE]: raw };
  return { graphs, raws };
}

/** 编辑脚本要拿"原始 JSON"（界面模型有损）：脚本那份优先，设备那份是它的副本。 */
export function rawFor(
  state: { raws: Readonly<Record<string, GraphPayload>> },
  deviceId: string,
): GraphPayload | undefined {
  return state.raws[deviceId] ?? state.raws[SCRIPT_SCOPE];
}

/**
 * 引擎回包的图 → 界面图：**所有**引擎回包都必须走这里。
 *
 * 坐标是界面私有的（引擎不存 x/y），所以每次回包都要把用户摆过的位置套回去：
 * 本地记忆（重启后还在）打底，内存里的最新位置优先。
 * 记忆**按脚本目录**存（不按设备）：图是项目级的，同一份脚本换台设备看到的必须是同一份摆位
 * （以前按设备分开记，切换设备就套用那台设备的旧记忆 —— 用户反馈"切设备布局自己变了"）。
 * 以前 store 里有 8 处各自 `toGraphData(...)` 直接替换，等于把拖动结果冲掉 ——
 * 表现就是"拖动后节点弹回 / 建新节点前面的节点也没了"。
 */
function placed(deviceId: string, payload: GraphPayload, current: GraphState): GraphData {
  const mapped = toGraphData(deviceId || SCRIPT_SCOPE, payload, undefined);
  preloadTemplates(mapped.recognizers.map((item) => item.label));
  const withStored = applyPositions(mapped, loadStoredPositions());
  return preservePositions(withStored, graphForDevice(current, deviceId));
}

/** 坐标写入 localStorage 的节流器：拖动是连续的，别每帧写一遍（也不该阻塞拖动） */
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

export const useGraphStore = create<GraphState>()((set, get) => ({
  graphs: {},
  raws: {},
  selectedEdgeId: null,
  selectedNodeId: null,

  refresh: async (deviceId) => {
    /*
     * **不带 deviceId**：读的是项目里的脚本，所以没连设备也能看到图
     * （以前必须传 deviceId，没设备就报"缺少参数 deviceId"，画布空着还提示先连设备）。
     * 失败只写一行界面日志：调用方都是 `void refresh(...)`，别把拒绝抛到控制台。
     */
    try {
      const raw = await graphGet();
      set((state) => commit(state, deviceId, placed(deviceId, raw, state), raw));
    } catch (error) {
      devLog(`拉状态图失败: ${String(error)}`);
    }
  },

  ensure: (deviceId) =>
    set((state) => {
      if (graphForDevice(state, deviceId)) {
        return state;
      }
      // 只有连上真引擎读到 graph.json 才会有内容；这里先给一张空图，避免界面冒出假节点
      const empty: GraphData = {
        deviceId: deviceId || SCRIPT_SCOPE,
        nodes: [],
        edges: [],
        recognizers: [],
        variables: [],
        activeNodeId: null,
        pendingNodeId: null,
      };
      return commit(state, deviceId, empty);
    }),

  addRecognizer: (deviceId, recognizer) =>
    set((state) => {
      const graph = graphForDevice(state, deviceId);
      if (!graph || graph.recognizers.some((item) => item.label === recognizer.label)) {
        return state;
      }
      return commit(state, deviceId, { ...graph, recognizers: [...graph.recognizers, recognizer] });
    }),

  addNode: (deviceId, node) =>
    set((state) => {
      const graph = graphForDevice(state, deviceId);
      if (!graph || graph.nodes.some((item) => item.id === node.id)) {
        return state;
      }
      return commit(state, deviceId, { ...graph, nodes: [...graph.nodes, node] });
    }),

  addEdge: (deviceId, edge) =>
    set((state) => {
      const graph = graphForDevice(state, deviceId);
      if (!graph) {
        return state;
      }
      return commit(state, deviceId, { ...graph, edges: [...graph.edges, edge] });
    }),

  updateRecognizerThreshold: (deviceId, label, threshold) =>
    set((state) => {
      const graph = graphForDevice(state, deviceId);
      if (!graph) {
        return state;
      }
      const recognizers = graph.recognizers.map((item) =>
        item.label === label ? { ...item, threshold } : item,
      );
      return commit(state, deviceId, { ...graph, recognizers });
    }),

  updateNodeEnter: (deviceId, nodeId, label) =>
    set((state) => {
      const graph = graphForDevice(state, deviceId);
      if (!graph) {
        return state;
      }
      const nodes = graph.nodes.map((item) =>
        item.id === nodeId && !item.enter.includes(label) ? { ...item, enter: [...item.enter, label] } : item,
      );
      return commit(state, deviceId, { ...graph, nodes });
    }),

  moveNode: (deviceId, nodeId, x, y) =>
    set((state) => {
      const graph = graphForDevice(state, deviceId);
      if (!graph) {
        return state;
      }
      const nodes = graph.nodes.map((item) => (item.id === nodeId ? { ...item, x, y } : item));
      const next = { ...graph, nodes };
      // 拖完就记一笔：引擎回包（连接/录制/建节点）都会重排，没有这份记忆位置就守不住
      remember(next);
      return commit(state, deviceId, next);
    }),

  selectNode: (nodeId) => set({ selectedNodeId: nodeId, selectedEdgeId: null }),

  /*
   * 选中边时**保留**节点选中：节点靠 `selectedNodeId` 摊开引脚（"这个界面有哪些操作"），
   * 点节点里的某一步操作去编辑时，把节点收起来会让人失去上下文 —— 用户反馈过。
   * 反过来点节点仍会收起边：焦点转到节点上（详情面板显示节点编辑器）。
   */
  selectEdge: (edgeId) => set({ selectedEdgeId: edgeId }),

  setGraph: (deviceId, graph, raw, options) => {
    // 状态图一到手就预取模板截图：画布上的缩略图、底部详情、识别器面板共用同一份缓存，
    // 免得每个组件各请求一次（引擎保存重载时的瞬时失败会让它们同时变成"×"，看着像模板丢了）
    preloadTemplates(graph.recognizers.map((item) => item.label));
    if (options?.resetPositions) {
      clearStoredPositions(); // "重新布局"= 明确丢弃摆位记忆
    }
    set((state) => {
      if (options?.resetPositions) {
        return commit(state, deviceId, graph, raw);
      }
      // 引擎回包只有网格坐标（引擎不存 x/y），用户拖过的位置必须从"上一份界面图 + 本地记忆"里保住，
      // 否则每次回包节点都会弹回网格，看起来就是"拖动后节点消失"。
      // 顺序：本地记忆打底（冷启动用），内存里的最新位置优先。
      const withStored = applyPositions(graph, loadStoredPositions());
      const kept = preservePositions(withStored, graphForDevice(state, deviceId));
      return commit(state, deviceId, kept, raw);
    });
  },

  saveEdge: async (deviceId, edgeId, patch) => {
    const state = get();
    const raw = rawFor(state, deviceId);
    if (!raw) {
      return;
    }
    const edges = (raw.edges ?? []).map((edge) => (edge.id === edgeId ? { ...edge, ...patch } : edge));
    // 项目级保存：不带 deviceId，引擎落盘 + 让所有会话热重载
    const saved = await graphSave({ ...raw, edges });
    set((current) => commit(current, deviceId, placed(deviceId, saved, current), saved));
  },

  removeEdge: async (deviceId, edgeId) => {
    const state = get();
    const raw = rawFor(state, deviceId);
    if (!raw) {
      return;
    }
    const edges = (raw.edges ?? []).filter((edge: Record<string, unknown>) => edge.id !== edgeId);
    const saved = await graphSave({ ...raw, edges });
    set((current) => ({
      ...commit(current, deviceId, placed(deviceId, saved, current), saved),
      selectedEdgeId: null,
    }));
  },

  createNode: async (deviceId: string, name: string, enter?: string[]) => {
    try {
      const result = await graphNodeAdd({ name, enter });
      set((current) => commit(current, deviceId, placed(deviceId, result.graph, current), result.graph));
      return result.nodeId;
    } catch {
      return null;
    }
  },

  updateNode: async (
    deviceId: string,
    nodeId: string,
    patch: { name?: string; enter?: string[]; timeout_ms?: number },
  ) => {
    const result = await graphNodeUpdate(nodeId, patch);
    set((current) => commit(current, deviceId, placed(deviceId, result.graph, current), result.graph));
  },

  removeNode: async (deviceId: string, nodeId: string) => {
    const result = await graphNodeRemove(nodeId);
    set((current) => commit(current, deviceId, placed(deviceId, result.graph, current), result.graph));
  },

  setVariables: async (
    deviceId: string,
    variables: Record<string, { type?: string; value?: string | number | boolean }>,
  ) => {
    const raw = rawFor(get(), deviceId);
    if (!raw) {
      return;
    }
    await graphSave({ ...raw, variables });
    const saved = await graphGet();
    set((current) => commit(current, deviceId, placed(deviceId, saved, current), saved));
  },

  addBranch: async (deviceId: string, from: string, label: string, yes: string, no: string) => {
    // "如果『X』在 → 去 A；不在 → 去 B" —— 就是两条边，条件分别是 all_of / none_of
    await graphEdgeAdd({ from, to: yes, when: label, condition: { all_of: [label] } });
    const result = await graphEdgeAdd({
      from,
      to: no,
      when: label,
      condition: { none_of: [label] },
      action: { type: 'wait', seconds: 0.3 },
    });
    set((current) => commit(current, deviceId, placed(deviceId, result.graph, current), result.graph));
  },

  connectNodes: async (deviceId: string, from: string, to: string) => {
    const result = await graphEdgeAdd({ from, to });
    set((current) => commit(current, deviceId, placed(deviceId, result.graph, current), result.graph));
  },

  addStep: async (deviceId, from, to, patch) => {
    try {
      const result = await graphEdgeAdd({ from, to, ...patch });
      set((current) => commit(current, deviceId, placed(deviceId, result.graph, current), result.graph));
      return result.edgeId ?? null;
    } catch (error) {
      devLog(`建这一步失败: ${String(error)}`);
      return null;
    }
  },

  updateLive: (deviceId, live) =>
    set((state) => {
      // 结构取脚本那份（没连设备时也在），实时态只写到这台设备自己的缓存里
      const graph = graphForDevice(state, deviceId);
      if (!graph || !deviceId) {
        return state;
      }
      const hits = new Map(live.detections.map((item) => [item.label, item] as const));
      const recognizers = graph.recognizers.map((item) => {
        const hit = hits.get(item.label);
        return hit
          ? { ...item, score: hit.score, state: hit.state as RecognizerView['state'] }
          : { ...item, score: 0, state: 'idle' as const };
      });
      return {
        graphs: {
          ...state.graphs,
          [deviceId]: {
            ...graph,
            recognizers,
            activeNodeId: live.node ?? graph.activeNodeId,
            pendingNodeId: live.pending,
          },
        },
      };
    }),
}));
