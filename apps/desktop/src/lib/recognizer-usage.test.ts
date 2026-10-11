import { describe, expect, it } from 'vitest';

import { collectRecognizerUsage, describeRecognizerUsage } from '@/lib/recognizer-usage';
import type { EdgeCondition, GraphData, GraphEdgeView, GraphNodeView } from '@/types';

const CONDITION: EdgeCondition = { allOf: [], anyOf: [], noneOf: [], minScore: 0, withinMs: 0 };

function node(id: string, name: string, enter: string[] = []): GraphNodeView {
  return { id, name, enter, x: 0, y: 0, visits: 0 };
}

function edge(
  id: string,
  patch: {
    when?: string;
    condition?: Partial<EdgeCondition>;
    target?: string;
    toTarget?: string;
  } = {},
): GraphEdgeView {
  return {
    id,
    from: null,
    to: null,
    when: patch.when ?? '',
    kind: 'normal',
    priority: 0,
    minScore: 0,
    cooldownMs: 0,
    retries: 1,
    action: '',
    condition: { ...CONDITION, ...patch.condition },
    actionSpec: { type: 'click', target: patch.target, toTarget: patch.toTarget },
  };
}

function graph(nodes: GraphNodeView[], edges: GraphEdgeView[]): GraphData {
  return {
    deviceId: 'mock:1',
    nodes,
    edges,
    recognizers: [],
    variables: [],
    activeNodeId: null,
    pendingNodeId: null,
  };
}

describe('识别器被谁引用（collectRecognizerUsage）', () => {
  it('节点的进入条件算一处', () => {
    const data = graph([node('n_1', '界面1', ['相机', '模版1']), node('n_2', '界面2')], []);

    const usage = collectRecognizerUsage(data, '相机');

    expect(usage.nodes).toEqual([{ id: 'n_1', name: '界面1' }]);
    expect(usage.total).toBe(1);
  });

  it('边的 when 与 condition 是同一个引用，不能数成两处', () => {
    // 界面模型在没有显式 condition 时会用 when 合成 all_of（graph-adapter），
    // 所以一条 `when=相机` 的边，两个字段都命中
    const data = graph([], [edge('e_ai', { when: '相机', condition: { allOf: ['相机'] } })]);

    const usage = collectRecognizerUsage(data, '相机');

    expect(usage.edges).toEqual([{ id: 'e_ai', reasons: ['判断条件'] }]);
    expect(usage.total).toBe(1);
  });

  it('any_of / none_of 也算判断条件', () => {
    const data = graph(
      [],
      [
        edge('e_any', { condition: { anyOf: ['相机'] } }),
        edge('e_none', { condition: { noneOf: ['相机'] } }),
      ],
    );

    expect(collectRecognizerUsage(data, '相机').edges.map((item) => item.id)).toEqual(['e_any', 'e_none']);
  });

  it('动作目标（target / to_target）单独算一处，并和判断条件合并到同一条边', () => {
    const data = graph([], [edge('e_1', { when: '相机', target: '相机', toTarget: '相机' })]);

    const usage = collectRecognizerUsage(data, '相机');

    expect(usage.edges).toEqual([{ id: 'e_1', reasons: ['判断条件', '动作目标'] }]);
    expect(usage.total).toBe(1);
  });

  it('没人引用 → total 0（删除按钮据此可点）', () => {
    const data = graph([node('n_1', '界面1', ['别的'])], [edge('e_1', { when: '别的' })]);

    expect(collectRecognizerUsage(data, '相机')).toEqual({ nodes: [], edges: [], total: 0 });
  });

  it('图还没加载 / 标签为空：返回"没人用"而不是抛错', () => {
    expect(collectRecognizerUsage(undefined, '相机').total).toBe(0);
    expect(collectRecognizerUsage(graph([], []), '').total).toBe(0);
  });
});

describe('引用说明文案（describeRecognizerUsage）', () => {
  it('没人用：直接说删掉不影响脚本', () => {
    expect(describeRecognizerUsage({ nodes: [], edges: [], total: 0 })).toContain('删掉不影响脚本');
  });

  it('节点写成"名字（id）"、边带原因（和引擎提示同一规矩）', () => {
    const text = describeRecognizerUsage({
      nodes: [
        { id: 'node_1', name: '新界面' },
        { id: 'n_1', name: '界面1' },
      ],
      edges: [{ id: 'e_ai', reasons: ['判断条件', '动作目标'] }],
      total: 3,
    });

    // 名字和 id 不同就都写上：重名时（两个「新界面」）才知道该去改哪个
    expect(text).toBe('正在被引用：新界面（node_1）、界面1（n_1）、e_ai（判断条件 + 动作目标）');
  });

  it('超过 3 处：收尾成"等 N 处"，不把面板撑爆', () => {
    const text = describeRecognizerUsage({
      nodes: [
        { id: 'a', name: 'a' },
        { id: 'b', name: 'b' },
        { id: 'c', name: 'c' },
        { id: 'd', name: 'd' },
      ],
      edges: [],
      total: 4,
    });

    expect(text).toContain('等 4 处');
    expect(text).not.toContain('d');
  });
});
