import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SCRIPT_SCOPE, useGraphStore } from '@/stores/graph.store';
import type { GraphData, RecognizerView } from '@/types';

vi.mock('@/lib/rpc', () => ({ devLog: vi.fn(), graphGet: vi.fn(), graphSave: vi.fn() }));
vi.mock('@/stores/template.store', () => ({ preloadTemplates: vi.fn() }));

function recognizer(label: string): RecognizerView {
  return {
    label,
    type: 'yolo',
    classes: [label],
    examplesCount: 1,
    score: 0,
    state: 'idle',
    threshold: 0.3,
    roi: [0, 0, 1, 1],
    search: 'region',
    samples: 1,
  };
}

function graph(): GraphData {
  return {
    deviceId: SCRIPT_SCOPE,
    nodes: [],
    edges: [],
    variables: [],
    recognizers: [recognizer('a'), recognizer('b'), recognizer('c')],
    activeNodeId: null,
    pendingNodeId: null,
    flow: {
      steps: [
        { id: 'trigger', type: 'manual' },
        { id: 'click', type: 'click' },
      ],
    },
  };
}

const detections = [
  { label: 'a', score: 0.8, state: 'confirmed' },
  { label: 'b', score: 0.5, state: 'pending' },
];

function update(deviceId = 'device-a', options = {}) {
  useGraphStore.getState().updateLive(deviceId, {
    node: 'trigger',
    pending: null,
    detections,
    ...options,
  });
}

function deviceGraph(deviceId = 'device-a'): GraphData {
  return useGraphStore.getState().graphs[deviceId]!;
}

beforeEach(() => {
  useGraphStore.setState({
    graphs: { [SCRIPT_SCOPE]: graph() },
    raws: {},
    liveByDevice: {},
    workflowSnapshots: {},
  });
});

