/**
 * 传给 `<ReactFlow>` 的"被跟踪字段"必须是**稳定引用**。
 *
 * 事故（用户控制台，2026-10-11）：
 *   Maximum update depth exceeded ← setNodes ← (effect) ← @xyflow/react
 * xyflow 内部有个 `StoreUpdater`：它把 props 里被跟踪的字段（`reactFlowFieldsToTrack`）
 * 回写进自己的 store（`setNodes` / `setEdges` / `store.setState`）。
 * 只要这些 prop 每次渲染都是**新对象/新函数**（内联箭头、内联字面量），
 * 每次渲染都会往它自己的 store 里写一遍 → 嵌套更新攒到 50 次就报"无限重渲染"。
 *
 * jsdom 里复现不了那个循环（React 只在真实提交节奏下才攒到上限），
 * 所以这里守的是**根因**：无关重渲染发生时，这些 prop 的引用不能变。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphPane } from '@/features/graph/GraphPane';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

/** ReactFlow 换成一个探针：只记下最新的 props，不做任何渲染 */
const probe = vi.hoisted(() => ({ props: null as null | Record<string, unknown>, explode: false }));

vi.mock('@xyflow/react', async () => {
  const react = await import('react');
  return {
    ReactFlow: (props: Record<string, unknown>) => {
      if (probe.explode) {
        // 模拟 xyflow 那条 Maximum update depth exceeded（渲染期抛）
        throw new Error('Maximum update depth exceeded');
      }
      probe.props = props;
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
    // 真的能 setNodes（静态替身会让 rfNodes 永远为空 → 画布那支根本不渲染），
    // 且 `onNodesChange` 必须**引用稳定**（官方 useNodesState 就是 useCallback 出来的）
    useNodesState: (initial: unknown[]) => {
      const [nodes, setNodes] = react.useState(initial);
      const onNodesChange = react.useCallback(() => undefined, []);
      return [nodes, setNodes, onNodesChange];
    },
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const DEVICE = 'mock:1';

/** xyflow 会回写进自己 store 的字段（`reactFlowFieldsToTrack` 里我们真传了的那些） */
const TRACKED = ['nodes', 'edges', 'onConnect', 'onNodesDelete', 'onEdgesDelete', 'fitViewOptions'];

describe('画布 props 的引用稳定性', () => {
  beforeEach(() => {
    probe.props = null;
    useDeviceStore.setState({ devices: [], activeId: DEVICE, gridView: false });
    useSessionStore.setState({ project: null, frames: {}, running: {}, ready: {} });
    useGraphStore.setState({
      selectedNodeId: null,
      selectedEdgeId: null,
      graphs: {
        [DEVICE]: {
          deviceId: DEVICE,
          nodes: [
            { id: 'n_1', name: '界面1', enter: [], x: 0, y: 0, visits: 0 },
            { id: 'n_2', name: '战斗中', enter: [], x: 200, y: 0, visits: 0 },
          ],
          edges: [
            {
              id: 'e_1',
              from: 'n_1',
              to: 'n_2',
              when: 'aaa',
              kind: 'normal',
              priority: 0,
              minScore: 0,
              cooldownMs: 0,
              retries: 1,
              action: 'click',
              condition: { allOf: ['aaa'], anyOf: [], noneOf: [], minScore: 0, withinMs: 0 },
              actionSpec: { type: 'click', target: 'aaa' },
            },
          ],
          recognizers: [],
          variables: [],
          activeNodeId: null,
          pendingNodeId: null,
        },
      },
    });
  });

  it('无关重渲染之后，nodes/edges/回调/fitViewOptions 都还是同一引用', () => {
    render(<GraphPane />);
    const first = { ...(probe.props ?? {}) };
    expect(first.nodes).toBeDefined();

    // 换一个"画布订阅了、但和这些 props 无关"的状态：GraphPane 会重渲染，
    // 而 props 的引用不该变（内联写法在这里就会露馅）
    act(() => {
      useUiStore.setState({ nodeScale: 'lg' });
    });

    const second = probe.props ?? {};
    for (const field of TRACKED) {
      expect(second[field], `${field} 每次渲染都换了新引用 —— xyflow 会把它当成变化回写自己的 store`).toBe(
        first[field],
      );
    }
  });

  it('引擎每帧推新 graph 对象（内容没变）时，nodes/edges 不换引用', () => {
    render(<GraphPane />);
    const first = { ...(probe.props ?? {}) };
    expect(first.nodes).toBeDefined();

    // 帧就是这样来的：内容一样、对象是新的
    act(() => {
      const current = useGraphStore.getState().graphs[DEVICE];
      useGraphStore.setState({ graphs: { [DEVICE]: { ...(current as object) } } as never });
    });

    const second = probe.props ?? {};
    expect(
      second.nodes,
      '每帧重建节点数组 → xyflow 每帧 setNodes → 嵌套重渲染攒到 50 次就报 Maximum update depth',
    ).toBe(first.nodes);
    expect(second.edges, '每帧重建边数组同理').toBe(first.edges);
  });

  it('内容真的变了（节点改名）时 nodes 必须换新 —— 稳定性不能做过头', () => {
    render(<GraphPane />);
    const first = probe.props?.nodes;

    act(() => {
      const current = useGraphStore.getState().graphs[DEVICE];
      const nodes = (current?.nodes ?? []).map((node) => ({ ...node, name: '改过名' }));
      useGraphStore.setState({ graphs: { [DEVICE]: { ...(current as object), nodes } } as never });
    });

    expect(probe.props?.nodes).not.toBe(first);
  });

  it('边的目标节点改名后 edges 也要重建 —— 标签里写着目标名，别把它冻住', () => {
    render(<GraphPane />);
    const first = probe.props?.edges;

    act(() => {
      const current = useGraphStore.getState().graphs[DEVICE];
      const nodes = (current?.nodes ?? []).map((node) =>
        node.id === 'n_2' ? { ...node, name: '改成别的名字' } : node,
      );
      useGraphStore.setState({ graphs: { [DEVICE]: { ...(current as object), nodes } } as never });
    });

    expect(probe.props?.edges).not.toBe(first);
  });

  it('画布手势全用官方默认：滚动缩放、左键平移、Shift 框选、Control 多选', () => {
    render(<GraphPane />);

    // 滚动/双指滑动 = 缩放（官方默认；之前被改成平移，用户报「滚轮放大缩小没有」）
    expect(probe.props?.zoomOnScroll).toBe(true);
    expect(probe.props?.panOnScroll ?? false).toBeFalsy();
    // 平移/框选都不再自己改：panOnDrag 不传 = 官方默认（左键平移、中键+空格也能平移），
    // selectionOnDrag 不传 = 默认 false（框选靠 Shift 拖动，官方 selectionKeyCode）
    expect(probe.props?.panOnDrag).toBeUndefined();
    expect(probe.props?.selectionOnDrag).toBeUndefined();
    expect(probe.props?.selectionKeyCode).toBeUndefined();
    // 多选键：官方在 mac 上是 Meta，这里按用户要求统一成 Control
    expect(probe.props?.multiSelectionKeyCode).toEqual(['Control']);
    // Delete / Backspace 都能删（macOS 键盘 Delete 要 Fn+Backspace）
    expect(probe.props?.deleteKeyCode).toEqual(['Delete', 'Backspace']);
  });

  it('画布外壳不再自己接管平移光标（那套补丁删掉了）', () => {
    const { container } = render(<GraphPane />);

    const shell = container.querySelector('[data-testid="graph-canvas"]');
    expect(shell?.className).toContain('bg-canvas');
    // 右键按下不该再给外壳加类：平移光标由 xyflow 自己按 .draggable/.dragging 决定
    fireEvent.pointerDown(shell as Element, { button: 2 });
    expect(container.querySelector('.canvas-panning')).toBeNull();
  });

  it('画布炸了只隔离画布，并给「重建画布」的回头路（别的面板不受影响）', () => {
    probe.explode = true;
    render(<GraphPane />);

    expect(screen.getByText(/画布渲染出错了/)).toBeInTheDocument();
    // 头部还在（报错没有把整个壳带走）：面板标题 + 视图切换都在
    expect(screen.getAllByText('状态图').length).toBeGreaterThan(0);
    expect(screen.getByText('脚本')).toBeInTheDocument();

    probe.explode = false;
    fireEvent.click(screen.getByText('重建画布'));
    expect(screen.queryByText(/画布渲染出错了/)).toBeNull();
  });

  it('一个节点都没有时 <ReactFlow> 也不能被换掉 —— 挂着再卸、卸了再挂会把自己拖进死循环', () => {
    const current = useGraphStore.getState().graphs[DEVICE];
    useGraphStore.setState({
      graphs: { [DEVICE]: { ...(current as object), nodes: [], edges: [] } } as never,
    });

    render(<GraphPane />);

    // 空态是"盖一层提示"，不是"用提示替换画布"：ReactFlow 每次挂载都会往自己的
    // store 里 setNodes，反复挂载/卸载就是那条 Maximum update depth exceeded 的温床
    expect(probe.props, '空图时 ReactFlow 被卸载了').not.toBeNull();
    expect(screen.getByText('这份脚本还没有界面节点')).toBeInTheDocument();
  });
});
