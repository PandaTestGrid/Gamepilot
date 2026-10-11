/**
 * 状态图拖动跟随的回归测试。
 *
 * 背景（真实踩过）：React Flow 被控模式（传了 `nodes`）下**不会**自己落位置 ——
 * 内核的 `triggerNodeChanges` 只在非受控时才 applyNodeChanges，受控时只是回调 `onNodesChange`。
 * 官方示例都接了 `onNodesChange`，我们没接，于是"按住拖动画面不动、松手才跳过去"。
 *
 * 这里把 ReactFlow 换成探针，直接检查：拖动中的实时坐标必须喂回 `nodes`；
 * 松手后交回 store 的坐标（落盘仍走 onNodeDragStop 那条唯一路径）。
 */
import { act, render } from '@testing-library/react';
import { useCallback as reactUseCallback, useState as reactUseState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphPane } from '@/features/graph/GraphPane';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';

const probe = vi.hoisted(() => ({
  props: null as null | {
    nodes: Array<{
      id: string;
      position: { x: number; y: number };
      data: { expanded?: boolean; active?: boolean };
    }>;
    edges: Array<{ id: string; selected?: boolean; style?: { strokeWidth?: number } }>;
    onNodesChange: (changes: unknown[]) => void;
    onEdgeMouseEnter: (event: unknown, edge: { id: string }) => void;
    onEdgeMouseLeave: () => void;
    onNodeClick: (event: unknown, node: { id: string }) => void;
    onPaneClick: (event: { target: Element }) => void;
    onNodeDrag: (event: unknown, node: { id: string; position: { x: number; y: number } }) => void;
    onNodeDragStop: (
      event: unknown,
      node: { id: string; position: { x: number; y: number } },
      nodes?: Array<{ id: string; position: { x: number; y: number } }>,
    ) => void;
  },
}));

/**
 * 探针：把 ReactFlow 换成"只记录 props"，同时**照官方语义**实现 useNodesState +
 * applyNodeChanges（position/dimensions/select），这样测的就是官方状态机的行为。
 */
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: unknown) => {
    probe.props = props as typeof probe.props;
    return null;
  },
  // 小地图 / 官方控件在探针里不需要真渲染，但必须存在（否则 import 就炸）
  MiniMap: () => null,
  Controls: () => null,
  Background: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  MarkerType: { ArrowClosed: 'arrowclosed' },
  ConnectionMode: { Strict: 'strict', Loose: 'loose' },
  BackgroundVariant: { Dots: 'dots' },
  useNodesState: (initial: unknown[]) => {
    const [nodes, setNodes] = reactUseState(initial as never[]);
    const onNodesChange = reactUseCallback((changes: Array<Record<string, unknown>>) => {
      setNodes((current: never[]) => applyChanges(current, changes) as never[]);
    }, []);
    return [nodes, setNodes, onNodesChange];
  },
}));

/** 官方 applyNodeChanges 的最小实现：position / dimensions / select
 *
 * ⚠️ `position` 分支**不能**顺手把 `dragging` 也写上：官方只改 `position`（实测源码：
 * `case 'position': { const position = { ...node.position, ...change.position }; ... }`）。
 * 桩里替官方"补上"这个标记，会让"重建节点时丢了 dragging 标记"这类 bug 永远测不出来
 * （测试里 `dragging` 永远是真的，而真机上它是被我们 `withDragging` 重新打上去的）。
 */
function applyChanges(nodes: never[], changes: Array<Record<string, unknown>>): unknown[] {
  let next = nodes as unknown as Array<Record<string, unknown>>;
  for (const change of changes) {
    next = next.map((node) => {
      if (node.id !== change.id) {
        return node;
      }
      if (change.type === 'position' && change.position) {
        const position = change.position as { x: number; y: number };
        return { ...node, position };
      }
      if (change.type === 'dimensions') {
        const size = change.dimensions as { width: number; height: number } | undefined;
        return size ? { ...node, measured: size, width: size.width, height: size.height } : node;
      }
      if (change.type === 'select') {
        return { ...node, selected: change.selected };
      }
      return node;
    });
  }
  return next;
}

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

/**
 * `graph.get` 的回包：**固定返回这两个界面**（而不是空图）。
 *
 * 为什么必须固定：GraphPane 挂载时会 `refreshGraph`（引擎回包会走 `placed()` 重建界面图）。
 * 回空图的话，任何"等一会儿再断言 store"的用例都会被它清空（异步替换了测试 seed 的内容）——
 * 那种 flaky 不是被测代码的问题，是夹具的问题。回包内容与 seed 一致，等待期间也稳定。
 */
