/**
 * 工作流图 store：**项目一份结构，设备只叠运行态**。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { graphGet, graphSave } from '@/lib/rpc';
import { toGraphData } from '@/lib/graph-adapter';
import { DEFAULT_WORKFLOW_FLOW, SCRIPT_SCOPE, graphForDevice, useGraphStore } from '@/stores/graph.store';
import type { FlowStep, GraphData } from '@/types';

vi.mock('@/lib/rpc', () => ({
  devLog: vi.fn(),
  graphGet: vi.fn(),
  graphSave: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const PAYLOAD = {
  version: 1,
  defaults: {},
  nodes: [],
  edges: [],
  recognizers: {},
  flow: DEFAULT_WORKFLOW_FLOW,
};

function graph(): GraphData {
  return {
    deviceId: '',
    nodes: [],
    edges: [],
    recognizers: [],
    variables: [],
    activeNodeId: null,
    pendingNodeId: null,
    flow: { steps: [{ id: 'trigger', type: 'schedule', params: { at: '09:00' } }] },
  };
}

describe('工作流图的作用域（项目 vs 设备）', () => {
  beforeEach(() => {
    vi.mocked(graphGet).mockReset();
    vi.mocked(graphSave).mockReset();
    vi.mocked(graphSave).mockImplementation((payload) => Promise.resolve(payload));
    useGraphStore.setState({ graphs: {}, raws: {}, liveByDevice: {} });
  });

  it('没选设备也去拉工作流（项目级），并存在 SCRIPT_SCOPE 下', async () => {
    vi.mocked(graphGet).mockResolvedValue(PAYLOAD);

    await useGraphStore.getState().refresh('');

    expect(graphGet).toHaveBeenCalledWith();
    expect(useGraphStore.getState().graphs[SCRIPT_SCOPE]?.flow?.steps[0]?.id).toBe('trigger');
  });

  it('refresh 不会给设备复制一整份结构（设备视图只在 updateLive 后出现）', async () => {
    vi.mocked(graphGet).mockResolvedValue(PAYLOAD);

    await useGraphStore.getState().refresh('mock:1');

    expect(useGraphStore.getState().graphs[SCRIPT_SCOPE]).toBeTruthy();
    expect(useGraphStore.getState().graphs['mock:1']).toBeUndefined();

    useGraphStore.getState().updateLive('mock:1', {
      node: 'main',
      pending: null,
      detections: [],
    });
    expect(useGraphStore.getState().graphs['mock:1']).toBeTruthy();
  });

  it('识别结果没变时 updateLive 不重建设备图（避免投屏把画布卡死）', async () => {
    vi.mocked(graphGet).mockResolvedValue(PAYLOAD);
    await useGraphStore.getState().refresh('mock:1');
    const live = {
      node: 'step-1',
      pending: null as string | null,
      detections: [{ label: 'btn', score: 0.91, state: 'hit' }],
    };
    useGraphStore.getState().updateLive('mock:1', live);
    const first = useGraphStore.getState().graphs['mock:1'];
    useGraphStore.getState().updateLive('mock:1', {
      node: 'step-1',
      pending: null,
      detections: [{ label: 'btn', score: 0.9104, state: 'hit' }],
    });
    expect(useGraphStore.getState().graphs['mock:1']).toBe(first);
  });

  it('graphForDevice：设备那份没有（还没出帧/没连）就退到脚本本身', () => {
    const state = { graphs: { [SCRIPT_SCOPE]: graph() } };

    expect(graphForDevice(state, 'android:7b69da0c')).toBe(state.graphs[SCRIPT_SCOPE]);
    expect(graphForDevice(state, '')).toBe(state.graphs[SCRIPT_SCOPE]);
  });

  it('引擎没起来时只记一行日志，不往外抛（调用方是 void refresh(...)）', async () => {
    vi.mocked(graphGet).mockRejectedValue(new Error('引擎未启动'));

    await expect(useGraphStore.getState().refresh('mock:1')).resolves.toBeUndefined();
    expect(useGraphStore.getState().graphs[SCRIPT_SCOPE]).toBeUndefined();
  });

  it('已有 flow 时 refresh 会清掉遗留的 nodes/edges', async () => {
    vi.mocked(graphGet).mockResolvedValue({
      version: 1,
      defaults: {},
      nodes: [{ id: 'n_1', name: '新界面', enter: ['logo'] }],
      edges: [],
      recognizers: {},
      flow: DEFAULT_WORKFLOW_FLOW,
    });

    await useGraphStore.getState().refresh('');

    expect(graphSave).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: [], edges: [], flow: DEFAULT_WORKFLOW_FLOW }),
    );
  });

  it('旧图没有 flow 时 refresh 会落盘默认触发块（手动，不会自动跑）', async () => {
    vi.mocked(graphGet).mockResolvedValue({
      version: 1,
      defaults: {},
      nodes: [{ id: 'main', name: '旧', enter: [] }],
      edges: [],
      recognizers: {},
    });

    await useGraphStore.getState().refresh('');

    expect(graphSave).toHaveBeenCalled();
    expect(useGraphStore.getState().graphs[SCRIPT_SCOPE]?.flow?.steps[0]?.type).toBe('manual');
  });

  it('步骤链保存走项目级 graphSave（不带 deviceId）', async () => {
    useGraphStore.setState({
      raws: { [SCRIPT_SCOPE]: PAYLOAD },
      graphs: { [SCRIPT_SCOPE]: toGraphData(SCRIPT_SCOPE, PAYLOAD) },
    });

    const steps: FlowStep[] = [
      { id: 'trigger', type: 'schedule', params: { at: '09:00' } },
      { id: 'delay_1', type: 'delay', params: { ms: 100 } },
    ];
    await useGraphStore.getState().saveFlowSteps(steps);

    const saved = vi.mocked(graphSave).mock.calls.at(-1)?.[0];
    expect(saved?.flow?.steps?.map((step) => step.id)).toEqual(['trigger', 'delay_1']);
    expect(saved).not.toHaveProperty('deviceId');
  });

  it('设备连上带回的 graph 不会覆盖内存里更多的 flow.steps（未落盘草稿）', () => {
    const localSteps: FlowStep[] = [
      { id: 'trigger', type: 'manual', params: {} },
      { id: 'delay_1', type: 'delay', params: { ms: 100 } },
      { id: 'delay_2', type: 'delay', params: { ms: 200 } },
    ];
    const localRaw = {
      ...PAYLOAD,
      flow: {
        steps: localSteps.map((step) => ({ id: step.id, type: step.type, params: step.params })),
      },
    };
    useGraphStore.setState({
      raws: { [SCRIPT_SCOPE]: localRaw },
      graphs: {
        [SCRIPT_SCOPE]: {
          ...graph(),
          flow: { steps: localSteps },
        },
      },
    });

    const engineOnlyTrigger = {
      ...PAYLOAD,
      flow: DEFAULT_WORKFLOW_FLOW,
    };
    useGraphStore
      .getState()
      .setGraph('android:test', toGraphData('android:test', engineOnlyTrigger), engineOnlyTrigger, {
        applyStructure: false,
      });

    const steps = useGraphStore.getState().graphs[SCRIPT_SCOPE]?.flow?.steps ?? [];
    expect(steps.map((step) => step.id)).toEqual(['trigger', 'delay_1', 'delay_2']);
    expect(useGraphStore.getState().liveByDevice['android:test']).toBeTruthy();
  });

  it('flushWorkflowToEngine 把画布上的 steps 写入 graphSave', async () => {
    const steps: FlowStep[] = [
      { id: 'trigger', type: 'manual', params: {} },
      { id: 's_augj8jmr', type: 'delay', params: { ms: 50 } },
    ];
    useGraphStore.setState({
      raws: { [SCRIPT_SCOPE]: PAYLOAD },
      graphs: {
        [SCRIPT_SCOPE]: {
          ...graph(),
          flow: { steps },
        },
      },
    });

    await useGraphStore.getState().flushWorkflowToEngine({ force: true });

    const saved = vi.mocked(graphSave).mock.calls.at(-1)?.[0];
    expect(saved?.flow?.steps?.map((step) => step.id)).toEqual(['trigger', 's_augj8jmr']);
  });

  it('引擎回包步骤更少时保留画布上更长的链（录模板/改名）', () => {
    const localSteps: FlowStep[] = [
      { id: 'trigger', type: 'manual', params: {} },
      { id: 'c1', type: 'cond', params: { rec: 'A' } },
      { id: 'd1', type: 'delay', params: { ms: 1 } },
    ];
    useGraphStore.setState({
      raws: {
        [SCRIPT_SCOPE]: { ...PAYLOAD, flow: { steps: [{ id: 'trigger', type: 'manual', params: {} }] } },
      },
      graphs: {
        [SCRIPT_SCOPE]: {
          ...graph(),
          flow: { steps: localSteps },
        },
      },
    });

    const engineOnlyTrigger = { ...PAYLOAD, flow: DEFAULT_WORKFLOW_FLOW };
    useGraphStore
      .getState()
      .setGraph('android:test', toGraphData('android:test', engineOnlyTrigger), engineOnlyTrigger, {
        applyStructure: true,
      });

    const ids = useGraphStore.getState().graphs[SCRIPT_SCOPE]?.flow?.steps.map((s) => s.id);
    expect(ids).toEqual(['trigger', 'c1', 'd1']);
  });

  it('updateFlowStep 以画布 steps 为准，不把链存成 raw 里的短链', async () => {
    const localSteps: FlowStep[] = [
      { id: 'trigger', type: 'manual', params: {} },
      { id: 'c1', type: 'cond', params: { rec: 'A' } },
      { id: 'd1', type: 'delay', params: { ms: 1 } },
    ];
    useGraphStore.setState({
      raws: {
        [SCRIPT_SCOPE]: {
          ...PAYLOAD,
          flow: { steps: [{ id: 'trigger', type: 'manual', params: {} }] },
        },
      },
      graphs: {
        [SCRIPT_SCOPE]: {
          ...graph(),
          flow: { steps: localSteps },
        },
      },
    });

    await useGraphStore.getState().updateFlowStep('c1', { params: { rec: 'B' } });

    const saved = vi.mocked(graphSave).mock.calls.at(-1)?.[0];
    expect(saved?.flow?.steps?.map((step) => step.id)).toEqual(['trigger', 'c1', 'd1']);
    const saved_c1 = saved?.flow?.steps?.find((step) => step.id === 'c1');
    expect((saved_c1?.params as { rec?: string } | undefined)?.rec).toBe('B');
  });
});
