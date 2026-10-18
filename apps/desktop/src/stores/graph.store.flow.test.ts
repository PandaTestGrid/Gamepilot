/**
 * 步骤链 store：插入模块顺序。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { coerceStr } from '@/lib/coerce';
import { DEFAULT_WORKFLOW_FLOW, SCRIPT_SCOPE, useGraphStore } from '@/stores/graph.store';
vi.mock('@/lib/rpc', () => ({
  devLog: vi.fn(),
  graphGet: vi.fn(),
  graphSave: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

import { graphGet, graphSave } from '@/lib/rpc';

const PAYLOAD = {
  version: 1,
  defaults: {},
  nodes: [],
  edges: [],
  recognizers: {},
  flow: DEFAULT_WORKFLOW_FLOW,
};

describe('insertFlowModuleAfter', () => {
  beforeEach(() => {
    vi.mocked(graphGet).mockReset();
    vi.mocked(graphSave).mockReset();
    vi.mocked(graphSave).mockImplementation((payload) => Promise.resolve(payload));
    useGraphStore.setState({ graphs: {}, raws: {}, liveByDevice: {} });
    vi.mocked(graphGet).mockResolvedValue(PAYLOAD);
  });

  it('在指定步之后插入', async () => {
    useGraphStore.setState({
      raws: {
        [SCRIPT_SCOPE]: {
          ...PAYLOAD,
          flow: {
            steps: [
              { id: 't', type: 'manual', params: {} },
              { id: 'a', type: 'delay', params: { ms: 1 } },
              { id: 'b', type: 'key', params: { value: 'back' } },
            ],
          },
        },
      },
    });

    const newId = await useGraphStore.getState().insertFlowModuleAfter('a', {
      type: 'delay',
      label: '延时',
      hint: '',
      defaultParams: { ms: 99 },
    });

    expect(newId).toBeTruthy();
    const saved = vi.mocked(graphSave).mock.calls.at(-1)?.[0];
    const stepIds = saved?.flow?.steps?.map((step) => coerceStr(step.id)) ?? [];
    expect(stepIds).toEqual(['t', 'a', newId, 'b']);
  });
});

describe('removeFlowSteps', () => {
  beforeEach(() => {
    vi.mocked(graphGet).mockReset();
    vi.mocked(graphSave).mockReset();
    vi.mocked(graphSave).mockImplementation((payload) => Promise.resolve(payload));
    useGraphStore.setState({
      graphs: {},
      raws: {},
      liveByDevice: {},
      selectedNodeId: null,
      selectedNodeIds: [],
    });
    vi.mocked(graphGet).mockResolvedValue(PAYLOAD);
  });

  it('一次删掉多个模块（Shift 框选 + Delete）', async () => {
    useGraphStore.setState({
      selectedNodeId: 'a',
      selectedNodeIds: ['a', 'b'],
      raws: {
        [SCRIPT_SCOPE]: {
          ...PAYLOAD,
          flow: {
            steps: [
              { id: 't', type: 'manual', params: {} },
              { id: 'a', type: 'delay', params: { ms: 1 } },
              { id: 'b', type: 'key', params: { value: 'back' } },
              { id: 'c', type: 'delay', params: { ms: 2 } },
            ],
          },
        },
      },
    });

    await useGraphStore.getState().removeFlowSteps(['a', 'b']);

    const saved = vi.mocked(graphSave).mock.calls.at(-1)?.[0];
    const stepIds = saved?.flow?.steps?.map((step) => coerceStr(step.id)) ?? [];
    expect(stepIds).toEqual(['t', 'c']);
    expect(useGraphStore.getState().selectedNodeIds).toEqual([]);
  });

  it('框选含触发器时仍保留链首', async () => {
    useGraphStore.setState({
      raws: {
        [SCRIPT_SCOPE]: {
          ...PAYLOAD,
          flow: {
            steps: [
              { id: 't', type: 'manual', params: {} },
              { id: 'a', type: 'delay', params: { ms: 1 } },
              { id: 'b', type: 'key', params: { value: 'back' } },
            ],
          },
        },
      },
    });

    await useGraphStore.getState().removeFlowSteps(['t', 'a', 'b']);

    const saved = vi.mocked(graphSave).mock.calls.at(-1)?.[0];
    const stepIds = saved?.flow?.steps?.map((step) => coerceStr(step.id)) ?? [];
    expect(stepIds).toEqual(['t']);
  });

  it('不会删除触发器', async () => {
    useGraphStore.setState({
      raws: {
        [SCRIPT_SCOPE]: {
          ...PAYLOAD,
          flow: {
            steps: [
              { id: 't', type: 'manual', params: {} },
              { id: 'a', type: 'delay', params: { ms: 1 } },
            ],
          },
        },
      },
    });

    await useGraphStore.getState().removeFlowSteps(['t', 'a']);

    const saved = vi.mocked(graphSave).mock.calls.at(-1)?.[0];
    const stepIds = saved?.flow?.steps?.map((step) => coerceStr(step.id)) ?? [];
    expect(stepIds).toEqual(['t']);
  });
});

describe('运行中不能改流程图', () => {
  afterEach(async () => {
    const { useSessionStore } = await import('@/stores/session.store');
    useSessionStore.setState({ currentWorkflow: null, runningWorkflowRoots: {} });
  });

  beforeEach(() => {
    vi.mocked(graphGet).mockReset();
    vi.mocked(graphSave).mockReset();
    vi.mocked(graphSave).mockImplementation((payload) => Promise.resolve(payload));
    useGraphStore.setState({
      graphs: {},
      raws: {},
      liveByDevice: {},
      flowUndo: [],
      flowRedo: [],
      flowHistoryRoot: '',
      flowNotice: null,
    });
  });

  it('有设备在跑当前工作流时拒绝保存步骤链', async () => {
    const { useSessionStore } = await import('@/stores/session.store');
    const steps = [
      { id: 't', type: 'manual', params: {} },
      { id: 'a', type: 'delay', params: { ms: 1 } },
      { id: 'b', type: 'delay', params: { ms: 2 } },
    ];
    useSessionStore.setState({
      currentWorkflow: {
        root: '/p/甲/斗技',
        graphPath: '/p/甲/斗技/graph.json',
        nodes: 0,
        edges: 0,
        recognizers: 0,
        templates: 0,
      },
      runningWorkflowRoots: { 'dev-1': ['/p/甲/斗技'] },
    });
    useGraphStore.setState({
      raws: { [SCRIPT_SCOPE]: { ...PAYLOAD, flow: { steps } } },
      graphs: {
        [SCRIPT_SCOPE]: {
          deviceId: SCRIPT_SCOPE,
          nodes: [],
          edges: [],
          recognizers: [],
          variables: [],
          activeNodeId: null,
          pendingNodeId: null,
          flow: { steps },
        },
      },
    });

    await useGraphStore.getState().removeFlowSteps(['a']);
    expect(vi.mocked(graphSave)).not.toHaveBeenCalled();
    expect(useGraphStore.getState().graphs[SCRIPT_SCOPE]?.flow?.steps.map((step) => step.id)).toEqual([
      't',
      'a',
      'b',
    ]);
    expect(useGraphStore.getState().flowNotice?.text).toContain('运行中不能修改流程图');
  });

  it('有设备在跑时 flush 不再 graph.save（第二台设备开跑同一份脚本）', async () => {
    const { useSessionStore } = await import('@/stores/session.store');
    const steps = [
      { id: 't', type: 'manual', params: {} },
      { id: 'a', type: 'delay', params: { ms: 1 } },
    ];
    useSessionStore.setState({
      currentWorkflow: {
        root: '/p/甲/斗技',
        graphPath: '/p/甲/斗技/graph.json',
        nodes: 0,
        edges: 0,
        recognizers: 0,
        templates: 0,
      },
      runningWorkflowRoots: { 'dev-1': ['/p/甲/斗技'] },
    });
    useGraphStore.setState({
      raws: { [SCRIPT_SCOPE]: { ...PAYLOAD, flow: { steps } } },
      graphs: {
        [SCRIPT_SCOPE]: {
          deviceId: SCRIPT_SCOPE,
          nodes: [],
          edges: [],
          recognizers: [],
          variables: [],
          activeNodeId: null,
          pendingNodeId: null,
          flow: { steps },
        },
      },
    });

    await useGraphStore.getState().flushWorkflowToEngine({ force: true });
    expect(vi.mocked(graphSave)).not.toHaveBeenCalled();
  });
});

describe('undoFlow / redoFlow', () => {
  beforeEach(() => {
    vi.mocked(graphGet).mockReset();
    vi.mocked(graphSave).mockReset();
    vi.mocked(graphSave).mockImplementation((payload) => Promise.resolve(payload));
    useGraphStore.setState({
      graphs: {},
      raws: {},
      liveByDevice: {},
      flowUndo: [],
      flowRedo: [],
      flowHistoryRoot: '',
      selectedNodeId: null,
      selectedNodeIds: [],
    });
  });

  it('删除模块后能撤销、再重做', async () => {
    const steps = [
      { id: 't', type: 'manual', params: {} },
      { id: 'a', type: 'delay', params: { ms: 1 } },
      { id: 'b', type: 'key', params: { value: 'back' } },
    ];
    useGraphStore.setState({
      raws: { [SCRIPT_SCOPE]: { ...PAYLOAD, flow: { steps } } },
      graphs: {
        [SCRIPT_SCOPE]: {
          deviceId: SCRIPT_SCOPE,
          nodes: [],
          edges: [],
          recognizers: [],
          variables: [],
          activeNodeId: null,
          pendingNodeId: null,
          flow: { steps },
        },
      },
    });

    await useGraphStore.getState().removeFlowSteps(['a']);
    expect(useGraphStore.getState().graphs[SCRIPT_SCOPE]?.flow?.steps.map((step) => step.id)).toEqual([
      't',
      'b',
    ]);

    const undone = await useGraphStore.getState().undoFlow();
    expect(undone).toBe(true);
    expect(useGraphStore.getState().graphs[SCRIPT_SCOPE]?.flow?.steps.map((step) => step.id)).toEqual([
      't',
      'a',
      'b',
    ]);

    const redone = await useGraphStore.getState().redoFlow();
    expect(redone).toBe(true);
    expect(useGraphStore.getState().graphs[SCRIPT_SCOPE]?.flow?.steps.map((step) => step.id)).toEqual([
      't',
      'b',
    ]);
  });

  it('新编辑会清掉重做栈', async () => {
    const steps = [
      { id: 't', type: 'manual', params: {} },
      { id: 'a', type: 'delay', params: { ms: 1 } },
      { id: 'b', type: 'delay', params: { ms: 2 } },
    ];
    useGraphStore.setState({
      raws: { [SCRIPT_SCOPE]: { ...PAYLOAD, flow: { steps } } },
      graphs: {
        [SCRIPT_SCOPE]: {
          deviceId: SCRIPT_SCOPE,
          nodes: [],
          edges: [],
          recognizers: [],
          variables: [],
          activeNodeId: null,
          pendingNodeId: null,
          flow: { steps },
        },
      },
    });

    await useGraphStore.getState().removeFlowSteps(['a']);
    await useGraphStore.getState().undoFlow();
    expect(useGraphStore.getState().flowRedo.length).toBe(1);

    await useGraphStore.getState().removeFlowSteps(['b']);
    expect(useGraphStore.getState().flowRedo.length).toBe(0);
    expect(useGraphStore.getState().graphs[SCRIPT_SCOPE]?.flow?.steps.map((step) => step.id)).toEqual([
      't',
      'a',
    ]);
  });
});

describe('connectFlowSteps', () => {
  beforeEach(() => {
    vi.mocked(graphGet).mockReset();
    vi.mocked(graphSave).mockReset();
    vi.mocked(graphSave).mockImplementation((payload) => Promise.resolve(payload));
    useGraphStore.setState({ graphs: {}, raws: {}, liveByDevice: {} });
  });

  it('手动连线立刻落盘（只改接线，不搬位置）', async () => {
    const steps = [
      { id: 't', type: 'manual', params: {} },
      { id: 'a', type: 'delay', params: { ms: 1 } },
      { id: 'b', type: 'delay', params: { ms: 2 } },
    ];
    useGraphStore.setState({
      raws: {
        [SCRIPT_SCOPE]: {
          ...PAYLOAD,
          flow: { steps },
        },
      },
      graphs: {
        [SCRIPT_SCOPE]: {
          deviceId: SCRIPT_SCOPE,
          nodes: [],
          edges: [],
          recognizers: [],
          variables: [],
          activeNodeId: null,
          pendingNodeId: null,
          flow: { steps },
        },
      },
    });

    const error = await useGraphStore.getState().connectFlowSteps('t', 'b', 'out');
    expect(error).toBeNull();

    const graph = useGraphStore.getState().graphs[SCRIPT_SCOPE];
    // 从「开始」直接接到 b：a 掉到链尾变未接入，b 的顺序跟着接线走
    expect(graph?.flow?.steps.map((step) => step.id)).toEqual(['t', 'b', 'a']);
    const saved = vi.mocked(graphSave).mock.calls.at(-1)?.[0];
    expect((saved?.flow?.steps as { id: string }[]).map((step) => step.id)).toEqual(['t', 'b', 'a']);
  });
});

describe('循环/条件的成对插入、删除、次数与保存队列', () => {
  const seed = (steps: { id: string; type: string; params: Record<string, unknown> }[]): void => {
    useGraphStore.setState({
      raws: { [SCRIPT_SCOPE]: { ...PAYLOAD, flow: { steps } } },
      graphs: {
        [SCRIPT_SCOPE]: {
          deviceId: SCRIPT_SCOPE,
          nodes: [],
          edges: [],
          recognizers: [],
          variables: [],
          activeNodeId: null,
          pendingNodeId: null,
          flow: { steps },
        },
      },
    });
  };
  const types = (): string[] =>
    (useGraphStore.getState().graphs[SCRIPT_SCOPE]?.flow?.steps ?? []).map((step) => step.type);
  beforeEach(() => {
    vi.mocked(graphGet).mockReset();
    vi.mocked(graphSave).mockReset();
    vi.mocked(graphSave).mockImplementation((payload) => Promise.resolve(payload));
    useGraphStore.setState({ graphs: {}, raws: {}, liveByDevice: {}, flowNotice: null });
  });

  it('连续快速操作：保存串行合并，最终落盘的是最新结构', async () => {
    seed([
      { id: 't', type: 'manual', params: {} },
      { id: 'a', type: 'delay', params: { ms: 1 } },
      { id: 'b', type: 'delay', params: { ms: 2 } },
      { id: 'c', type: 'delay', params: { ms: 3 } },
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(graphSave).mockImplementation(async (payload) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return payload;
    });
    const store = useGraphStore.getState();
    await Promise.all([
      store.connectFlowSteps('c', 'a', 'out'),
      store.connectFlowSteps('b', 'c', 'out'),
      store.updateFlowStep('a', { params: { ms: 99 } }),
    ]);
    expect(maxInFlight).toBe(1);
    const saved = vi.mocked(graphSave).mock.calls.at(-1)?.[0];
    const finalIds = (saved?.flow?.steps as { id: string }[]).map((step) => step.id);
    expect(finalIds).toEqual(useGraphStore.getState().graphs[SCRIPT_SCOPE]?.flow?.steps.map((s) => s.id));
    expect(finalIds).toHaveLength(4);
  });

  it('非法连线：返回原因并通过 flowNotice 提示，结构不变', async () => {
    seed([
      { id: 't', type: 'manual', params: {} },
      { id: 'a', type: 'delay', params: { ms: 1 } },
    ]);
    const error = await useGraphStore.getState().connectFlowSteps('a', 't', 'out');
    expect(error).toBeTruthy();
    expect(types()).toEqual(['manual', 'delay']);
  });
});

describe('连续滑动轨迹落盘', () => {
  beforeEach(() => {
    vi.mocked(graphGet).mockReset();
    vi.mocked(graphSave).mockReset();
    vi.mocked(graphSave).mockImplementation((payload) => Promise.resolve(payload));
    useGraphStore.setState({ graphs: {}, raws: {}, liveByDevice: {} });
    vi.mocked(graphGet).mockResolvedValue(PAYLOAD);
  });

  it('updateFlowStep 写进去的 path / hold_ms 会原样出现在保存请求里', async () => {
    useGraphStore.setState({
      raws: {
        [SCRIPT_SCOPE]: {
          ...PAYLOAD,
          flow: {
            steps: [
              { id: 't', type: 'manual', params: {} },
              { id: 'sw', type: 'swipe', params: { x: 0.2, y: 0.8, to_x: 0.2, to_y: 0.8, duration_ms: 900 } },
            ],
          },
        },
      },
    });

    await useGraphStore.getState().updateFlowStep('sw', {
      params: {
        x: 0.2,
        y: 0.8,
        to_x: 0.2,
        to_y: 0.8,
        duration_ms: 900,
        path: [
          [0.2, 0.8],
          [0.5, 0.5],
          [0.8, 0.8],
        ],
        hold_ms: 300,
      },
    });

    const saved = vi.mocked(graphSave).mock.calls.at(-1)?.[0];
    const step = saved?.flow?.steps?.find((item) => item.id === 'sw') as
      { params?: Record<string, unknown> } | undefined;
    expect(step?.params?.path).toHaveLength(3);
    expect(step?.params?.hold_ms).toBe(300);
  });
});