const REFRESH_PAYLOAD = {
  nodes: [
    { id: 'n1', name: '主界面', enter: [] },
    { id: 'n2', name: 'B', enter: [] },
  ],
  edges: [],
  recognizers: {},
  variables: {},
};

vi.mock('@/lib/rpc', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/rpc');
  return {
    ...actual,
    graphGet: vi.fn(() => Promise.resolve(REFRESH_PAYLOAD)),
    devLog: vi.fn(),
  };
});

function seed(): void {
  useDeviceStore.setState({
    devices: [
      {
        id: 'dev',
        name: '检查设备',
        uri: 'mock://dev',
        kind: 'mock',
        status: 'connected',
        resolution: [720, 1280],
        fps: 0,
      },
    ],
    activeId: 'dev',
  });
  useGraphStore.getState().setGraph('dev', {
    deviceId: 'dev',
    nodes: [{ id: 'n1', name: '主界面', enter: [], x: 100, y: 100, visits: 0 }],
    edges: [],
    variables: [],
    recognizers: [],
    activeNodeId: null,
    pendingNodeId: null,
  });
}

describe('状态图拖动', () => {
  beforeEach(() => {
    probe.props = null;
    seed();
  });

  it('拖动中把实时坐标喂回 nodes（不接 onNodesChange 就是"松手才移动"）', () => {
    render(<GraphPane />);
    expect(probe.props?.nodes[0]?.position).toEqual({ x: 100, y: 100 });

    act(() => {
      probe.props?.onNodesChange([
        { id: 'n1', type: 'position', position: { x: 180, y: 150 }, dragging: true },
        // 中间夹杂的选中变化不该影响坐标
        { id: 'n1', type: 'select', selected: true },
      ]);
    });

    expect(probe.props?.nodes[0]?.position).toEqual({ x: 180, y: 150 });
  });

  it('松手：画布不动、位置写回 store（官方分工，本地不再"弹回去"）', () => {
    render(<GraphPane />);

    act(() => {
      probe.props?.onNodesChange([
        { id: 'n1', type: 'position', position: { x: 180, y: 150 }, dragging: true },
      ]);
    });
    expect(probe.props?.nodes[0]?.position).toEqual({ x: 180, y: 150 });

    act(() => {
      probe.props?.onNodesChange([
        { id: 'n1', type: 'position', position: { x: 180, y: 150 }, dragging: false },
      ]);
    });
    // 官方模式下松手画面不跳（以前自定义实现会先弹回 store 的旧坐标，视觉上就是"节点跳走/消失"）
    expect(probe.props?.nodes[0]?.position).toEqual({ x: 180, y: 150 });

    // 落盘只有 onNodeDragStop 一条路：写进状态图 store（引擎回包靠坐标记忆保住它）
    act(() => {
      probe.props?.onNodeDragStop?.(null, { id: 'n1', position: { x: 180, y: 150 } });
    });
    const stored = useGraphStore.getState().graphs.dev?.nodes.find((node) => node.id === 'n1');
    expect({ x: stored?.x, y: stored?.y }).toEqual({ x: 180, y: 150 });
  });

  it('store 里的坐标变了（例如「重新布局」）能覆盖拖动留下的临时坐标', () => {
    render(<GraphPane />);

    act(() => {
      probe.props?.onNodesChange([
        { id: 'n1', type: 'position', position: { x: 999, y: 999 }, dragging: true },
      ]);
      probe.props?.onNodesChange([
        { id: 'n1', type: 'position', position: { x: 999, y: 999 }, dragging: false },
      ]);
    });
    act(() => {
      useGraphStore.getState().moveNode('dev', 'n1', 40, 60);
    });

    expect(probe.props?.nodes[0]?.position).toEqual({ x: 40, y: 60 });
  });

  it('选中态只作用在选中的那一个上：节点摊开、只有那条边加粗', () => {
    const action = { type: 'click' as const, x: 0.5, y: 0.5 };
    const condition = { allOf: [], anyOf: [], noneOf: [], minScore: 0, withinMs: 0, always: true };
    useGraphStore.getState().setGraph('dev', {
      deviceId: 'dev',
      nodes: [
        { id: 'n1', name: '主界面', enter: [], x: 100, y: 100, visits: 0 },
        { id: 'n2', name: '商店', enter: [], x: 400, y: 200, visits: 0 },
      ],
      edges: [
        {
          id: 'e1',
          from: 'n1',
          to: 'n2',
          when: 'always',
          kind: 'normal',
          priority: 0,
          minScore: 0,
          cooldownMs: 0,
          retries: 1,
          action: 'click',
          condition,
          actionSpec: action,
        },
        {
          id: 'e2',
          from: 'n2',
          to: 'n1',
          when: 'always',
          kind: 'normal',
          priority: 0,
          minScore: 0,
          cooldownMs: 0,
          retries: 1,
          action: 'click',
          condition,
          actionSpec: action,
        },
      ],
      variables: [],
      recognizers: [],
      activeNodeId: null,
      pendingNodeId: null,
    });

    // 选节点（节点与边是互斥的：下方编辑器一次只显示一个）
    act(() => {
      useGraphStore.getState().selectNode('n2');
    });
    render(<GraphPane />);

    const nodes = probe.props?.nodes ?? [];
    expect(nodes.find((node) => node.id === 'n2')?.data.expanded).toBe(true);
    expect(nodes.find((node) => node.id === 'n1')?.data.expanded).toBe(false);
    // 没选边时所有边都是细线
    const thin = probe.props?.edges ?? [];
    expect(thin).toHaveLength(2);
    for (const edge of thin) {
      expect(edge.style?.strokeWidth).toBe(1);
    }

    // 再选一条边：只有它加粗（逐条判断；曾经误用外层 selected，结果"选一条全部变粗"）
    act(() => {
      useGraphStore.getState().selectEdge('e2');
    });

    const edges = probe.props?.edges ?? [];
    expect(edges.find((edge) => edge.id === 'e2')).toMatchObject({ selected: true });
    expect(edges.find((edge) => edge.id === 'e2')?.style?.strokeWidth).toBe(2.5);
    expect(edges.find((edge) => edge.id === 'e1')?.style?.strokeWidth).toBe(1);
    expect(edges.find((edge) => edge.id === 'e1')).toMatchObject({ selected: false });

    // 悬停也要有反馈：线宽 1 → 2（CSS 盖不住内联样式，所以走 React 状态）
    act(() => {
      probe.props?.onEdgeMouseEnter(null, { id: 'e1' });
    });
    const hovered = probe.props?.edges ?? [];
    expect(hovered.find((edge) => edge.id === 'e1')?.style?.strokeWidth).toBe(2);
    expect(hovered.find((edge) => edge.id === 'e2')?.style?.strokeWidth).toBe(2.5); // 选中的仍然最粗

    act(() => {
      probe.props?.onEdgeMouseLeave();
    });
    expect((probe.props?.edges ?? []).find((edge) => edge.id === 'e1')?.style?.strokeWidth).toBe(1);
  });

  it('拖动中被"实时更新"打断（每帧都会发生）时，坐标不能被 store 按回去', () => {
    render(<GraphPane />);

    // 开始拖：React Flow 把 dragging 标记打在节点上
    act(() => {
      probe.props?.onNodesChange([
        { id: 'n1', type: 'position', position: { x: 260, y: 210 }, dragging: true },
      ]);
    });
    expect(probe.props?.nodes[0]?.position).toEqual({ x: 260, y: 210 });

    // 拖动中引擎来了一帧：激活态/命中分数变了 → 节点数组重建（真实环境 10fps 一直在发生）
    act(() => {
      useGraphStore.getState().updateLive('dev', {
        node: 'n1',
        pending: null,
        detections: [{ label: '相机', score: 0.91, state: 'confirmed' }],
      });
    });
    // 再来一帧：**连续两次**同步才暴露"重建时丢掉了 dragging 标记"的 bug
    act(() => {
      useGraphStore.getState().updateLive('dev', {
        node: 'n2',
        pending: null,
        detections: [{ label: '相机', score: 0.88, state: 'confirmed' }],
      });
    });
    act(() => {
      useGraphStore.getState().updateLive('dev', {
        node: 'n1',
        pending: null,
        detections: [{ label: '相机', score: 0.95, state: 'confirmed' }],
      });
    });

    // 关键：还在拖的时候，位置必须保持鼠标拖到的地方（store 里仍是 100,100）
    expect(probe.props?.nodes[0]?.position).toEqual({ x: 260, y: 210 });
  });

  it('松手时把"一起被拖的节点"全部写回（多选拖动不能只存一个）', () => {
    useGraphStore.getState().setGraph('dev', {
      deviceId: 'dev',
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
    render(<GraphPane />);

    // 本地状态先跟上（applyNodeChanges 一直在维护它）：两个节点一起被拖
    act(() => {
      probe.props?.onNodesChange([
        { id: 'n1', type: 'position', position: { x: 120, y: 90 }, dragging: true },
        { id: 'n2', type: 'position', position: { x: 320, y: 90 }, dragging: true },
      ]);
    });
    expect(probe.props?.nodes.map((node) => node.position)).toEqual([
      { x: 120, y: 90 },
      { x: 320, y: 90 },
    ]);

    // 松手：回调参数**故意给过期的起始坐标** —— 写回必须以本地为准，否则节点会被按回原位
    act(() => {
      probe.props?.onNodeDragStop?.(null, { id: 'n1', position: { x: 60, y: 40 } }, [
        { id: 'n1', position: { x: 60, y: 40 } },
        { id: 'n2', position: { x: 260, y: 40 } },
      ]);
    });

    const nodes = useGraphStore.getState().graphs.dev?.nodes ?? [];
    expect(nodes.find((node) => node.id === 'n1')).toMatchObject({ x: 120, y: 90 });
    expect(nodes.find((node) => node.id === 'n2')).toMatchObject({ x: 320, y: 90 });
  });

  it('拖动中节流写回 store：store 不会落后到"松手被按回去"', () => {
    render(<GraphPane />);

    act(() => {
      probe.props?.onNodesChange([
        { id: 'n1', type: 'position', position: { x: 210, y: 160 }, dragging: true },
      ]);
    });
    // 回调参数落后一帧也无所谓：写回的是本地最新坐标
    act(() => {
      probe.props?.onNodeDrag?.(null, { id: 'n1', position: { x: 100, y: 100 } });
    });

    const stored = useGraphStore.getState().graphs.dev?.nodes.find((node) => node.id === 'n1');
    expect(stored).toMatchObject({ x: 210, y: 160 });
  });

  it('多选拖动 + 拖动中每帧重建：两个节点都得守住本地坐标（不能只写回调里那一个）', async () => {
    render(<GraphPane />);
    /*
     * ⚠️ 种子种在 render **之后**：GraphPane 挂载时会 `refreshGraph`（引擎回包），
     * 这个用例里 mock 的 graphGet 回的是空图 —— 先种再挂会被它清掉。
     */
    act(() => {
      useGraphStore.getState().setGraph('dev', {
        deviceId: 'dev',
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
    });

    // 一起拖两个：xyflow 的 getDragItems 会把选中的都带上，两条 position(dragging) 一起发
    act(() => {
      probe.props?.onNodesChange([
        { id: 'n1', type: 'position', position: { x: 120, y: 90 }, dragging: true },
        { id: 'n2', type: 'position', position: { x: 320, y: 90 }, dragging: true },
      ]);
    });
    expect(probe.props?.nodes.map((node) => node.position)).toEqual([
      { x: 120, y: 90 },
      { x: 320, y: 90 },
    ]);

    // 越过节流窗口（90ms）再触发一次节流回调：这一笔必须把**两个**都写回 store
    await new Promise((resolve) => setTimeout(resolve, 120));
    act(() => {
      probe.props?.onNodeDrag?.(null, { id: 'n1', position: { x: 120, y: 90 } });
    });
    const stored = useGraphStore.getState().graphs.dev?.nodes ?? [];
    expect(
      { n1: stored.find((n) => n.id === 'n1'), n2: stored.find((n) => n.id === 'n2') },
      '只写了回调里那一个节点：另一个在 store 里还是旧坐标',
    ).toMatchObject({ n1: { x: 120, y: 90 }, n2: { x: 320, y: 90 } });

    // 拖动中的重建（引擎每帧都在推）：两个节点的画面坐标都不能被 store 按回去
    act(() => {
      useGraphStore.getState().updateLive('dev', {
        node: 'n1',
        pending: null,
        detections: [{ label: '相机', score: 0.91, state: 'confirmed' }],
      });
      useGraphStore.getState().updateLive('dev', {
        node: 'n2',
        pending: null,
        detections: [{ label: '相机', score: 0.93, state: 'confirmed' }],
      });
    });

    expect(probe.props?.nodes.map((node) => node.position)).toEqual([
      { x: 120, y: 90 },
      { x: 320, y: 90 },
    ]);
  });

  it('点节点是"选中"而不是开关：再点一次（含点节点里的东西）不该收起', () => {
    render(<GraphPane />);

    act(() => {
      probe.props?.onNodeClick?.(null, { id: 'n1' });
    });
    expect(useGraphStore.getState().selectedNodeId).toBe('n1');

    // 用户反馈：点节点内部的东西也会收起 —— 幂等选中，重复点不变
    act(() => {
      probe.props?.onNodeClick?.(null, { id: 'n1' });
    });
    expect(useGraphStore.getState().selectedNodeId).toBe('n1');

    // 点在节点内部（xyflow 的 pane click 会因冒泡被触发）→ 不算"点空白"，不许收起
    const insideNode = document.createElement('div');
    insideNode.className = 'react-flow__node';
    act(() => {
      probe.props?.onPaneClick?.({ target: insideNode });
    });
    expect(useGraphStore.getState().selectedNodeId).toBe('n1');

    // 真正点画布空白才收起
    act(() => {
      probe.props?.onPaneClick?.({ target: document.createElement('div') });
    });
    expect(useGraphStore.getState().selectedNodeId).toBeNull();
  });
});
