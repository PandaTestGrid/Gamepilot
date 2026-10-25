import { describe, expect, it } from 'vitest';
import { flowEdges, linearizeFlow, withFlowEdges, type FlowEdge } from './flow-edge-model';
import { parseBlocks, validateFlowSteps } from './flow-structure-core';
import { sourcePortsForStep } from './flow-step-ports';
import { resizeParallelBranches } from './flow-parallel-resize';
import { removeStepsFromChain } from './flow-structure';
import { disconnectSteps } from './flow-disconnect';
import { wrapSelectionInLoop } from './flow-wrap-loop';
import { appendPaletteModule } from './flow-palette-insert';
import type { FlowStep } from '@/types';
const steps: FlowStep[] = [
  { id: 't', type: 'manual' },
  { id: 'p', type: 'parallel', params: { mode: 'all', branches: 2 } },
  { id: 'm1', type: 'parallelbranch', params: { parallel: 'p', branch: 1 } },
  { id: 'a', type: 'click', params: {} },
  { id: 'm2', type: 'parallelbranch', params: { parallel: 'p', branch: 2 } },
  { id: 'b', type: 'touch', params: { phase: 'down', finger: 2 } },
  { id: 'e', type: 'parallelend', params: { parallel: 'p' } },
  { id: 'next', type: 'delay' },
];
const edges: FlowEdge[] = [
  { source: 't', sourceHandle: 'out', target: 'p' },
  { source: 'p', sourceHandle: 'branch1', target: 'a' },
  { source: 'p', sourceHandle: 'branch2', target: 'b' },
  { source: 'p', sourceHandle: 'out', target: 'next' },
];
describe('并行画布结构', () => {
  it('按DSL解析2branch并隐藏边界，动态ports只显示声明分支', () => {
    expect(validateFlowSteps(steps)).toBeNull();
    expect(parseBlocks(steps)[0]?.branches?.map((branch) => branch.branch)).toEqual([1, 2]);
    expect(sourcePortsForStep(steps[1]!).map((port) => port.id)).toEqual(['out', 'branch1', 'branch2']);
  });
  it('显式多分支线性化与保存重读幂等，join仅执行一次', () => {
    const result = linearizeFlow(steps, edges);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.map((step) => step.type)).toEqual([
      'manual',
      'parallel',
      'parallelbranch',
      'click',
      'parallelbranch',
      'touch',
      'parallelend',
      'delay',
    ]);
    expect(result.steps.filter((step) => step.id === 'next')).toHaveLength(1);
    expect(flowEdges(withFlowEdges(result.steps, edges))).toEqual(expect.arrayContaining(edges));
    expect(flowEdges(withFlowEdges(result.steps, edges))).toHaveLength(edges.length);
  });
  it('palette新增默认2支完整边界', () => {
    const inserted = appendPaletteModule([steps[0]!], {
      type: 'parallel',
      label: '并行',
      hint: '',
      defaultParams: { mode: 'any', branches: 2 },
    });
    expect(inserted).not.toBeNull();
    expect(validateFlowSteps(inserted!.steps)).toBeNull();
    expect(inserted!.steps.filter((step) => step.type === 'parallelbranch')).toHaveLength(2);
  });
  it('禁止分支内call与缺失branch，不静默串行降级', () => {
    expect(
      validateFlowSteps(steps.map((step) => (step.id === 'a' ? { ...step, type: 'call' } : step))),
    ).toContain('不能调用');
    expect(validateFlowSteps(steps.filter((step) => step.id !== 'm2'))).toContain('完整分支');
  });
  it('两支共享中间节点拒绝，不能重复执行或串进另一支', () => {
    const result = linearizeFlow(steps, [
      ...edges.filter((edge) => edge.sourceHandle !== 'branch2'),
      { source: 'p', sourceHandle: 'branch2', target: 'a' },
    ]);
    expect(result.ok).toBe(false);
  });
  it('2到4完整生成新空支，4回2可删空支；有内容分支拒绝缩减', () => {
    const explicit = withFlowEdges(steps, edges);
    const grown = resizeParallelBranches(explicit, 'p', 4);
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;
    expect(parseBlocks(grown.steps)[0]?.branches).toHaveLength(4);
    expect(validateFlowSteps(grown.steps)).toBeNull();
    expect(resizeParallelBranches(grown.steps, 'p', 2).ok).toBe(true);
    const moved = withFlowEdges(grown.steps, [
      ...edges.filter((edge) => edge.sourceHandle !== 'branch2'),
      { source: 'p', sourceHandle: 'branch3', target: 'b' },
    ]);
    const ordered = linearizeFlow(moved, flowEdges(moved));
    expect(ordered.ok).toBe(true);
    if (ordered.ok) expect(resizeParallelBranches(ordered.steps, 'p', 2).ok).toBe(false);
  });
  it('删除并行头不遗留孤儿分支标记', () => {
    const removed = removeStepsFromChain(withFlowEdges(steps, edges), ['p']);
    expect(
      removed.steps.some((step) => ['parallel', 'parallelbranch', 'parallelend'].includes(step.type)),
    ).toBe(false);
    expect(validateFlowSteps(removed.steps)).toBeNull();
  });
  it('断开一支不串进另一支，另一分支与汇合保持', () => {
    const result = disconnectSteps(withFlowEdges(steps, edges), {
      sourceId: 'p',
      sourceHandle: 'branch1',
      targetId: 'a',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(flowEdges(result.steps)).toEqual(
      expect.arrayContaining(edges.filter((edge) => edge.sourceHandle !== 'branch1')),
    );
    expect(result.steps.find((step) => step.id === 'a')?.params?._pendingLink).toBe(true);
    expect(
      parseBlocks(result.steps)[0]?.branches?.map((branch) =>
        result.steps.slice(branch.markerIndex + 1, branch.endIndex).map((step) => step.id),
      ),
    ).toEqual([[], ['b']]);
  });
  it('整个并行块可套循环，owner与分支边不变', () => {
    const result = wrapSelectionInLoop(
      withFlowEdges(steps, edges),
      steps.slice(1, 7).map((step) => step.id),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateFlowSteps(result.steps)).toBeNull();
    expect(parseBlocks(result.steps).map((block) => block.kind)).toEqual(['parallel', 'loop']);
    expect(result.steps.find((step) => step.id === 'm1')?.params?.parallel).toBe('p');
  });
  it('nested parallel / cond / loop 线性化保存往返保留完整块', () => {
    const nested: FlowStep[] = [
      ...steps.slice(0, 3),
      { id: 'inner', type: 'parallel', params: { mode: 'any', branches: 2 } },
      { id: 'ib1', type: 'parallelbranch', params: { parallel: 'inner', branch: 1 } },
      { id: 'cond', type: 'cond' },
      { id: 'ca', type: 'delay' },
      { id: 'ce', type: 'condend', params: { back: 'cond' } },
      { id: 'ib2', type: 'parallelbranch', params: { parallel: 'inner', branch: 2 } },
      { id: 'loop', type: 'loop', params: { count: 2 } },
      { id: 'la', type: 'delay' },
      { id: 'le', type: 'loopend', params: { back: 'loop' } },
      { id: 'ie', type: 'parallelend', params: { parallel: 'inner' } },
      ...steps.slice(4),
    ];
    const links: FlowEdge[] = [
      ...edges.filter((edge) => edge.sourceHandle !== 'branch1'),
      { source: 'p', sourceHandle: 'branch1', target: 'inner' },
      { source: 'inner', sourceHandle: 'branch1', target: 'cond' },
      { source: 'inner', sourceHandle: 'branch2', target: 'loop' },
      { source: 'cond', sourceHandle: 'then', target: 'ca' },
      { source: 'loop', sourceHandle: 'body', target: 'la' },
      { source: 'la', sourceHandle: 'out', target: 'loop' },
    ];
    const result = linearizeFlow(nested, links);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateFlowSteps(result.steps)).toBeNull();
    expect(parseBlocks(result.steps).map((block) => block.kind)).toEqual([
      'cond',
      'loop',
      'parallel',
      'parallel',
    ]);
    const saved = JSON.parse(JSON.stringify(result.steps)) as FlowStep[];
    const again = linearizeFlow(saved, flowEdges(saved));
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.steps).toEqual(result.steps);
  });
  it('支持两支都显式连接共同out汇合点', () => {
    const result = linearizeFlow(steps, [
      ...edges,
      { source: 'a', sourceHandle: 'out', target: 'next' },
      { source: 'b', sourceHandle: 'out', target: 'next' },
    ]);
    expect(result.ok).toBe(true);
  });
});