describe('设备 live 图的对象身份', () => {
  it('分数更新只替换目标设备图与改变的识别器，结构和其它设备保持引用', () => {
    update();
    update('device-b', { detections: [{ label: 'a', score: 0.4, state: 'pending' }] });
    const before = useGraphStore.getState();
    const first = deviceGraph();
    const other = deviceGraph('device-b');

    update('device-a', { detections: [{ ...detections[0]!, score: 0.9 }, detections[1]!] });

    const after = useGraphStore.getState();
    const next = deviceGraph();
    expect(after.graphs).not.toBe(before.graphs);
    expect(after.graphs[SCRIPT_SCOPE]).toBe(before.graphs[SCRIPT_SCOPE]);
    expect(deviceGraph('device-b')).toBe(other);
    expect(after.liveByDevice['device-b']).toBe(before.liveByDevice['device-b']);
    expect(next).not.toBe(first);
    expect(next.flow).toBe(first.flow);
    expect(next.nodes).toBe(first.nodes);
    expect(next.edges).toBe(first.edges);
    expect(next.variables).toBe(first.variables);
    expect(next.recognizers).not.toBe(first.recognizers);
    expect(next.recognizers[0]).not.toBe(first.recognizers[0]);
    expect(next.recognizers[0]?.score).toBe(0.9);
    expect(next.recognizers[1]).toBe(first.recognizers[1]);
    expect(next.recognizers[2]).toBe(first.recognizers[2]);
    expect(other.recognizers[0]?.score).toBe(0.4);
  });

  it('节点与pending每次立即更新，但识别器数组与对象不变', () => {
    update();
    const first = deviceGraph();
    update('device-b');
    const other = deviceGraph('device-b');
    update('device-a', { node: 'click', pending: 'next' });
    const next = deviceGraph();
    expect(next.activeNodeId).toBe('click');
    expect(next.pendingNodeId).toBe('next');
    expect(next.recognizers).toBe(first.recognizers);
    expect(deviceGraph('device-b')).toBe(other);
    update('device-a', { node: 'done', pending: null });
    expect(deviceGraph().activeNodeId).toBe('done');
    expect(deviceGraph().pendingNodeId).toBeNull();
    expect(deviceGraph().recognizers).toBe(first.recognizers);
  });

  it('检测顺序变化不重建识别器数组；完全相同live仍保持store身份', () => {
    update();
    const first = deviceGraph();
    update('device-a', { detections: [...detections].reverse() });
    expect(deviceGraph().recognizers).toBe(first.recognizers);
    const state = useGraphStore.getState();
    update('device-a', { detections: [...detections].reverse() });
    expect(useGraphStore.getState()).toBe(state);
  });

  it('状态改变与命中消失更新目标对象，未改变项保持引用', () => {
    update();
    const first = deviceGraph();
    update('device-a', { detections: [{ ...detections[0]!, state: 'pending' }, detections[1]!] });
    const pending = deviceGraph();
    expect(pending.recognizers[0]?.state).toBe('pending');
    expect(pending.recognizers[0]).not.toBe(first.recognizers[0]);
    expect(pending.recognizers[1]).toBe(first.recognizers[1]);
    update('device-a', { detections: [detections[1]!] });
    expect(deviceGraph().recognizers[0]).toMatchObject({ score: 0, state: 'idle' });
    expect(deviceGraph().recognizers[0]).not.toBe(pending.recognizers[0]);
    expect(deviceGraph().recognizers[1]).toBe(pending.recognizers[1]);
    expect(deviceGraph().recognizers[2]).toBe(pending.recognizers[2]);
  });

  it('初始化空命中复用脚本的idle识别器数组，新增设备不影响旧设备', () => {
    const script = deviceGraph(SCRIPT_SCOPE);
    update('device-a', { detections: [] });
    const first = deviceGraph();
    expect(first.recognizers).toBe(script.recognizers);
    update('device-b');
    expect(deviceGraph()).toBe(first);
  });

  it('阈值与搜索范围结构编辑仍重建所有设备，不残留旧配置或丢失各自分数', () => {
    update();
    update('device-b', { detections: [{ label: 'a', score: 0.4, state: 'pending' }] });
    const first = deviceGraph();
    const other = deviceGraph('device-b');
    useGraphStore.getState().updateRecognizerThreshold('device-a', 'a', 0.7);
    expect(deviceGraph()).not.toBe(first);
    expect(deviceGraph('device-b')).not.toBe(other);
    expect(deviceGraph().recognizers[0]).toMatchObject({ threshold: 0.7, score: 0.8 });
    expect(deviceGraph('device-b').recognizers[0]).toMatchObject({ threshold: 0.7, score: 0.4 });
    useGraphStore.getState().updateRecognizerSearch('device-a', 'a', 'full');
    expect(deviceGraph().recognizers[0]?.search).toBe('full');
    expect(deviceGraph('device-b').recognizers[0]?.search).toBe('full');
    const latest = deviceGraph().recognizers;
    update('device-a', { node: 'click' });
    expect(deviceGraph().recognizers).toBe(latest);
    expect(deviceGraph().recognizers[0]).toMatchObject({ threshold: 0.7, search: 'full', score: 0.8 });
  });

  it('发布新结构同步步骤、识别器增删/排序与静态元数据，后续live不复活旧对象', () => {
    update();
    update('device-b');
    const first = deviceGraph();
    const oldScript = deviceGraph(SCRIPT_SCOPE);
    const changedB = { ...recognizer('b'), classes: ['new-class'], examplesCount: 4 };
    const replacement = {
      ...oldScript,
      recognizers: [changedB, recognizer('new')],
      flow: { steps: [{ id: 'new-trigger', type: 'manual' }] },
    };
    useGraphStore.getState().setGraph(SCRIPT_SCOPE, replacement, undefined, { resetPositions: true });
    for (const id of ['device-a', 'device-b']) {
      const next = deviceGraph(id);
      expect(next.flow).toBe(replacement.flow);
      expect(next.recognizers.map((item) => item.label)).toEqual(['b', 'new']);
      expect(next.recognizers[0]).not.toBe(first.recognizers[1]);
      expect(next.recognizers[0]).toMatchObject({ classes: ['new-class'], examplesCount: 4, score: 0.5 });
      expect(next.recognizers[1]).toMatchObject({ score: 0, state: 'idle' });
    }
    const rebuilt = deviceGraph();
    update('device-a', { node: 'new-trigger' });
    expect(deviceGraph().recognizers).toBe(rebuilt.recognizers);
    expect(deviceGraph().flow).toBe(replacement.flow);
  });
});
