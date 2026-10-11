/**
 * 画布框选 + 多选删除。
 *
 * 背景（用户反馈）：
 *   1. "鼠标放上去为啥默认是个小手" —— 左键拖空白原来是**平移**，xyflow 因此给画布常驻
 *      `cursor: grab`；框选只能靠 Shift+拖（没人知道）；
 *   2. "怎么框选多个节点删除" —— 没有多选，删除只能一个个右键。
 *
 * 现在：左键拖空白 = 框选（`selectionOnDrag`），平移给中键 / 空格+拖动（`panOnDrag={[1]}`），
 * Delete / Backspace 或工具条上的「删除」都能删选中项。
 *
 * 这里把 ReactFlow 换成探针，直接检查交互配置和回调 → store 的那条链路。
 */
import { act, render, screen } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphPane } from '@/features/graph/GraphPane';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';

interface ProbeNode {
  id: string;
  selected?: boolean;
}

const probe = vi.hoisted(() => ({
  props: null as null | {
    selectionOnDrag?: boolean;
    panOnDrag?: boolean | number[];
    deleteKeyCode?: string | string[] | null;
    multiSelectionKeyCode?: string | string[] | null;
    nodes: ProbeNode[];
    onSelectionChange?: (params: { nodes: ProbeNode[] }) => void;
    onNodesDelete?: (nodes: ProbeNode[]) => void;
    onEdgesDelete?: (edges: Array<{ id: string }>) => void;
  },
}));

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: unknown) => {
    probe.props = props as typeof probe.props;
    return null;
  },
  MiniMap: () => null,
  Controls: () => null,
  Background: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  MarkerType: { ArrowClosed: 'arrowclosed' },
  ConnectionMode: { Strict: 'strict', Loose: 'loose' },
  BackgroundVariant: { Dots: 'dots' },
  // 官方 useNodesState 的最小替身：本用例不测拖动，只要它把节点交回来
  useNodesState: (initial: unknown[]) => {
    const [nodes, setNodes] = useState(initial as ProbeNode[]);
    const onNodesChange = useCallback(() => undefined, []);
    return [nodes, setNodes, onNodesChange];
  },
}));

// devLog 会 invoke('dev_log')：单测里把 Tauri 那层挡掉，否则控制台全是"reading 'invoke'"噪音
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const DEVICE = 'mock:1';

function setup(): { removeNode: ReturnType<typeof vi.fn>; removeEdge: ReturnType<typeof vi.fn> } {
  const removeNode = vi.fn(() => Promise.resolve());
  const removeEdge = vi.fn(() => Promise.resolve());
  useDeviceStore.setState({ activeId: DEVICE });
  useGraphStore.setState({
    selectedNodeId: null,
    selectedEdgeId: null,
    removeNode,
    removeEdge,
    graphs: {
      [DEVICE]: {
        deviceId: DEVICE,
        nodes: [
          { id: 'n_1', name: '界面1', enter: [], x: 0, y: 0, visits: 0 },
          { id: 'n_2', name: '界面2', enter: [], x: 200, y: 0, visits: 0 },
          { id: 'n_3', name: '界面3', enter: [], x: 400, y: 0, visits: 0 },
        ],
        edges: [],
        recognizers: [],
        variables: [],
        activeNodeId: null,
        pendingNodeId: null,
      },
    },
  });
  render(<GraphPane />);
  return { removeNode, removeEdge };
}

/** 模拟"框选到这两个节点"（React Flow 的 onSelectionChange） */
function selectNodes(ids: string[]): void {
  act(() => {
    probe.props?.onSelectionChange?.({ nodes: ids.map((id) => ({ id })) });
  });
}

describe('画布手势：左键框选，不是拖动平移', () => {
  beforeEach(() => {
    probe.props = null;
  });

  it('左键拖空白 = 框选（selectionOnDrag），平移只留给中键', () => {
    setup();

    expect(probe.props?.selectionOnDrag).toBe(true);
    // 关键：panOnDrag 不含 0（左键）—— 含 0 时 xyflow 会给画布加 cursor: grab，就是那个"小手"
    expect(probe.props?.panOnDrag).toEqual([1]);
    expect(probe.props?.multiSelectionKeyCode).toEqual(['Shift', 'Meta', 'Control']);
  });

  it('Delete 和 Backspace 都能删（macOS 键盘上 Delete 要按 Fn+Backspace）', () => {
    setup();

    expect(probe.props?.deleteKeyCode).toEqual(['Delete', 'Backspace']);
  });
});

describe('框选多个界面 → 删除', () => {
  beforeEach(() => {
    probe.props = null;
  });

  it('框选 2 个：节点被标成选中，工具条报数', () => {
    setup();

    expect(screen.queryByTestId('selection-count')).toBeNull();

    selectNodes(['n_1', 'n_3']);

    expect(screen.getByTestId('selection-count')).toHaveTextContent('已选 2 个界面');
    const selected = (probe.props?.nodes ?? []).filter((node) => node.selected).map((node) => node.id);
    expect(selected).toEqual(['n_1', 'n_3']);
  });

  it('点「删除」：逐个让引擎删（引擎会把它连着的边一起删），并清掉选中态', async () => {
    const { removeNode } = setup();
    selectNodes(['n_1', 'n_2']);

    await act(async () => {
      screen.getByTestId('delete-selection').click();
    });

    expect(removeNode).toHaveBeenCalledTimes(2);
    expect(removeNode.mock.calls.map((call) => call[1])).toEqual(['n_1', 'n_2']);
    expect(screen.queryByTestId('selection-count')).toBeNull();
  });

  it('Delete 键（xyflow 的 onNodesDelete）走同一条删除路径', async () => {
    const { removeNode } = setup();

    await act(async () => {
      probe.props?.onNodesDelete?.([{ id: 'n_2' }]);
    });

    expect(removeNode).toHaveBeenCalledTimes(1);
    expect(removeNode).toHaveBeenCalledWith(DEVICE, 'n_2');
  });

  it('删的正好是"下方编辑器在编辑的那一个"：编辑器一并收起（否则在编辑一个不存在的界面）', async () => {
    const { removeNode } = setup();
    act(() => {
      useGraphStore.setState({ selectedNodeId: 'n_1' });
    });

    await act(async () => {
      probe.props?.onNodesDelete?.([{ id: 'n_1' }]);
    });

    expect(removeNode).toHaveBeenCalledWith(DEVICE, 'n_1');
    expect(useGraphStore.getState().selectedNodeId).toBeNull();
  });

  it('边被删除键删掉时同步到引擎（单独删边那条路）', async () => {
    const { removeEdge } = setup();

    await act(async () => {
      probe.props?.onEdgesDelete?.([{ id: 'e_1' }, { id: 'e_2' }]);
    });

    expect(removeEdge.mock.calls.map((call) => call[1])).toEqual(['e_1', 'e_2']);
  });

  it('画布上写明了怎么框选 / 怎么平移（不然没人知道左键不再是平移）', () => {
    setup();

    expect(screen.getByText(/拖动空白 = 框选多个界面/)).toBeInTheDocument();
    expect(screen.getByText(/空格\/中键拖动 = 平移画布/)).toBeInTheDocument();
  });
});
