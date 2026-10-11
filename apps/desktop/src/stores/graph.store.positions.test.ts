/**
 * 坐标不能被引擎回包冲掉 —— 用户反馈"拖动后节点消失 / 右键建节点前面的节点也没了"的回归测试。
 *
 * 引擎不存节点坐标（x/y 是界面私有的），所以 store 每次收到回包都要把用户摆过的位置套回去。
 * 以前有 8 处各自 `toGraphData(...)` 直接替换，等于把拖动结果冲掉；现在全部走 `placed(...)`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphPayload } from '@/lib/rpc';
import { setPositionScope } from '@/lib/node-positions';
import { toGraphData } from '@/lib/graph-adapter';
import { useGraphStore } from '@/stores/graph.store';

const graphNodeAdd = vi.fn((..._args: unknown[]): Promise<{ nodeId: string; graph: GraphPayload }> =>
  Promise.resolve({ nodeId: '', graph: {} as GraphPayload }),
);
vi.mock('@/lib/rpc', () => ({
  graphNodeAdd: (deviceId: string, params: unknown): Promise<unknown> => graphNodeAdd(deviceId, params),
  graphGet: (): Promise<unknown> => Promise.resolve({}),
  graphSave: (): Promise<unknown> => Promise.resolve({}),
  graphNodeUpdate: (): Promise<unknown> => Promise.resolve({ graph: {} }),
  graphNodeRemove: (): Promise<unknown> => Promise.resolve({ graph: {} }),
  graphEdgeAdd: (): Promise<unknown> => Promise.resolve({ graph: {} }),
  graphEdgeUpdate: (): Promise<unknown> => Promise.resolve({ graph: {} }),
  graphEdgeRemove: (): Promise<unknown> => Promise.resolve({ graph: {} }),
  devLog: (): void => undefined,
}));

const DEVICE = 'dev';

/** 引擎回包：只有 id/name/enter，没有坐标（真实引擎就是这样） */
function payload(ids: readonly string[]): GraphPayload {
  return {
    version: 1,
    nodes: ids.map((id) => ({ id, name: id, enter: [] })),
    edges: [],
    recognizers: {},
  } as unknown as GraphPayload;
}

function nodeAt(id: string): { x: number; y: number } | undefined {
  const node = useGraphStore.getState().graphs[DEVICE]?.nodes.find((item) => item.id === id);
  return node ? { x: node.x, y: node.y } : undefined;
}

