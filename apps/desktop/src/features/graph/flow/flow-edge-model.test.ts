import { describe, expect, it } from 'vitest';

import { buildBranchFlowEdges } from '@/features/graph/flow/flow-branch-layout';
import {
  connectFlowSteps,
  disconnectFlowSteps,
  flowEdges,
  legacyFlowEdges,
  linearizeFlow,
  withFlowEdges,
} from '@/features/graph/flow/flow-edge-model';
import { gridPositionsForSteps, unconnectedFlowSteps } from '@/features/graph/flow/flow-layout';
import { migrateFlowSteps, validateFlowSteps } from '@/features/graph/flow/flow-structure';
import type { FlowEdge } from '@/features/graph/flow/flow-edge-model';
import type { FlowStep } from '@/types';

const s = (id: string, type = 'click', params: Record<string, unknown> = {}): FlowStep => ({
  id,
  type,
  params,
});

/** 显式连线模型里，接线就是 `_out`，这里把它读成便于比对的小字符串。 */
function edgeKeys(edges: readonly FlowEdge[]): string[] {
  return edges.map((edge) => `${edge.source}:${edge.sourceHandle}->${edge.target}`).sort();
}

function okSteps(result: { ok: true; steps: FlowStep[] } | { ok: false; error: string }): FlowStep[] {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.steps;
}

describe('验收 1：两条互不相干的链，连一条就只多一条', () => {
  // t → a → b   /   c → d（c、d 还没接进主链）
  const shape = (): FlowStep[] => [
    s('t', 'manual', { _out: ['out>a'] }),
    s('a', 'delay', { _out: ['out>b'] }),
    s('b', 'delay', { _out: [] }),
    s('c', 'delay', { _out: ['out>d'], _pendingLink: true }),
    s('d', 'delay', { _out: [] }),
  ];

  it('b 的出口连到 c：正好三条真实连线，画布不补线、节点不搬家', () => {
    const before = shape();
    const positionsBefore = gridPositionsForSteps(before);
    const result = connectFlowSteps(before, 'b', 'c', 'out');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const next = result.steps;
    expect(edgeKeys(flowEdges(next))).toEqual(['a:out->b', 'b:out->c', 'c:out->d', 't:out->a']);
    // 画布上就是这几条，没有续接、没有第二条
    expect(
      buildBranchFlowEdges(next)
        .map((edge) => `${edge.source}->${edge.target}`)
        .sort(),
    ).toEqual(['a->b', 'b->c', 'c->d', 't->a']);
    // 顺序没变 = 节点位置不变（画布只认 steps 的先后，不认接线）
    expect(next.map((step) => step.id)).toEqual(['t', 'a', 'b', 'c', 'd']);
    expect(gridPositionsForSteps(next)).toEqual(positionsBefore);
    expect(unconnectedFlowSteps(next)).toEqual([]);
    expect(next.find((step) => step.id === 'c')?.params?._pendingLink).toBeUndefined();
  });

  it('删掉 b→c：只剩 a→b 和 c→d，c、d 变未连线', () => {
    const connected = okSteps(connectFlowSteps(shape(), 'b', 'c', 'out'));
    const next = okSteps(disconnectFlowSteps(connected, { sourceId: 'b', targetId: 'c' }));
    expect(edgeKeys(flowEdges(next))).toEqual(['a:out->b', 'c:out->d', 't:out->a']);
    // 断开就是断开：不会自己接回 b→d，也不会接出 a→c
    expect(flowEdges(next).some((edge) => edge.source === 'b' && edge.target === 'd')).toBe(false);
    expect(flowEdges(next).some((edge) => edge.source === 'a' && edge.target === 'c')).toBe(false);
    expect(unconnectedFlowSteps(next).map((step) => step.id)).toEqual(['c']);
    expect(next.find((step) => step.id === 'c')?.params?._pendingLink).toBe(true);
  });
});

