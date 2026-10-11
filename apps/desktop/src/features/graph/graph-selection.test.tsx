/**
 * 画布多选 + 删除。
 *
 * 选中态**只有一个真源：React Flow**。它通过 `onNodesChange` 的 `select` 变更维护选中集，
 * 落在我们的 `rfNodes` 上；图例工具条（「已选 N 个界面」/ 删除）只是把它**读回来**。
 *
 * 为什么不再自己存一份"选中 id 数组"（走过的弯路）：
 *   - 那份数组喂进节点数据形成回环 → 点一个节点显示「已选 4 个界面」、计数乱跳
 *     （官方 `onSelectionChange` 交出来的是**整份** nodeLookup，不是"被选中的那几个"）；
 *   - 而 React Flow 的拖动语义是"把选中的一起拖"，假的选中标记会让"拖一个、动了别的"。
 * 现在手势也用官方默认：Shift+拖动框选、Control 点多选、左键拖空白平移、Shift 拖动框选。
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
    selectionKeyCode?: string | string[] | null;
    multiSelectionKeyCode?: string | string[] | null;
    panOnDrag?: boolean | number[];
    selectionOnDrag?: boolean;
    panOnScroll?: boolean;
    zoomOnScroll?: boolean;
    deleteKeyCode?: string | string[] | null;
    nodes: ProbeNode[];
    onNodesChange?: (changes: Array<Record<string, unknown>>) => void;
    onNodesDelete?: (nodes: ProbeNode[]) => void;
    onEdgesDelete?: (edges: Array<{ id: string }>) => void;
    onPaneContextMenu?: (event: unknown) => void;
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
  /**
   * 官方 `useNodesState` 的最小替身：**真的处理 `select` / `position` 变更**
   * （选中态是这条链路的结果，桩不处理就等于把被测行为抽掉了）。
   */
  useNodesState: (initial: unknown[]) => {
    const [nodes, setNodes] = useState(initial as ProbeNode[]);
    const onNodesChange = useCallback((changes: Array<Record<string, unknown>>) => {
      setNodes((current) =>
        current.map((node) => {
          const change = changes.find((item) => item.id === node.id);
          if (!change) {
            return node;
          }
          if (change.type === 'select') {
            return { ...node, selected: change.selected === true };
          }
          if (change.type === 'position' && change.position) {
            return { ...node, position: change.position };
          }
          return node;
        }),
      );
    }, []);
    return [nodes, setNodes, onNodesChange];
  },
}));

// devLog 会 invoke('dev_log')：单测里把 Tauri 那层挡掉，否则控制台全是"reading 'invoke'"噪音
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const DEVICE = 'mock:1';

type RemoveNodeMock = (deviceId: string, nodeId: string) => Promise<void>;
type RemoveEdgeMock = (deviceId: string, edgeId: string) => Promise<void>;

