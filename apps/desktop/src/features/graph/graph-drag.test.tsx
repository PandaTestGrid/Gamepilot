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
  },
}));

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: unknown) => {
    probe.props = props as typeof probe.props;
    return null;
  },
  Background: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  MarkerType: { ArrowClosed: 'arrowclosed' },
  ConnectionMode: { Loose: 'loose' },
  BackgroundVariant: { Dots: 'dots' },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

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

  it('松手后交回 store 的坐标（真源仍是状态图，落盘只有 onNodeDragStop 一条路）', () => {
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
    expect(probe.props?.nodes[0]?.position).toEqual({ x: 100, y: 100 });
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
});
