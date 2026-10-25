import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toGraphData } from '@/lib/graph-adapter';
import type { GraphPayload } from '@/lib/rpc';
import { WORKFLOW_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
const ID = 'enabled-device';
const ROOT = 'S:/enabled';
const raw: GraphPayload = {
  version: 1,
  defaults: {},
  recognizers: { target: { type: 'template', template: 'target.png' }, other: { type: 'yolo' } },
  nodes: [],
  edges: [],
  flow: { steps: [{ id: 'click', type: 'click', params: { by: 'recognizer', rec: 'target' } }] },
};
const hits = [{ label: 'target', score: 0.95, state: 'confirmed' }];
const project = (root: string) => ({
  root,
  graphPath: `${root}/graph.json`,
  nodes: 0,
  edges: 0,
  recognizers: 2,
  templates: 1,
});
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ label: 'target', enabled: false, graph: raw });
  useSessionStore.getState().resetForEngineRestart();
  useSessionStore.setState({
    currentWorkflow: project(ROOT),
    error: null,
    running: { [ID]: true },
    runningWorkflowRoots: { [ID]: [ROOT] },
    frames: {},
  });
  const graph = toGraphData(ID, raw);
  useGraphStore.setState({
    graphs: { [WORKFLOW_SCOPE]: graph, [ID]: graph },
    raws: { [WORKFLOW_SCOPE]: raw, [ID]: raw },
    liveByDevice: {},
    workflowSnapshots: {},
  });
  useGraphStore.getState().updateLive(ID, { node: 'click', pending: 'next', detections: hits });
});
function target() {
  return useGraphStore.getState().graphs[ID]?.recognizers.find((item) => item.label === 'target');
}

describe('识别器启停', () => {
  it('真实RPC payload且成功最小patch保留素材/引用/运行态/selection/结构', async () => {
    const before = useGraphStore.getState().graphs[ID]!;
    const running = useSessionStore.getState().runningWorkflowRoots;
    expect(await useSessionStore.getState().setRecognizerEnabled(ID, 'target', false)).toBe(true);
    expect(invoke).toHaveBeenCalledWith('engine_rpc', {
      method: 'recognizer.enabled',
      params: { deviceId: ID, label: 'target', enabled: false, workflowRoot: ROOT },
    });
    expect(target()).toMatchObject({ enabled: false, template: 'target.png', score: 0, state: 'idle' });
    const after = useGraphStore.getState().graphs[ID]!;
    expect(after.flow).toBe(before.flow);
    expect(after.nodes).toBe(before.nodes);
    expect(after.activeNodeId).toBe('click');
    expect(after.pendingNodeId).toBe('next');
    expect(after.recognizers[1]).toBe(before.recognizers[1]);
    expect(useSessionStore.getState().runningWorkflowRoots).toBe(running);
    expect(useGraphStore.getState().raws[WORKFLOW_SCOPE]?.recognizers?.target?.enabled).toBe(false);
  });

  it('disabled忽略后续旧命中；重新开启清零直到新frame', async () => {
    await useSessionStore.getState().setRecognizerEnabled(ID, 'target', false);
    useGraphStore.getState().updateLive(ID, { node: 'click', pending: null, detections: hits });
    expect(target()).toMatchObject({ enabled: false, score: 0, state: 'idle' });
    invoke.mockResolvedValue({ label: 'target', enabled: true, graph: raw });
    await useSessionStore.getState().setRecognizerEnabled(ID, 'target', true);
    expect(target()).toMatchObject({ enabled: true, score: 0, state: 'idle' });
    expect(useGraphStore.getState().liveByDevice[ID]?.detections).toEqual([]);
    useGraphStore.getState().updateLive(ID, { node: 'click', pending: null, detections: hits });
    expect(target()).toMatchObject({ enabled: true, score: 0.95, state: 'confirmed' });
  });

  it('RPC失败保留enabled/live值并提供错误', async () => {
    invoke.mockRejectedValue(new Error('disk unavailable'));
    const before = target();
    expect(await useSessionStore.getState().setRecognizerEnabled(ID, 'target', false)).toBe(false);
    expect(target()).toBe(before);
    expect(useSessionStore.getState().error).toBe('disk unavailable');
  });

  it('切换workflow后旧response不patch新workflow同名识别器', async () => {
    let resolve!: (value: unknown) => void;
    invoke.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = useSessionStore.getState().setRecognizerEnabled(ID, 'target', false);
    useSessionStore.setState({ currentWorkflow: project('S:/new-root') });
    const before = target();
    resolve({ label: 'target', enabled: false, graph: raw });
    expect(await pending).toBe(true);
    expect(target()).toBe(before);
  });

  it.each([false, true])(
    '同root/label新enable完成后忽略旧disable晚到（旧请求失败=%s）',
    async (rejectOld) => {
      let resolveOld!: (value: unknown) => void;
      let rejectOldRequest!: (error: Error) => void;
      let resolveNew!: (value: unknown) => void;
      invoke.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          resolveOld = resolve;
          rejectOldRequest = reject;
        }),
      );
      invoke.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveNew = resolve;
        }),
      );
      const oldRequest = useSessionStore.getState().setRecognizerEnabled(ID, 'target', false);
      const newRequest = useSessionStore.getState().setRecognizerEnabled(ID, 'target', true);
      resolveNew({ label: 'target', enabled: true });
      expect(await newRequest).toBe(true);
      const latest = target();
      if (rejectOld) rejectOldRequest(new Error('obsolete error'));
      else resolveOld({ label: 'target', enabled: false });
      expect(await oldRequest).toBe(!rejectOld);
      expect(target()).toBe(latest);
      expect(target()?.enabled).toBe(true);
      expect(useSessionStore.getState().error).toBeNull();
    },
  );

  it('无设备项目模式RPC省略deviceId', async () => {
    await useSessionStore.getState().setRecognizerEnabled('', 'target', false);
    expect(invoke).toHaveBeenCalledWith('engine_rpc', {
      method: 'recognizer.enabled',
      params: { label: 'target', enabled: false, workflowRoot: ROOT },
    });
  });
});
