import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toGraphData } from '@/lib/graph-adapter';
import type { GraphPayload } from '@/lib/rpc';
import { getYoloExamplesRevision } from '@/features/recognizers/yolo-example-revision';
import { SCRIPT_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
const old = 'ai_12',
  renamed = '关闭弹窗',
  id = 'rename-device';
function payload(label: string, long = false): GraphPayload {
  return {
    version: 1,
    defaults: {},
    recognizers: { [label]: { type: 'yolo', classes: ['button'], examples: [{ label: 'button' }] } },
    nodes: [],
    edges: [],
    flow: {
      steps: [
        { id: 'trigger', type: 'manual' },
        ...(long
          ? [
              { id: 'click', type: 'click', params: { by: 'recognizer', rec: label } },
              { id: 'wait', type: 'wait', params: { rec: label } },
            ]
          : []),
      ],
    },
  };
}
beforeEach(() => {
  invoke.mockReset();
  useSessionStore.getState().resetForEngineRestart();
  useSessionStore.setState({
    currentWorkflow: {
      root: 'S:/rename',
      graphPath: 'S:/rename/graph.json',
      nodes: 0,
      edges: 0,
      recognizers: 1,
      templates: 0,
    },
    ready: { [id]: true },
    running: { [id]: true },
    runningWorkflowRoots: { [id]: ['S:/rename'] },
    frames: {},
  });
  const raw = payload(old, true),
    graph = toGraphData(id, raw);
  useGraphStore.setState({
    graphs: { [SCRIPT_SCOPE]: graph, [id]: graph },
    raws: { [SCRIPT_SCOPE]: raw },
    workflowSnapshots: {},
    liveByDevice: {},
  });
  useGraphStore
    .getState()
    .updateLive(id, {
      node: 'click',
      pending: null,
      detections: [{ label: old, score: 0.9, state: 'confirmed' }],
    });
});
describe('改名同步picker数据源', () => {
  it.each([id, SCRIPT_SCOPE, ''])('scope %s 保更长本地链并改全部rec，不回填旧value', async (scope) => {
    const response = payload(renamed, scope !== id);
    invoke.mockResolvedValue({
      from: old,
      to: renamed,
      graph: response,
      refs: { nodes: 0, edges: 0, scores: 0, flowSteps: 2 },
    });
    const running = useSessionStore.getState().runningWorkflowRoots;
    expect(await useSessionStore.getState().renameRecognizer(scope, old, renamed)).not.toBeNull();
    for (const graph of Object.values(useGraphStore.getState().graphs)) {
      expect(graph.recognizers.map((item) => item.label)).toEqual([renamed]);
      expect(graph.flow?.steps).toHaveLength(3);
      expect(graph.flow?.steps[1]?.params?.rec).toBe(renamed);
      expect(graph.flow?.steps[2]?.params?.rec).toBe(renamed);
      expect(graph.recognizers[0]?.classes).toEqual(['button']);
    }
    expect(
      (useGraphStore.getState().raws[SCRIPT_SCOPE]?.flow?.steps[1]?.params as { rec?: string } | undefined)
        ?.rec,
    ).toBe(renamed);
    expect(useSessionStore.getState().runningWorkflowRoots).toBe(running);
  });
  it('atomic update fourth newLabel发送一次RPC，最终label/引用与两名字缓存同步', async () => {
    const oldRev = getYoloExamplesRevision(old),
      newRev = getYoloExamplesRevision(renamed);
    invoke.mockResolvedValue({ label: renamed, graph: payload(renamed) });
    expect(await useSessionStore.getState().updateYoloRecognizer(id, old, { threshold: 0.4 }, renamed)).toBe(
      true,
    );
    expect(
      invoke.mock.calls.filter(
        (call) => (call[1] as { method?: string } | undefined)?.method === 'recognizer.update',
      ),
    ).toHaveLength(1);
    expect(
      invoke.mock.calls.some(
        (call) => (call[1] as { method?: string } | undefined)?.method === 'recognizer.rename',
      ),
    ).toBe(false);
    expect(invoke).toHaveBeenCalledWith('engine_rpc', {
      method: 'recognizer.update',
      params: { deviceId: id, label: old, spec: { threshold: 0.4 }, newLabel: renamed },
    });
    expect(useGraphStore.getState().graphs[id]?.flow?.steps[1]?.params?.rec).toBe(renamed);
    expect(getYoloExamplesRevision(old)).not.toBe(oldRev);
    expect(getYoloExamplesRevision(renamed)).not.toBe(newRev);
  });
  it('旧三参数update兼容，不额外发送newLabel', async () => {
    invoke.mockResolvedValue({ label: old, graph: payload(old) });
    expect(await useSessionStore.getState().updateYoloRecognizer(id, old, {})).toBe(true);
    expect(invoke).toHaveBeenCalledWith('engine_rpc', {
      method: 'recognizer.update',
      params: { deviceId: id, label: old, spec: {} },
    });
  });
});
