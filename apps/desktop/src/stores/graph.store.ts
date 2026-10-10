/**
 * 状态图 store：按设备分别保存状态图。
 *
 * 多设备的关键点：**每台设备有自己的 graph**（各自的识别器、节点、运行态），
 * 切换设备标签只是切换"看哪张图"，不重载也不互相污染。
 */
import { create } from 'zustand';

import type { GraphData, GraphEdgeView, GraphNodeView, RecognizerView } from '@/types';

interface GraphState {
  readonly graphs: Readonly<Record<string, GraphData>>;
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
  readonly setGraph: (deviceId: string, graph: GraphData) => void;
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

export const useGraphStore = create<GraphState>()((set) => ({
  graphs: {},
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

  setGraph: (deviceId, graph) => set((state) => ({ graphs: { ...state.graphs, [deviceId]: graph } })),

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
