/**
 * 变量引用关系：面板要据此告诉用户"改这个会影响哪几步"。
 */
import { describe, expect, it } from 'vitest';

import {
  actionVariables,
  collectVariableUsage,
  referencedVariable,
  usageSummary,
} from '@/lib/variable-usage';
import type { GraphData, GraphEdgeView } from '@/types';

function edge(id: string, action: GraphEdgeView['actionSpec']): GraphEdgeView {
  return {
    id,
    from: 'main',
    to: null,
    when: 'x',
    kind: 'normal',
    priority: 0,
    minScore: 0,
    cooldownMs: 0,
    retries: 1,
    action: action.type,
    condition: { allOf: ['x'], anyOf: [], noneOf: [], minScore: 0, withinMs: 0 },
    actionSpec: action,
  };
}

const graph: GraphData = {
  deviceId: 'dev',
  nodes: [],
  edges: [
    edge('e1', { type: 'click', x: '$点击X', y: 0.8 }),
    edge('e2', { type: 'swipe', x: '$点击X', y: 0.2, toX: 0.5, toY: 0.9, durationMs: '$时长' }),
    edge('e3', { type: 'wait', seconds: 1 }),
  ],
  recognizers: [],
  variables: [],
  activeNodeId: null,
  pendingNodeId: null,
};

describe('变量引用关系', () => {
  it('读出 $引用，字面量返回 null', () => {
    expect(referencedVariable('$点击X')).toBe('点击X');
    expect(referencedVariable(0.5)).toBeNull();
    expect(referencedVariable('$')).toBeNull();
    expect(referencedVariable(undefined)).toBeNull();
  });

  it('一个动作里用到的变量（含滑动时长）', () => {
    const names = actionVariables(graph.edges[1]!.actionSpec);
    expect(names).toHaveLength(2);
    expect(names).toContain('点击X');
    expect(names).toContain('时长');
  });

  it('谁在用谁：按变量和按边两个方向都能查', () => {
    const usage = collectVariableUsage(graph);
    expect(usage.byVariable['点击X']).toEqual(['e1', 'e2']);
    expect(usage.byVariable['时长']).toEqual(['e2']);
    expect(usage.byEdge['e1']).toEqual(['点击X']);
    expect(usage.byEdge['e3']).toBeUndefined(); // 没用变量
  });

  it('摘要文案：没引用 / 少量引用 / 多引用', () => {
    expect(usageSummary([])).toContain('还没有步骤引用');
    expect(usageSummary(['e1', 'e2'])).toContain('e1、e2');
    expect(usageSummary(['e1', 'e2', 'e3', 'e4', 'e5'])).toContain('被 5 步引用');
  });

  it('空图不炸', () => {
    expect(collectVariableUsage(undefined)).toEqual({ byVariable: {}, byEdge: {} });
  });
});
