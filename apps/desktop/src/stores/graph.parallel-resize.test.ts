import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseBlocks } from '@/features/graph/flow/flow-structure-core';
import { toGraphData } from '@/lib/graph-adapter';
import { graphGet, graphSave, type GraphPayload } from '@/lib/rpc';
import { SCRIPT_SCOPE, useGraphStore } from '@/stores/graph.store';
import type { FlowStep } from '@/types';

vi.mock('@/lib/rpc', () => ({ devLog: vi.fn(), graphGet: vi.fn(), graphSave: vi.fn() }));
vi.mock('@/stores/template.store', () => ({ preloadTemplates: vi.fn() }));
vi.mock('@/stores/session.store', () => ({
  useSessionStore: { getState: () => ({ currentWorkflow: null, runningWorkflowRoots: {} }) },
}));

function payload(branches = 2, contentBranch?: number): GraphPayload {
  const steps: FlowStep[] = [
    { id: 'trigger', type: 'manual' },
    { id: 'parallel', type: 'parallel', params: { branches, mode: 'all' } },
  ];
  for (let branch = 1; branch <= branches; branch += 1) {
    steps.push({ id: `branch${branch}`, type: 'parallelbranch', params: { parallel: 'parallel', branch } });
    if (branch === contentBranch) steps.push({ id: 'content', type: 'delay', params: { ms: 100 } });
  }
  steps.push({ id: 'join', type: 'parallelend', params: { parallel: 'parallel' } });
  return {
    version: 1,
    defaults: {},
    recognizers: {},
    nodes: [],
    edges: [],
    flow: { steps: steps.map((step) => ({ ...step })) },
  };
}

function install(raw: GraphPayload): void {
  useGraphStore.setState({
    graphs: { [SCRIPT_SCOPE]: toGraphData(SCRIPT_SCOPE, raw) },
    raws: { [SCRIPT_SCOPE]: raw },
    liveByDevice: {},
    workflowSnapshots: {},
    flowNotice: null,
    flowUndo: [],
    flowRedo: [],
  });
}
function currentSteps(): readonly FlowStep[] {
  return useGraphStore.getState().graphs[SCRIPT_SCOPE]?.flow?.steps ?? [];
}

beforeEach(() => {
  vi.mocked(graphSave).mockReset();
  vi.mocked(graphSave).mockImplementation((raw) => Promise.resolve(raw));
  vi.mocked(graphGet).mockReset();
});

describe('parallel branch count updates rebuild persisted markers', () => {
  it('grows 2→4 with empty new branches and survives saved graph refresh', async () => {
    install(payload());
    await useGraphStore.getState().updateFlowStep('parallel', { params: { branches: 4, mode: 'any' } });
    expect(currentSteps().find((step) => step.id === 'parallel')?.params).toMatchObject({
      branches: 4,
      mode: 'any',
    });
    const block = parseBlocks(currentSteps()).find((item) => item.headId === 'parallel');
    expect(block?.branches?.map((branch) => branch.branch)).toEqual([1, 2, 3, 4]);
    for (const branch of block?.branches ?? []) expect(branch.endIndex - branch.markerIndex).toBe(1);
    const saved = vi.mocked(graphSave).mock.calls.at(-1)?.[0];
    expect(saved?.flow?.steps.filter((step) => step.type === 'parallelbranch')).toHaveLength(4);
    expect(saved).toBeDefined();
    vi.mocked(graphGet).mockResolvedValue(saved!);
    await useGraphStore.getState().refresh();
    expect(parseBlocks(currentSteps()).find((item) => item.headId === 'parallel')?.branches).toHaveLength(4);
    expect(currentSteps().some((step) => step.params?._pendingLink)).toBe(false);
  });

  it('shrinks 4→2 only when removed branches are empty', async () => {
    install(payload(4, 1));
    await useGraphStore.getState().updateFlowStep('parallel', { params: { branches: 2, mode: 'all' } });
    expect(parseBlocks(currentSteps()).find((item) => item.headId === 'parallel')?.branches).toHaveLength(2);
    expect(currentSteps().filter((step) => step.type === 'parallelbranch')).toHaveLength(2);
    expect(currentSteps().find((step) => step.id === 'content')).toBeDefined();
    expect(vi.mocked(graphSave)).toHaveBeenCalledTimes(1);
  });

  it('rejects removing branch content without changing graph or sending a save', async () => {
    install(payload(4, 4));
    const before = useGraphStore.getState();
    await useGraphStore.getState().updateFlowStep('parallel', { params: { branches: 2, mode: 'any' } });
    const after = useGraphStore.getState();
    expect(after.graphs).toBe(before.graphs);
    expect(after.raws).toBe(before.raws);
    expect(after.flowUndo).toBe(before.flowUndo);
    expect(after.flowNotice?.text).toContain('分支 4');
    expect(currentSteps().find((step) => step.id === 'parallel')?.params?.branches).toBe(4);
    expect(currentSteps().find((step) => step.id === 'content')?.params?._pendingLink).toBeUndefined();
    expect(graphSave).not.toHaveBeenCalled();
  });

  it('rejects invalid branch counts and does not rewrite markers for ordinary params changes', async () => {
    install(payload());
    await useGraphStore.getState().updateFlowStep('parallel', { params: { branches: 5 } });
    expect(graphSave).not.toHaveBeenCalled();
    await useGraphStore.getState().updateFlowStep('parallel', { params: { branches: 2, mode: 'any' } });
    expect(
      currentSteps()
        .filter((step) => step.type === 'parallelbranch')
        .map((step) => step.id),
    ).toEqual(['branch1', 'branch2']);
    expect(currentSteps().find((step) => step.id === 'parallel')?.params?.mode).toBe('any');
  });
});