describe('验收 2：用户真实那份 10 步工作流', () => {
  // 手动 → 条件(region_5) → 创建(region_2) / 否则 → 条件(region_3) → 挑战(region_4) / 否则
  //      → 条件结束(region_3) → 条件结束(region_5) → 队伍(region_1)
  const shape = (): FlowStep[] => [
    s('t', 'manual'),
    s('region_5', 'cond', { rec: 'region' }),
    s('region_2', 'click'),
    s('e5', 'else'),
    s('region_3', 'cond', { rec: 'region' }),
    s('region_4', 'click'),
    s('e3', 'else'),
    s('ce3', 'condend', { back: 'region_3' }),
    s('ce5', 'condend', { back: 'region_5' }),
    s('region_1', 'click'),
  ];

  it('迁移后连线 == 老推导画出来的那些，一条不多一条不少', () => {
    const before = shape();
    const legacy = legacyFlowEdges(before);
    const migrated = migrateFlowSteps(before);
    expect(edgeKeys(flowEdges(migrated))).toEqual(edgeKeys(legacy));
    expect(migrated.every((step) => Array.isArray(step.params?._out))).toBe(true);
    // 队伍还是没人接：老文件里它本来就没接上
    expect(unconnectedFlowSteps(migrated).map((step) => step.id)).toEqual(['region_1']);
  });

  it('把 region_3 的「不成立」接到队伍：只多这一条，不会冒出「挑战→队伍」「创建→队伍」', () => {
    const migrated = migrateFlowSteps(shape());
    const result = connectFlowSteps(migrated, 'region_3', 'region_1', 'else');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const keys = edgeKeys(flowEdges(result.steps));
    expect(keys).toContain('region_3:else->region_1');
    expect(keys).not.toContain('region_4:out->region_1');
    expect(keys).not.toContain('region_2:out->region_1');
    expect(keys).toEqual([
      'region_3:else->region_1',
      'region_3:then->region_4',
      'region_5:else->region_3',
      'region_5:then->region_2',
      't:out->region_5',
    ]);
    expect(unconnectedFlowSteps(result.steps)).toEqual([]);
  });
});

describe('验收 2b：老文件里已经存在的续接线冻结一次，不再随连线增加', () => {
  // 老版本画布会在「块后第一步」身上留下 `_in`（用户画过的线），推导时每个分支尾都去接它。
  // 迁移只把当时屏幕上的线原样冻结，之后再连线不会再冒出新的一条。
  const shape = (): FlowStep[] => [
    s('t', 'manual'),
    s('region_5', 'cond', { rec: 'region' }),
    s('region_2', 'click'),
    s('e5', 'else'),
    s('region_3', 'cond', { rec: 'region' }),
    s('region_4', 'click'),
    s('e3', 'else'),
    s('ce3', 'condend', { back: 'region_3' }),
    s('ce5', 'condend', { back: 'region_5' }),
    s('region_1', 'click', { _in: ['region_4:out', 'region_2:out'] }),
  ];

  it('迁移冻结出老画布上的线；再接一条只多一条（入口允许合流）', () => {
    const migrated = migrateFlowSteps(shape());
    const before = edgeKeys(flowEdges(migrated));
    expect(before).toContain('region_4:out->region_1');
    expect(before).toContain('region_2:out->region_1');

    const result = connectFlowSteps(migrated, 'region_3', 'region_1', 'else');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const after = edgeKeys(flowEdges(result.steps));
    expect(after.filter((key) => !before.includes(key))).toEqual(['region_3:else->region_1']);
    // 入口可以合流：原来两条款接还在，三条线都接在同一模块上
    expect(after.filter((key) => key === 'region_4:out->region_1')).toHaveLength(1);
    expect(after.filter((key) => key === 'region_2:out->region_1')).toHaveLength(1);
  });
});

describe('合流：成立支走完再落到同一步，不成立直接落到那一步', () => {
  const shape = (): FlowStep[] => [
    s('t', 'schedule', { at: '09:00', _out: ['out>k1'] }),
    s('k1', 'click', { _out: ['out>lp'] }),
    s('lp', 'loop', { count: 10, _out: ['out>c'] }),
    s('le', 'loopend', { back: 'lp', _out: [] }),
    s('c', 'cond', { rec: '', _out: ['then>sw'] }),
    s('ce', 'condend', { back: 'c', _out: [] }),
    s('sw', 'swipe', { _out: ['out>k2'] }),
    s('k2', 'click', { _out: [] }),
  ];

  it('不成立接到「成立支走完后的那一步」：两支都落到 k2，k2 排在块后', () => {
    const result = connectFlowSteps(shape(), 'c', 'k2', 'else');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.steps.map((step) => step.id)).toEqual(['t', 'k1', 'lp', 'le', 'c', 'sw', 'ce', 'k2']);
    expect(edgeKeys(flowEdges(result.steps))).toEqual(
      expect.arrayContaining(['c:then->sw', 'c:else->k2', 'sw:out->k2']),
    );
  });

  it('先接不成立、再接成立支尾巴，结果一样', () => {
    const first = connectFlowSteps(shape(), 'c', 'k2', 'else');
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const second = connectFlowSteps(first.steps, 'sw', 'k2', 'out');
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(edgeKeys(flowEdges(second.steps))).toEqual(
      expect.arrayContaining(['c:then->sw', 'c:else->k2', 'sw:out->k2']),
    );
  });
});