describe('节点坐标记忆（store 层）', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setPositionScope('/repo/workspaces/默认/斗技');
    useGraphStore.setState({ graphs: {}, raws: {}, selectedNodeId: null, selectedEdgeId: null });
    graphNodeAdd.mockReset();
  });

  it('引擎回包不会把拖动后的坐标冲回网格', () => {
    useGraphStore.getState().setGraph(DEVICE, {
      deviceId: DEVICE,
      nodes: [
        { id: 'n1', name: 'A', enter: [], x: 60, y: 40, visits: 0 },
        { id: 'n2', name: 'B', enter: [], x: 260, y: 40, visits: 0 },
      ],
      edges: [],
      variables: [],
      recognizers: [],
      activeNodeId: null,
      pendingNodeId: null,
    });

    useGraphStore.getState().moveNode(DEVICE, 'n1', 420, 300);
    expect(nodeAt('n1')).toEqual({ x: 420, y: 300 });

    // 引擎回包（例如连接/录制/切脚本）——以前这里节点会弹回 60,40
    useGraphStore.getState().setGraph(DEVICE, {
      deviceId: DEVICE,
      nodes: [
        { id: 'n1', name: 'A', enter: [], x: 60, y: 40, visits: 0 },
        { id: 'n2', name: 'B', enter: [], x: 260, y: 40, visits: 0 },
      ],
      edges: [],
      variables: [],
      recognizers: [],
      activeNodeId: null,
      pendingNodeId: null,
    });

    expect(nodeAt('n1')).toEqual({ x: 420, y: 300 });
  });

  it('新建节点（引擎回包）不会让已有节点弹回网格', async () => {
    useGraphStore.getState().setGraph(DEVICE, {
      deviceId: DEVICE,
      nodes: [{ id: 'n1', name: 'A', enter: [], x: 60, y: 40, visits: 0 }],
      edges: [],
      variables: [],
      recognizers: [],
      activeNodeId: null,
      pendingNodeId: null,
    });
    useGraphStore.getState().moveNode(DEVICE, 'n1', 500, 360);

    // createNode：引擎回包带两个节点（只有网格坐标）
    graphNodeAdd.mockResolvedValueOnce({ nodeId: 'n2', graph: payload(['n1', 'n2']) });
    const created = await useGraphStore.getState().createNode(DEVICE, '新界面');

    expect(created).toBe('n2');
    expect(nodeAt('n1')).toEqual({ x: 500, y: 360 }); // 老节点守住摆位
    expect(nodeAt('n2')).toBeDefined(); // 新节点用引擎的网格坐标
  });

  it('「重新布局」显式丢弃摆位记忆', () => {
    useGraphStore.getState().setGraph(DEVICE, {
      deviceId: DEVICE,
      nodes: [{ id: 'n1', name: 'A', enter: [], x: 60, y: 40, visits: 0 }],
      edges: [],
      variables: [],
      recognizers: [],
      activeNodeId: null,
      pendingNodeId: null,
    });
    useGraphStore.getState().moveNode(DEVICE, 'n1', 700, 500);

    useGraphStore.getState().setGraph(
      DEVICE,
      {
        deviceId: DEVICE,
        nodes: [{ id: 'n1', name: 'A', enter: [], x: 60, y: 40, visits: 0 }],
        edges: [],
        variables: [],
        recognizers: [],
        activeNodeId: null,
        pendingNodeId: null,
      },
      undefined,
      { resetPositions: true },
    );

    expect(nodeAt('n1')).toEqual({ x: 60, y: 40 });
  });

  it('冷启动（内存里没有图）用 localStorage 里的坐标', async () => {
    useGraphStore.getState().setGraph(DEVICE, {
      deviceId: DEVICE,
      nodes: [{ id: 'n1', name: 'A', enter: [], x: 60, y: 40, visits: 0 }],
      edges: [],
      variables: [],
      recognizers: [],
      activeNodeId: null,
      pendingNodeId: null,
    });
    useGraphStore.getState().moveNode(DEVICE, 'n1', 333, 222);

    // 模拟重启：清内存 + 重新落位（localStorage 里还留着 333,222）
    // 写入是 250ms 节流的（拖动是连续的，不能每帧写一遍），这里等它落盘
    await new Promise((resolve) => setTimeout(resolve, 320));

    useGraphStore.setState({ graphs: {} });
    useGraphStore.getState().setGraph(DEVICE, {
      deviceId: DEVICE,
      nodes: [{ id: 'n1', name: 'A', enter: [], x: 60, y: 40, visits: 0 }],
      edges: [],
      variables: [],
      recognizers: [],
      activeNodeId: null,
      pendingNodeId: null,
    });

    expect(nodeAt('n1')).toEqual({ x: 333, y: 222 });
  });

  it('切设备不会换一套布局：记忆按脚本，不按设备', async () => {
    useGraphStore.getState().setGraph(DEVICE, {
      deviceId: DEVICE,
      nodes: [{ id: 'n1', name: 'A', enter: [], x: 60, y: 40, visits: 0 }],
      edges: [],
      variables: [],
      recognizers: [],
      activeNodeId: null,
      pendingNodeId: null,
    });
    useGraphStore.getState().moveNode(DEVICE, 'n1', 500, 360);
    // 等节流落盘：切设备时读的就是这份记忆（以前键里带设备 id，B 设备读到的是另一份 → 布局自己变）
    await new Promise((resolve) => setTimeout(resolve, 320));

    const fromEngine = payload(['n1']);
    useGraphStore.getState().setGraph('devB', toGraphData('devB', fromEngine), fromEngine);

    const onB = useGraphStore.getState().graphs.devB?.nodes.find((item) => item.id === 'n1');
    expect({ x: onB?.x, y: onB?.y }).toEqual({ x: 500, y: 360 });
  });
});
