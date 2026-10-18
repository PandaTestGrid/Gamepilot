import { describe, expect, it } from 'vitest';

import { buildBranchFlowEdges } from '@/features/graph/flow/flow-branch-layout';
import { connectSteps } from '@/features/graph/flow/flow-structure';
import { flowEdges } from '@/features/graph/flow/flow-edge-model';
import { disconnectSteps } from '@/features/graph/flow/flow-disconnect';
import type { FlowStep } from '@/types';

const s = (id: string, type = 'delay', params: Record<string, unknown> = {}): FlowStep => ({
  id,
  type,
  params,
});

function okSteps(result: ReturnType<typeof disconnectSteps>): FlowStep[] {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.steps;
}

function hasStoredEdge(steps: FlowStep[], source: string, target: string): boolean {
  return flowEdges(steps).some((edge) => edge.source === source && edge.target === target);
}

function hasEdge(steps: FlowStep[], source: string, target: string, sourceHandle?: string): boolean {
  return buildBranchFlowEdges(steps).some(
    (edge) =>
      edge.source === source &&
      edge.target === target &&
      (sourceHandle === undefined || edge.sourceHandle === sourceHandle),
  );
}

describe('disconnectSteps', () => {
  it('主链 out→in：下游模块就地变为未接入，不改顺序', () => {
    const steps = [s('t', 'manual'), s('a'), s('b')];
    const next = okSteps(disconnectSteps(steps, { sourceId: 'a', targetId: 'b', sourceHandle: 'out' }));
    expect(next.map((step) => step.id)).toEqual(['t', 'a', 'b']);
    expect(next[2]!.params?._pendingLink).toBe(true);
    expect(hasEdge(next, 'a', 'b')).toBe(false);
  });

  it('断开中间连线后，不会自动接到再下一个模块', () => {
    const steps = [s('t', 'manual'), s('a'), s('b'), s('c')];
    const next = okSteps(disconnectSteps(steps, { sourceId: 'a', targetId: 'b', sourceHandle: 'out' }));
    expect(next.map((step) => step.id)).toEqual(['t', 'a', 'b', 'c']);
    expect(next.find((step) => step.id === 'b')?.params?._pendingLink).toBe(true);
    expect(hasEdge(next, 'a', 'b')).toBe(false);
    expect(hasEdge(next, 'a', 'c')).toBe(false);
    expect(hasEdge(next, 'b', 'c')).toBe(true);
  });

  it('条件成立口：分支整段变成未接入，条件不会自己改接到条件后', () => {
    const steps = [
      s('t', 'manual'),
      s('c', 'cond'),
      s('yes', 'click'),
      s('ce', 'condend', { back: 'c' }),
      s('after'),
    ];
    const next = okSteps(disconnectSteps(steps, { sourceId: 'c', targetId: 'yes', sourceHandle: 'then' }));
    // 成立支断了：条件两支都空，yes 掉到链尾变未接入
    expect(next.map((step) => step.id)).toEqual(['t', 'c', 'ce', 'yes', 'after']);
    expect(next.find((step) => step.id === 'yes')?.params?._pendingLink).toBe(true);
    expect(hasEdge(next, 'c', 'yes', 'then')).toBe(false);
    expect(hasEdge(next, 'c', 'after', 'then')).toBe(false);
  });

  it('循环进入口：断开后循环体整段变未接入，只少这一条线', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('a', 'click'),
      s('b', 'click'),
      s('le', 'loopend', { back: 'lp' }),
      s('after'),
    ];
    const next = okSteps(disconnectSteps(steps, { sourceId: 'lp', targetId: 'a', sourceHandle: 'body' }));
    expect(next.map((step) => step.id)).toEqual(['t', 'lp', 'le', 'after', 'a', 'b']);
    expect(next.find((step) => step.id === 'a')?.params?._pendingLink).toBe(true);
    expect(hasEdge(next, 'lp', 'a', 'body')).toBe(false);
    expect(hasEdge(next, 'lp', 'b', 'body')).toBe(false);
    expect(hasEdge(next, 'lp', 'after', 'out')).toBe(true);
    // 用户只删了进入线：循环体内部那条 a→b 还在（a 是未接入段的首步）
    expect(hasEdge(next, 'a', 'b')).toBe(true);
  });

  it('循环回线：只少这一条回线，进入线和循环体都还在', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('a', 'click'),
      s('b', 'click'),
      s('le', 'loopend', { back: 'lp' }),
      s('after'),
    ];
    const next = okSteps(
      disconnectSteps(steps, {
        sourceId: 'b',
        targetId: 'lp',
        sourceHandle: 'out',
        targetHandle: 'back',
      }),
    );
    expect(next.map((step) => step.id)).toEqual(['t', 'lp', 'a', 'b', 'le', 'after']);
    expect(next.some((step) => step.params?._pendingLink === true)).toBe(false);
    expect(hasEdge(next, 'lp', 'a', 'body')).toBe(true);
    expect(hasEdge(next, 'a', 'b')).toBe(true);
    // 存的线已经断开；画布上只剩一条"结构上循环会回到开头"的虚线
    expect(hasStoredEdge(next, 'b', 'lp')).toBe(false);
    expect(buildBranchFlowEdges(next).some((edge) => edge.id === 'flow_loopback_b_lp')).toBe(true);
    expect(hasEdge(next, 'lp', 'after', 'out')).toBe(true);
  });

  it('循环里的条件回线：只删这条回线，循环体和其它线都不动', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('body', 'click'),
      s('c', 'cond', { rec: 'x' }),
      s('yes', 'click'),
      s('ce', 'condend', { back: 'c' }),
      s('le', 'loopend', { back: 'lp' }),
      s('after'),
    ];
    expect(hasEdge(steps, 'yes', 'lp')).toBe(true);
    const next = okSteps(
      disconnectSteps(steps, {
        sourceId: 'yes',
        targetId: 'lp',
        sourceHandle: 'out',
        targetHandle: 'back',
      }),
    );
    expect(next.map((step) => step.id)).toEqual(['t', 'lp', 'body', 'c', 'yes', 'ce', 'le', 'after']);
    expect(next.some((step) => step.params?._pendingLink === true)).toBe(false);
    expect(hasEdge(next, 'lp', 'body', 'body')).toBe(true);
    expect(hasEdge(next, 'body', 'c')).toBe(true);
    expect(hasEdge(next, 'c', 'yes', 'then')).toBe(true);
    expect(hasEdge(next, 'yes', 'lp')).toBe(false);
  });

  it('条件「不成立」回线断开：只删线，`_loopRepeat` 一起清掉', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('c', 'cond', { rec: 'x' }),
      s('ce', 'condend', { back: 'c' }),
      s('le', 'loopend', { back: 'lp' }),
      s('after'),
    ];
    const connected = connectSteps(steps, 'c', 'lp', 'else', 'back');
    if (!connected.ok) {
      throw new Error(connected.error);
    }
    const next = okSteps(
      disconnectSteps(connected.steps, {
        sourceId: 'c',
        targetId: 'lp',
        sourceHandle: 'else',
        targetHandle: 'back',
      }),
    );
    expect(hasEdge(connected.steps, 'c', 'lp', 'else')).toBe(true);
    expect(hasEdge(next, 'c', 'lp', 'then')).toBe(false);
    expect(hasEdge(next, 'c', 'lp', 'else')).toBe(false);
    // 回线没了，「这一支再循环」的标记也不能留着（否则引擎还会再循环）
    expect(next.find((step) => step.id === 'c')?.params?._loopRepeat).toBeUndefined();
    expect(next.map((step) => step.id)).toEqual(['t', 'lp', 'c', 'ce', 'le', 'after']);
  });

  it('单步循环体：删回环只删回环，再连回去能接上', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('a', 'click'),
      s('le', 'loopend', { back: 'lp' }),
    ];
    const disconnected = okSteps(
      disconnectSteps(steps, { sourceId: 'a', targetId: 'lp', sourceHandle: 'out', targetHandle: 'back' }),
    );
    expect(disconnected.find((step) => step.id === 'a')?.params?._pendingLink).toBeFalsy();
    expect(hasEdge(disconnected, 'lp', 'a', 'body')).toBe(true);
    expect(hasStoredEdge(disconnected, 'a', 'lp')).toBe(false);
    expect(buildBranchFlowEdges(disconnected).some((edge) => edge.id === 'flow_loopback_a_lp')).toBe(true);
    const restored = connectSteps(disconnected, 'a', 'lp', 'out', 'back');
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(hasEdge(restored.steps, 'a', 'lp')).toBe(true);
    }
  });

  it('对不上的线直接当作已断开，不报内部错误', () => {
    const steps = [s('t', 'manual'), s('a'), s('b')];
    const result = disconnectSteps(steps, {
      sourceId: 't',
      targetId: 'b',
      sourceHandle: 'out',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps.map((step) => step.id)).toEqual(['t', 'a', 'b']);
    }
  });
});