function setup(): {
  removeNode: ReturnType<typeof vi.fn<RemoveNodeMock>>;
  removeEdge: ReturnType<typeof vi.fn<RemoveEdgeMock>>;
} {
  const removeNode = vi.fn<RemoveNodeMock>(() => Promise.resolve());
  const removeEdge = vi.fn<RemoveEdgeMock>(() => Promise.resolve());
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

/** 模拟"点选/框选到这几个节点"：xyflow 发的是**逐节点的 select 变更**（官方通道） */
function selectNodes(ids: string[]): void {
  act(() => {
    probe.props?.onNodesChange?.(
      ['n_1', 'n_2', 'n_3'].map((id) => ({ id, type: 'select', selected: ids.includes(id) })),
    );
  });
}

describe('画布手势：官方默认（左键平移、Shift 框选、Control 多选）', () => {
  beforeEach(() => {
    probe.props = null;
  });

  it('平移/框选/缩放都不再自己改，只有多选键按要求固定成 Control', () => {
    setup();

    // 不传 = 官方默认：左键拖空白平移、Shift 拖动框选、滚动缩放
    expect(probe.props?.panOnDrag).toBeUndefined();
    expect(probe.props?.selectionOnDrag).toBeUndefined();
    expect(probe.props?.selectionKeyCode).toBeUndefined();
    expect(probe.props?.zoomOnScroll).toBe(true);
    expect(probe.props?.panOnScroll ?? false).toBeFalsy();
    // 多选 = Control（官方在 mac 上是 Meta；用户要求统一成 Control）
    expect(probe.props?.multiSelectionKeyCode).toEqual(['Control']);
  });

  it('Delete 和 Backspace 都能删（macOS 键盘上 Delete 要按 Fn+Backspace）', () => {
    setup();

    expect(probe.props?.deleteKeyCode).toEqual(['Delete', 'Backspace']);
  });
});

describe('多选界面 → 删除', () => {
  beforeEach(() => {
    probe.props = null;
  });

  it('点一个节点 = 已选 1 个（选中态从 xyflow 的 select 变更读回来）', () => {
    setup();

    expect(screen.queryByTestId('selection-count')).toBeNull();
    selectNodes(['n_3']);

    expect(screen.getByTestId('selection-count')).toHaveTextContent('已选 1 个界面');
    const selected = (probe.props?.nodes ?? []).filter((node) => node.selected).map((node) => node.id);
    expect(selected).toEqual(['n_3']);
  });

  it('框选 2 个：节点被标成选中，工具条报数', () => {
    setup();

    selectNodes(['n_1', 'n_3']);

    expect(screen.getByTestId('selection-count')).toHaveTextContent('已选 2 个界面');
    const selected = (probe.props?.nodes ?? []).filter((node) => node.selected).map((node) => node.id);
    expect(selected).toEqual(['n_1', 'n_3']);
  });

  it('再点空白（全部取消）后工具条消失', () => {
    setup();
    selectNodes(['n_1', 'n_2']);
    expect(screen.getByTestId('selection-count')).toBeInTheDocument();

    selectNodes([]);

    expect(screen.queryByTestId('selection-count')).toBeNull();
  });

  it('「取消选择」按钮把选中态交回官方通道清掉（不自己改状态）', () => {
    setup();
    selectNodes(['n_1', 'n_2']);

    act(() => {
      screen.getByText('取消选择').click();
    });

    expect(screen.queryByTestId('selection-count')).toBeNull();
    expect((probe.props?.nodes ?? []).some((node) => node.selected)).toBe(false);
  });

  it('点「删除」：逐个让引擎删（引擎会把它连着的边一起删），并清掉选中态', async () => {
    const { removeNode } = setup();
    selectNodes(['n_1', 'n_2']);

    await act(async () => {
      screen.getByTestId('delete-selection').click();
      // 让 deleteSelection 里那串 await removeNode 落下来（否则断言跑在请求之前）
      await Promise.resolve();
    });

    expect(removeNode).toHaveBeenCalledTimes(2);
    expect(removeNode.mock.calls.map((call) => call[1])).toEqual(['n_1', 'n_2']);
    expect(screen.queryByTestId('selection-count')).toBeNull();
  });

  it('Delete 键（xyflow 的 onNodesDelete）走同一条删除路径', () => {
    const { removeNode } = setup();

    act(() => {
      probe.props?.onNodesDelete?.([{ id: 'n_2' }]);
    });

    expect(removeNode).toHaveBeenCalledTimes(1);
    expect(removeNode).toHaveBeenCalledWith(DEVICE, 'n_2');
  });

  it('删的正好是"下方编辑器在编辑的那一个"：编辑器一并收起（否则在编辑一个不存在的界面）', () => {
    const { removeNode } = setup();
    act(() => {
      useGraphStore.setState({ selectedNodeId: 'n_1' });
    });

    act(() => {
      probe.props?.onNodesDelete?.([{ id: 'n_1' }]);
    });

    expect(removeNode).toHaveBeenCalledWith(DEVICE, 'n_1');
    expect(useGraphStore.getState().selectedNodeId).toBeNull();
  });

  it('边被删除键删掉时同步到引擎（单独删边那条路）', () => {
    const { removeEdge } = setup();

    act(() => {
      probe.props?.onEdgesDelete?.([{ id: 'e_1' }, { id: 'e_2' }]);
    });

    expect(removeEdge.mock.calls.map((call) => call[1])).toEqual(['e_1', 'e_2']);
  });

  it('画布上写明了怎么多选 / 怎么缩放 / 怎么平移（文案必须和真实手势一致）', () => {
    setup();

    expect(screen.getByText(/拖动空白 = 平移画布；Shift\+拖动 = 框选/)).toBeInTheDocument();
    expect(screen.getByText(/滚动 \/ 双指滑动 = 缩放画布/)).toBeInTheDocument();
    expect(screen.getByText(/按住 Control 点 = 多选/)).toBeInTheDocument();
  });
});
