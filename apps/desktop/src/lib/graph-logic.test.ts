/**
 * 状态图"人话层"的单测：把 JSON 翻成人能读的句子。
 *
 * 这些函数决定界面上显示什么，显示错了用户就会误判脚本逻辑，所以逐条钉死。
 */
import { describe, expect, it } from 'vitest';

import {
  describeAction,
  describeCondition,
  describeEdgeLogic,
  describeNodeLogic,
  edgeLabel,
} from '@/lib/graph-logic';
import type { EdgeAction, GraphData, GraphEdgeView, GraphNodeView } from '@/types';

const graph: GraphData = {
  deviceId: 'dev',
  nodes: [
    { id: 'launcher', name: '桌面', enter: ['icon'], x: 0, y: 0, visits: 3 },
    { id: 'dialer', name: '拨号盘', enter: [], x: 200, y: 0, visits: 1 },
  ],
  edges: [],
  recognizers: [],
  variables: [],
  activeNodeId: 'launcher',
  pendingNodeId: null,
};

function edge(partial: Partial<GraphEdgeView> & { actionSpec: EdgeAction }): GraphEdgeView {
  return {
    id: 'e1',
    from: 'launcher',
    to: 'dialer',
    when: 'icon',
    kind: 'normal',
    priority: 0,
    minScore: 0,
    cooldownMs: 0,
    retries: 1,
    action: partial.actionSpec.type,
    condition: { allOf: ['icon'], anyOf: [], noneOf: [], minScore: 0, withinMs: 0 },
    ...partial,
  };
}

describe('操作摘要', () => {
  it('点击：识别器目标显示标签，坐标目标显示坐标', () => {
    expect(describeAction({ type: 'click', target: 'icon' })).toBe('点击 『icon』');
    expect(describeAction({ type: 'click', x: 0.5, y: 0.812 })).toBe('点击 (0.50, 0.81)');
  });

  it('滑动：起止点与目标都对', () => {
    expect(describeAction({ type: 'swipe', x: 0.5, y: 0.8, toX: 0.5, toY: 0.2 })).toContain(
      '(0.50, 0.80)→(0.50, 0.20)',
    );
    expect(describeAction({ type: 'swipe', target: 'a', toTarget: 'b' })).toBe('滑动 『a』→『b』');
  });

  it('等待/按键/文本', () => {
    expect(describeAction({ type: 'wait', seconds: 1.5 })).toBe('等待 1.50s');
    expect(describeAction({ type: 'key', value: 'back' })).toBe('按键 back');
    expect(describeAction({ type: 'text', value: 'hello' })).toBe('输入 "hello"');
  });

  it('长按带按住时长', () => {
    expect(describeAction({ type: 'long_press', x: 0.2, y: 0.3, durationMs: 800 })).toBe(
      '长按 (0.20, 0.30) 按住 0.80s',
    );
  });
});

describe('条件摘要', () => {
  it('默认形态（就是 when）显示为"某某出现"', () => {
    expect(describeCondition(edge({ actionSpec: { type: 'click', target: 'icon' } }))).toBe('『icon』出现');
  });

  it('且/或/非 与分数、限时都体现出来', () => {
    const item = edge({
      actionSpec: { type: 'click', target: 'icon' },
      condition: {
        allOf: ['a'],
        anyOf: ['b'],
        noneOf: ['c'],
        minScore: 0.82,
        withinMs: 1500,
      },
    });
    const text = describeCondition(item);
    expect(text).toContain('『a』出现');
    expect(text).toContain('『b』');
    expect(text).toContain('无『c』');
    expect(text).toContain('score ≥ 0.82');
    expect(text).toContain('限时 1500ms');
  });

  it('无条件（录制出来的一步）', () => {
    const item = edge({
      actionSpec: { type: 'wait', seconds: 1 },
      condition: { allOf: [], anyOf: [], noneOf: [], minScore: 0, withinMs: 0, always: true },
    });
    expect(describeCondition(item)).toBe('无条件');
  });
});

describe('整条边 / 整个节点', () => {
  it('边的逻辑是一句完整的话（含起点、条件、操作、终点）', () => {
    const text = describeEdgeLogic(edge({ actionSpec: { type: 'click', target: 'icon' } }), graph);
    expect(text).toContain('在『桌面』');
    expect(text).toContain('『icon』出现');
    expect(text).toContain('点击 『icon』');
    expect(text).toContain('进入『拨号盘』');
  });

  it('不切界面的边说明"（不切界面）"', () => {
    const text = describeEdgeLogic(edge({ to: null, actionSpec: { type: 'wait', seconds: 1 } }), graph);
    expect(text).toContain('（不切界面）');
  });

  it('图上标题先是操作、再是去向', () => {
    expect(edgeLabel(edge({ actionSpec: { type: 'click', target: 'icon' } }), graph)).toBe(
      '点击 『icon』 → 拨号盘',
    );
  });

  it('中断边带 ⚡ 前缀', () => {
    const item = edge({ kind: 'recovery', actionSpec: { type: 'key', value: 'back' } });
    expect(edgeLabel(item, graph)).toContain('⚡');
  });

  it('节点逻辑能看出"怎么判定、有哪些操作、进来几次"', () => {
    const node = graph.nodes[0] as GraphNodeView;
    const lines = describeNodeLogic(node, {
      ...graph,
      edges: [edge({ actionSpec: { type: 'click', target: 'icon' } })],
    });
    expect(lines[0]).toContain('界面判定');
    expect(lines[0]).toContain('『icon』');
    expect(lines.join(' ')).toContain('出去的操作 1 条');
    expect(lines.join(' ')).toContain('已经进入过 3 次');
  });

  it('没有识别器的节点要明确提示（不然用户不知道为什么进不去）', () => {
    const node: GraphNodeView = { id: 'x', name: '新界面', enter: [], x: 0, y: 0, visits: 0 };
    expect(describeNodeLogic(node, graph)[0]).toContain('没有识别器');
  });
});