describe('验收 3：空的条件支不画线，目标是未连线、不能运行', () => {
  const shape = (): FlowStep[] => [
    s('t', 'manual', { _out: ['out>c'] }),
    s('c', 'cond', { rec: 'x', _out: [] }),
    s('x', 'click', { _out: [], _pendingLink: true }),
  ];

  it('成立支空着：条件上没有多出来的线，x 是未连线', () => {
    const steps = shape();
    const keys = edgeKeys(flowEdges(steps));
    expect(keys).toEqual(['t:out->c']);
    expect(flowEdges(steps).some((edge) => edge.source === 'c' && edge.target === 'x')).toBe(false);
    expect(unconnectedFlowSteps(steps).map((step) => step.id)).toEqual(['x']);
    // 运行前的检查用的就是这个列表：非空就不许运行
    expect(unconnectedFlowSteps(steps).length).toBeGreaterThan(0);
  });

  it('把 x 接到「成立」口之后才进链，而且只多这一条线', () => {
    const result = connectFlowSteps(shape(), 'c', 'x', 'then');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(edgeKeys(flowEdges(result.steps))).toEqual(['c:then->x', 't:out->c']);
    expect(unconnectedFlowSteps(result.steps)).toEqual([]);
  });
});

describe('验收 4：条件两条支汇到同一步，仍然按顺序串成一个数组', () => {
  const edges: FlowEdge[] = [
    { source: 't', sourceHandle: 'out', target: 'c' },
    { source: 'c', sourceHandle: 'then', target: 'yes' },
    { source: 'c', sourceHandle: 'else', target: 'no' },
    { source: 'yes', sourceHandle: 'out', target: 'after' },
    { source: 'no', sourceHandle: 'out', target: 'after' },
  ];
  const shape = (): FlowStep[] => [
    s('t', 'manual'),
    s('c', 'cond', { rec: 'x' }),
    s('yes', 'delay'),
    s('e', 'else'),
    s('no', 'delay'),
    s('ce', 'condend', { back: 'c' }),
    s('after', 'delay'),
  ];

  it('合成 条件 → 成立支 → 否则 → 不成立支 → 条件结束 → 汇合后的那一步', () => {
    const steps = shape();
    const linear = withFlowEdges(steps, edges);
    expect(edgeKeys(flowEdges(linear))).toEqual(edgeKeys(edges));
    const result = linearizeFlow(linear, edges);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.steps.map((step) => step.id)).toEqual(['t', 'c', 'yes', 'e', 'no', 'ce', 'after']);
    expect(validateFlowSteps(result.steps)).toBeNull();
    // 引擎看到的是线性数组，汇合点只出现一次
    expect(result.steps.filter((step) => step.id === 'after')).toHaveLength(1);
  });
});

describe('连线模型的基本约定', () => {
  it('写回 `_out` 是幂等的，顺序稳定', () => {
    const steps = [s('t', 'manual'), s('a'), s('b')];
    const edges: FlowEdge[] = [
      { source: 'b', sourceHandle: 'out', target: 't' },
      { source: 't', sourceHandle: 'out', target: 'a' },
    ];
    const once = withFlowEdges(steps, edges);
    const twice = withFlowEdges(once, flowEdges(once));
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('存盘只差一次 JSON：`_out` 原样留在 params 里，读回来线还在', () => {
    const stored = JSON.parse(
      JSON.stringify(
        withFlowEdges(
          [s('t', 'manual'), s('a'), s('b')],
          [
            { source: 't', sourceHandle: 'out', target: 'a' },
            { source: 'a', sourceHandle: 'out', target: 'b' },
          ],
        ),
      ),
    ) as FlowStep[];
    expect(edgeKeys(flowEdges(stored))).toEqual(['a:out->b', 't:out->a']);
  });

  it('没有 `_out` 的老文件仍然按数组画线（老文件打开和以前一样）', () => {
    const steps = [s('t', 'manual'), s('a'), s('b')];
    expect(edgeKeys(flowEdges(steps))).toEqual(['a:out->b', 't:out->a']);
  });

  it('`_out` 指向不存在的模块、自己、块标记都不会生效', () => {
    const steps = [
      s('t', 'manual', { _out: ['out>a', 'out>ghost', 'out>t', 'out>ce'] }),
      s('a', 'delay', { _out: ['out>a'] }),
      s('c', 'cond', { _out: [] }),
      s('ce', 'condend', { back: 'c' }),
    ];
    expect(edgeKeys(flowEdges(steps))).toEqual(['t:out->a']);
  });

  it('「结束」没有出口：接到它后面会被拒绝', () => {
    const steps = [
      s('t', 'manual', { _out: ['out>a'] }),
      s('a', 'end', { _out: [] }),
      s('b', 'delay', { _out: [] }),
    ];
    const result = connectFlowSteps(steps, 'a', 'b', 'out');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('结束');
    }
  });
});
