/**
 * 状态图 store：按设备分别保存状态图。
 *
 * 多设备的关键点：**每台设备有自己的 graph**（各自的识别器、节点、运行态），
 * 切换设备标签只是切换"看哪张图"，不重载也不互相污染。
 */
import { create } from 'zustand';

import { toGraphData } from '@/lib/graph-adapter';
import { graphSave, type GraphEdgePayload, type GraphPayload } from '@/lib/rpc';
import type { GraphData, GraphEdgeView, GraphNodeView, RecognizerView } from '@/types';

interface GraphState {
  readonly graphs: Readonly<Record<string, GraphData>>;
  /** 引擎来的原始 graph.json（改边/改条件后要原样写回，界面模型有损） */
  readonly raws: Readonly<Record<string, GraphPayload>>;
  readonly selectedEdgeId: string | null;
  readonly ensure: (deviceId: string) => void;
  readonly addRecognizer: (deviceId: string, recognizer: RecognizerView) => void;
  readonly addNode: (deviceId: string, node: GraphNodeView) => void;
  readonly addEdge: (deviceId: string, edge: GraphEdgeView) => void;
  readonly updateRecognizerThreshold: (deviceId: string, label: string, threshold: number) => void;
  readonly updateNodeEnter: (deviceId: string, nodeId: string, label: string) => void;
  readonly moveNode: (deviceId: string, nodeId: string, x: number, y: number) => void;
  readonly selectEdge: (edgeId: string | null) => void;
  /** 引擎给出的状态图（唯一真源） */
  readonly setGraph: (deviceId: string, graph: GraphData, raw?: GraphPayload) => void;
  /** 改一条边（判断条件/动作/优先级等）→ 写回引擎并刷新界面模型 */
  readonly saveEdge: (deviceId: string, edgeId: string, patch: Partial<GraphEdgePayload>) => Promise<void>;
  /** 删除一条边 */
  readonly removeEdge: (deviceId: string, edgeId: string) => Promise<void>;
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

function update(deviceId: string, graph: GraphData, changes: Partial<GraphData>): Record<string, GraphData> {
  return { [deviceId]: { ...graph, ...changes } };
}

export const useGraphStore = create<GraphState>()((set, get) => ({
  graphs: {},
  raws: {},
  selectedEdgeId: null,

  ensure: (deviceId) =>
    set((state) => {
      if (state.graphs[deviceId]) {
        return state;
      }
      // 只有连上真引擎读到 graph.json 才会有内容；这里先给一张空图，避免界面冒出假节点
      const empty: GraphData = {
        deviceId,
        nodes: [],
        edges: [],
        recognizers: [],
        activeNodeId: null,
        pendingNodeId: null,
      };
      return { graphs: { ...state.graphs, [deviceId]: empty } };
    }),

  addRecognizer: (deviceId, recognizer) =>
    set((state) => {
      const graph = state.graphs[deviceId];
      if (!graph || graph.recognizers.some((item) => item.label === recognizer.label)) {
        return state;
      }
      return {
        graphs: {
          ...state.graphs,
          ...update(deviceId, graph, { recognizers: [...graph.recognizers, recognizer] }),
        },
      };
    }),

  addNode: (deviceId, node) =>
    set((state) => {
      const graph = state.graphs[deviceId];
      if (!graph || graph.nodes.some((item) => item.id === node.id)) {
        return state;
      }
      return { graphs: { ...state.graphs, ...update(deviceId, graph, { nodes: [...graph.nodes, node] }) } };
    }),

  addEdge: (deviceId, edge) =>
    set((state) => {
      const graph = state.graphs[deviceId];
      if (!graph) {
        return state;
      }
      return { graphs: { ...state.graphs, ...update(deviceId, graph, { edges: [...graph.edges, edge] }) } };
    }),

  updateRecognizerThreshold: (deviceId, label, threshold) =>
    set((state) => {
      const graph = state.graphs[deviceId];
      if (!graph) {
        return state;
      }
      const recognizers = graph.recognizers.map((item) =>
        item.label === label ? { ...item, threshold } : item,
      );
      return { graphs: { ...state.graphs, ...update(deviceId, graph, { recognizers }) } };
    }),

  updateNodeEnter: (deviceId, nodeId, label) =>
    set((state) => {
      const graph = state.graphs[deviceId];
      if (!graph) {
        return state;
      }
      const nodes = graph.nodes.map((item) =>
        item.id === nodeId && !item.enter.includes(label) ? { ...item, enter: [...item.enter, label] } : item,
      );
      return { graphs: { ...state.graphs, ...update(deviceId, graph, { nodes }) } };
    }),

  moveNode: (deviceId, nodeId, x, y) =>
    set((state) => {
      const graph = state.graphs[deviceId];
      if (!graph) {
        return state;
      }
      const nodes = graph.nodes.map((item) => (item.id === nodeId ? { ...item, x, y } : item));
      return { graphs: { ...state.graphs, ...update(deviceId, graph, { nodes }) } };
    }),

  selectEdge: (edgeId) => set({ selectedEdgeId: edgeId }),

  setGraph: (deviceId, graph, raw) =>
    set((state) => ({
      graphs: { ...state.graphs, [deviceId]: graph },
      raws: raw ? { ...state.raws, [deviceId]: raw } : state.raws,
    })),

  saveEdge: async (deviceId, edgeId, patch) => {
    const state = get();
    const raw = state.raws[deviceId];
    if (!raw) {
      return;
    }
    const edges = (raw.edges ?? []).map((edge) => (edge.id === edgeId ? { ...edge, ...patch } : edge));
    const saved = await graphSave(deviceId, { ...raw, edges });
    set((current) => ({
      raws: { ...current.raws, [deviceId]: saved },
      graphs: {
        ...current.graphs,
        // 第三个参数是"当帧实时命中"，这里没有（下一帧 updateLive 会补上分数）
        [deviceId]: toGraphData(deviceId, saved, undefined),
      },
    }));
  },

  removeEdge: async (deviceId, edgeId) => {
    const state = get();
    const raw = state.raws[deviceId];
    if (!raw) {
      return;
    }
    const edges = (raw.edges ?? []).filter((edge: Record<string, unknown>) => edge.id !== edgeId);
    const saved = await graphSave(deviceId, { ...raw, edges });
    set((current) => ({
      raws: { ...current.raws, [deviceId]: saved },
      graphs: {
        ...current.graphs,
        // 第三个参数是"当帧实时命中"，这里没有（下一帧 updateLive 会补上分数）
        [deviceId]: toGraphData(deviceId, saved, undefined),
      },
      selectedEdgeId: null,
    }));
  },

  updateLive: (deviceId, live) =>
    set((state) => {
      const graph = state.graphs[deviceId];
      if (!graph) {
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
