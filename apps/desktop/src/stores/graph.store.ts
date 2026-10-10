/**
 * 状态图 store：按设备分别保存状态图。
 *
 * 多设备的关键点：**每台设备有自己的 graph**（各自的识别器、节点、运行态），
 * 切换设备标签只是切换"看哪张图"，不重载也不互相污染。
 */
import { create } from 'zustand';

import { mockGraph } from '@/mock/seed';
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
}

function update(deviceId: string, graph: GraphData, changes: Partial<GraphData>): Record<string, GraphData> {
  return { [deviceId]: { ...graph, ...changes } };
}

export const useGraphStore = create<GraphState>()((set) => ({
  graphs: {},
  selectedEdgeId: null,

  ensure: (deviceId) =>
    set((state) =>
      state.graphs[deviceId] ? state : { graphs: { ...state.graphs, [deviceId]: mockGraph(deviceId) } },
    ),

  addRecognizer: (deviceId, recognizer) =>
    set((state) => {
      const graph = state.graphs[deviceId] ?? mockGraph(deviceId);
      if (graph.recognizers.some((item) => item.label === recognizer.label)) {
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
      const graph = state.graphs[deviceId] ?? mockGraph(deviceId);
      if (graph.nodes.some((item) => item.id === node.id)) {
        return state;
      }
      return { graphs: { ...state.graphs, ...update(deviceId, graph, { nodes: [...graph.nodes, node] }) } };
    }),

  addEdge: (deviceId, edge) =>
    set((state) => {
      const graph = state.graphs[deviceId] ?? mockGraph(deviceId);
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
}));
