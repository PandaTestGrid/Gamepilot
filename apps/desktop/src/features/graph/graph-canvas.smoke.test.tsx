/**
 * 画布冒烟：用**真的** `@xyflow/react` 挂一次画布，再连续走一遍常见交互，确认
 * ① 没掉进"画布渲染出错了"（`CanvasBoundary` 抓住的 `Maximum update depth exceeded`），
 * ② 选中/多选的读写不来回打架。
 *
 * 背景（用户反馈）：点了节点之后画布偶发「画布渲染出错了（已隔离）」，同时「已选 N 个界面」
 * 的数字自己在跳。病根都是**自己维护一份选中状态再和 xyflow 对齐**（见 features/graph/README
 * 的「画布手势」一节）。这条用例守住回归：选中只有一个真源（xyflow），且不产生更新回环。
 */
import { act, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphPane } from '@/features/graph/GraphPane';
import { graphGet } from '@/lib/rpc';
import { setPositionScope } from '@/lib/node-positions';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';

vi.mock('@/lib/rpc', () => ({
  devLog: vi.fn(),
  graphGet: vi.fn(),
  graphSave: vi.fn(),
  graphNodeAdd: vi.fn(),
  graphEdgeAdd: vi.fn(),
  graphNodeRemove: vi.fn(),
  graphNodeUpdate: vi.fn(),
  actionRun: vi.fn(),
  templateImage: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

/** jsdom 缺的那些浏览器 API：xyflow 量尺寸/算命中要用 */
beforeAll(() => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  (globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
    m22 = 1;
  };
});

const PAYLOAD = {
  nodes: [
    { id: 'n_1', name: '界面1', enter: [] },
    { id: 'n_2', name: '界面2', enter: [] },
    { id: 'n_3', name: '界面3', enter: [] },
  ],
  edges: [],
  recognizers: {},
  variables: {},
};

function seed(): void {
  window.localStorage.clear();
  setPositionScope('/tmp/gamepilot-smoke');
  useGraphStore.setState({ graphs: {}, raws: {}, selectedEdgeId: null, selectedNodeId: null });
  vi.mocked(graphGet).mockResolvedValue(PAYLOAD as never);
  useDeviceStore.setState({
    devices: [
      {
        id: 'devA',
        name: 'A',
        uri: 'mock://a',
        kind: 'mock',
        status: 'connected',
        resolution: [720, 1280],
        fps: 0,
      },
    ],
    activeId: 'devA',
  });
  useGraphStore.getState().setGraph('devA', {
    deviceId: 'devA',
    nodes: [
      { id: 'n_1', name: '界面1', enter: [], x: 0, y: 0, visits: 0 },
      { id: 'n_2', name: '界面2', enter: [], x: 240, y: 0, visits: 0 },
      { id: 'n_3', name: '界面3', enter: [], x: 480, y: 0, visits: 0 },
    ],
    edges: [],
    variables: [],
    recognizers: [],
    activeNodeId: null,
    pendingNodeId: null,
  });
}

describe('真实 ReactFlow 冒烟', () => {
  beforeEach(() => {
    seed();
  });

  it('真实画布挂载 + 点节点 + 多选，不报「画布渲染出错了」', async () => {
    const view = render(<GraphPane />);
    await act(async () => {});

    // 真的渲染出了 3 个节点（说明用的是真 ReactFlow，不是探针）
    const cards = view.container.querySelectorAll('.react-flow__node');
    expect(cards.length).toBe(3);

    // 点一个节点：选中 → 展开编辑器
    const first = view.container.querySelector('[data-id="n_1"]');
    expect(first).toBeTruthy();
    act(() => {
      first?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(useGraphStore.getState().selectedNodeId).toBe('n_1');

    // 选中是真的发生了（xyflow 给节点包裹层加 `.selected`）—— 证明这条链路真的被走过了
    expect(view.container.querySelector('[data-id="n_1"]')?.className).toContain('selected');

    // 真实多选：点第二个节点（xyflow 的选中变更 → 我们的 selectedIds 读回来）
    const second = view.container.querySelector('[data-id="n_2"]');
    act(() => {
      second?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(view.container.querySelector('[data-id="n_2"]')?.className).toContain('selected');

    // 关键：画布没炸（CanvasBoundary 的兜底文案不该出现），节点也没有被反复重建掉
    expect(screen.queryByText(/画布渲染出错了/)).toBeNull();
    expect(view.container.querySelectorAll('.react-flow__node').length).toBe(3);

    view.unmount();
  });

  it('切设备后画布还在、不炸（节点表整体重建）', async () => {
    const view = render(<GraphPane />);
    await act(async () => {});

    act(() => {
      useDeviceStore.setState({ activeId: 'devB' });
    });
    await act(async () => {});

    expect(screen.queryByText(/画布渲染出错了/)).toBeNull();
    expect(view.container.querySelectorAll('.react-flow__node').length).toBe(3);
    view.unmount();
  });
});
