import { describe, expect, it } from 'vitest';

import { buildBranchFlowEdges } from '@/features/graph/flow/flow-branch-layout';
import { isHiddenFlowStep } from '@/features/graph/flow/flow-hidden';
import { gridPositionsForSteps, stepsToFlowCanvas } from '@/features/graph/flow/flow-layout';
import { estimateFlowNodeSize } from '@/features/graph/flow/flow-node-size';
import { FLOW_BRANCH_GAP_Y, FLOW_NODE_GAP_X } from '@/features/graph/flow/flow-spacing';
import type { FlowStep } from '@/types';

function parallel(id: string, branches: readonly FlowStep[][]): FlowStep[] {
  return [
    { id, type: 'parallel', params: { branches: branches.length } },
    ...branches.flatMap((body, index) => [
      { id: `${id}-branch${index + 1}`, type: 'parallelbranch', params: { parallel: id, branch: index + 1 } },
      ...body,
    ]),
    { id: `${id}-end`, type: 'parallelend', params: { parallel: id } },
  ];
}

const action = (id: string): FlowStep => ({ id, type: 'delay', params: { ms: 10 } });

function expectNoOverlap(steps: readonly FlowStep[]): void {
  const positions = gridPositionsForSteps(steps);
  const visible = steps.filter((step) => !isHiddenFlowStep(step));
  for (let a = 0; a < visible.length; a += 1) {
    for (let b = a + 1; b < visible.length; b += 1) {
      const left = visible[a]!;
      const right = visible[b]!;
      const p = positions[left.id]!;
      const q = positions[right.id]!;
      const s = estimateFlowNodeSize(left);
      const t = estimateFlowNodeSize(right);
      const disjoint = p.x + s.w <= q.x || q.x + t.w <= p.x || p.y + s.h <= q.y || q.y + t.h <= p.y;
      expect(disjoint, `${left.id} overlaps ${right.id}`).toBe(true);
    }
  }
}

describe('parallel flow layout', () => {
  it.each([2, 3, 4])('%i branches occupy separate lanes and continue beyond the longest lane', (count) => {
    const branches = Array.from({ length: count }, (_, index) =>
      Array.from({ length: index + 1 }, (_, n) => action(`b${index + 1}-${n}`)),
    );
    const steps = [{ id: 't', type: 'manual' }, ...parallel('p', branches), action('after')];
    const positions = gridPositionsForSteps(steps);
    const head = positions.p!;
    let bottom = head.y + estimateFlowNodeSize(steps[1]!).h;
    for (const branch of branches) {
      const start = positions[branch[0]!.id]!;
      expect(start.x).toBe(head.x);
      expect(start.y).toBeGreaterThanOrEqual(bottom + FLOW_BRANCH_GAP_Y);
      bottom = start.y + estimateFlowNodeSize(branch[0]!).h;
    }
    expect(positions.after!.y).toBe(head.y);
    expect(positions.after!.x).toBe(head.x + count * FLOW_NODE_GAP_X);
    expect(positions['p-end']).toEqual(positions.after);
    expectNoOverlap(steps);
  });

  it('nested condition, loop and parallel subtrees reserve both horizontal and vertical space', () => {
    const steps = [
      { id: 't', type: 'manual' },
      ...parallel('outer', [
        [
          { id: 'cond', type: 'cond' },
          ...parallel('inner', [[action('i1'), action('i2')], [action('i3')]]),
          action('then-tail'),
          { id: 'else', type: 'else' },
          { id: 'loop', type: 'loop', params: { count: 2 } },
          action('loop-a'), action('loop-b'),
          { id: 'loop-end', type: 'loopend', params: { back: 'loop' } },
          action('else-tail'),
          { id: 'cond-end', type: 'condend', params: { back: 'cond' } },
          action('branch-tail'),
        ],
        [action('other-lane')],
      ]),
      action('after'),
    ];
    const positions = gridPositionsForSteps(steps);
    expectNoOverlap(steps);
    expect(positions['other-lane']!.y).toBeGreaterThan(positions['i3']!.y);
    expect(positions.after!.x).toBeGreaterThan(positions['branch-tail']!.x);
    expect(positions['then-tail']!.x).toBeGreaterThan(positions.i2!.x);
  });

  it('consecutive nested blocks cannot overlap an earlier branch tail', () => {
    const steps = [
      ...parallel('p', [[
        { id: 'loop1', type: 'loop' }, action('a'), action('b'), action('c'),
        { id: 'end1', type: 'loopend', params: { back: 'loop1' } },
        { id: 'loop2', type: 'loop' }, action('d'),
        { id: 'end2', type: 'loopend', params: { back: 'loop2' } },
      ], [action('second')]]),
      action('after'),
    ];
    expectNoOverlap(steps);
  });

  it('measured large cards and empty branches retain reserved lane space', () => {
    const steps = [...parallel('p', [[action('wide')], [], [action('last')]]), action('after')];
    const sizes = (step: FlowStep) => step.id === 'wide' ? { w: 620, h: 480 } : estimateFlowNodeSize(step);
    const positions = gridPositionsForSteps(steps, sizes);
    expect(positions.after!.x).toBeGreaterThanOrEqual(positions.wide!.x + 620);
    expect(positions.last!.y).toBeGreaterThan(positions.wide!.y + 480 + FLOW_BRANCH_GAP_Y);
    expect(positions['p-branch2']!.y).toBeLessThan(positions.last!.y);
  });

  it('renders labeled branch edges and continuation without exposing structural markers', () => {
    const steps: FlowStep[] = [
      { id: 't', type: 'manual', params: { _out: ['out>p'] } },
      ...parallel('p', [[action('a')], [action('b')], [action('c')], [action('d')]]),
      action('after'),
    ].map((step) => ({
      ...step,
      params: {
        ...step.params,
        _out: step.id === 'p' ? ['branch1>a', 'branch2>b', 'branch3>c', 'branch4>d', 'out>after'] : (step.params?._out ?? []),
      },
    }));
    const { nodes, edges } = stepsToFlowCanvas(steps, {}, null);
    expect(nodes.map((node) => node.id)).toEqual(['t', 'p', 'a', 'b', 'c', 'd', 'after']);
    expect(edges.filter((edge) => edge.source === 'p' && edge.sourceHandle !== 'out').map((edge) => edge.label))
      .toEqual(['分支 1', '分支 2', '分支 3', '分支 4']);
    expect(edges.find((edge) => edge.sourceHandle === 'branch4')?.type).toBe('step');
    expect(buildBranchFlowEdges(steps).some((edge) => edge.source === 'p' && edge.target === 'after')).toBe(true);
  });
});
