/**
 * 线性脚本步骤的单测。
 *
 * 顺序规则必须和引擎一致，否则界面上"看起来会先做 A"而实际先做 B —— 这种不一致
 * 会让用户彻底失去对脚本的信任，所以逐条钉死。
 */
import { describe, expect, it } from 'vitest';

import { buildScriptSteps, findStartNode, selectedStepId } from '@/lib/script-steps';
import type { GraphData, GraphEdgeView, GraphNodeView } from '@/types';

function node(id: string, name: string, enter: string[] = [id]): GraphNodeView {
  return { id, name, enter, x: 0, y: 0, visits: 0 };
}

function edge(
  id: string,
  from: string,
  to: string | null,
  action: GraphEdgeView['actionSpec'],
  priority = 0,
): GraphEdgeView {
  return {
    id,
    from,
    to,
    when: 'x',
    kind: 'normal',
    priority,
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
  nodes: [node('launcher', '桌面', ['icon']), node('dialer', '拨号盘', ['pad'])],
  edges: [
    edge('e1', 'launcher', 'dialer', { type: 'click', target: 'icon' }),
    edge('e2', 'dialer', null, { type: 'wait', seconds: 1 }),
  ],
  recognizers: [],
  variables: [],
  activeNodeId: null,
  pendingNodeId: null,
};

describe('脚本步骤', () => {
  it('起点选"没有入边的界面"', () => {
    expect(findStartNode(graph)).toBe('launcher');
    expect(findStartNode(undefined)).toBeNull();
    expect(findStartNode({ ...graph, nodes: [], edges: [] })).toBeNull();
  });

  it('按执行顺序展开：界面 → 它的操作 → 下一个界面', () => {
    const steps = buildScriptSteps(graph);
    expect(steps.map((step) => step.title)).toEqual([
      '界面『桌面』',
      '点击 『icon』',
      '界面『拨号盘』',
      '等待 1.00s',
    ]);
    expect(steps[1]?.detail).toContain('进入『拨号盘』');
    expect(steps[1]?.depth).toBe(1); // 操作缩进在界面下面
    expect(steps.every((step) => step.reachable)).toBe(true);
  });

  it('同一界面的多个出口按优先级从高到低（和引擎一致）', () => {
    const withPriority: GraphData = {
      ...graph,
      edges: [
        edge('low', 'launcher', 'dialer', { type: 'wait', seconds: 0.5 }, 0),
        edge('high', 'launcher', 'dialer', { type: 'click', target: 'icon' }, 10),
      ],
    };
    const steps = buildScriptSteps(withPriority).filter((step) => step.kind === 'edge');
    expect(steps[0]?.title).toContain('点击');
    expect(steps[1]?.title).toContain('等待');
  });

  it('环形流程不会无限展开', () => {
    const loop: GraphData = {
      ...graph,
      edges: [
        edge('a', 'launcher', 'dialer', { type: 'click', x: 0.1, y: 0.1 }),
        edge('b', 'dialer', 'launcher', { type: 'click', x: 0.2, y: 0.2 }),
      ],
    };
    const steps = buildScriptSteps(loop);
    expect(steps.filter((step) => step.kind === 'node')).toHaveLength(2);
  });

  it('走不到的界面也列出来并标注（不然用户以为它不存在）', () => {
    const orphan: GraphData = {
      ...graph,
      nodes: [...graph.nodes, node('hidden', '隐藏页')],
    };
    const steps = buildScriptSteps(orphan);
    const last = steps[steps.length - 1];
    expect(last?.title).toBe('界面『隐藏页』');
    expect(last?.reachable).toBe(false);
    expect(last?.detail).toContain('走不到');
  });

  it('中断边带 ⚡ 前缀', () => {
    const withRecovery: GraphData = {
      ...graph,
      edges: [{ ...edge('r', 'launcher', null, { type: 'key', value: 'back' }), kind: 'recovery' as const }],
    };
    expect(buildScriptSteps(withRecovery)[1]?.title).toContain('⚡');
  });

  it('空图不炸', () => {
    expect(buildScriptSteps(undefined)).toEqual([]);
    expect(buildScriptSteps({ ...graph, nodes: [], edges: [] })).toEqual([]);
  });

  it('选中态：边优先于节点', () => {
    expect(selectedStepId('n1', 'e1')).toBe('e1');
    expect(selectedStepId('n1', null)).toBe('n1');
    expect(selectedStepId(null, null)).toBeNull();
  });
});
