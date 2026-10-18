import { describe, expect, it } from 'vitest';

import { buildBranchFlowEdges } from '@/features/graph/flow/flow-branch-layout';
import { connectSteps } from '@/features/graph/flow/flow-structure';
import { stepsToFlowCanvas, unconnectedFlowSteps } from '@/features/graph/flow/flow-layout';
import type { FlowStep } from '@/types';

describe('buildBranchFlowEdges', () => {
  it('普通步骤仍是顺序 out 边', () => {
    const steps: FlowStep[] = [
      { id: 't', type: 'manual', params: {} },
      { id: 'a', type: 'delay', params: { ms: 1 } },
    ];
    const edges = buildBranchFlowEdges(steps);
    expect(
      edges.some((edge) => edge.source === 't' && edge.target === 'a' && edge.sourceHandle === 'out'),
    ).toBe(true);
  });

  it('空条件块：没人把后续节点接进来就不补线（只在它身上显示未连线）', () => {
    const bare: FlowStep[] = [
      { id: 't', type: 'manual', params: {} },
      { id: 'c', type: 'cond', params: { rec: 'x' } },
      { id: 'ce', type: 'condend', params: { back: 'c' } },
      { id: 'after', type: 'delay', params: { ms: 1 } },
    ];
    const edges = buildBranchFlowEdges(bare);
    expect(edges.some((edge) => edge.source === 'c' && edge.sourceHandle === 'else')).toBe(false);
    expect(edges.some((edge) => edge.source === 'c' && edge.sourceHandle === 'then')).toBe(false);
    expect(unconnectedFlowSteps(bare).map((step) => step.id)).toEqual(['after']);
  });

  it('同一个空条件块：用户把后续节点连进来过（_in），成立口才接上它', () => {
    const bare: FlowStep[] = [
      { id: 't', type: 'manual', params: {} },
      { id: 'c', type: 'cond', params: { rec: 'x' } },
      { id: 'ce', type: 'condend', params: { back: 'c' } },
      { id: 'after', type: 'delay', params: { ms: 1, _in: ['c:then'] } },
    ];
    const edges = buildBranchFlowEdges(bare);
    expect(edges.some((edge) => edge.source === 'c' && edge.sourceHandle === 'else')).toBe(false);
    expect(
      edges.some((edge) => edge.source === 'c' && edge.sourceHandle === 'then' && edge.target === 'after'),
    ).toBe(true);
  });

  it('循环体：体末直接连回循环节点，循环后从循环节点出口接出；不画 loopend', () => {
    const withBreak: FlowStep[] = [
      { id: 't', type: 'manual', params: {} },
      { id: 'lp', type: 'loop', params: { count: 10 } },
      { id: 'd', type: 'delay', params: { ms: 500 } },
      { id: 'br', type: 'loopbreak', params: {} },
      { id: 'le', type: 'loopend', params: { back: 'lp' } },
    ];
    const breakEdges = buildBranchFlowEdges(withBreak);
    expect(breakEdges.some((edge) => edge.source === 'd' && edge.target === 'after')).toBe(false);
    expect(breakEdges.some((edge) => edge.target === 'le')).toBe(false);
    expect(breakEdges.some((edge) => edge.source === 'le')).toBe(false);

    const withAfter: FlowStep[] = [...withBreak, { id: 'after', type: 'delay', params: { ms: 1 } }];
    const afterEdges = buildBranchFlowEdges(withAfter);
    expect(
      afterEdges.some(
        (edge) => edge.source === 'lp' && edge.target === 'after' && edge.sourceHandle === 'out',
      ),
    ).toBe(true);
    expect(afterEdges.some((edge) => edge.source === 'br')).toBe(false);
    expect(afterEdges.some((edge) => edge.source === 'd' && edge.target === 'after')).toBe(false);

    const repeatBody: FlowStep[] = [
      { id: 't', type: 'manual', params: {} },
      { id: 'lp', type: 'loop', params: { count: 3 } },
      { id: 'd', type: 'delay', params: { ms: 100 } },
      { id: 'le', type: 'loopend', params: { back: 'lp' } },
    ];
    const repeatEdges = buildBranchFlowEdges(repeatBody);
    expect(
      repeatEdges.some(
        (edge) =>
          edge.source === 'd' &&
          edge.target === 'lp' &&
          edge.sourceHandle === 'out' &&
          edge.targetHandle === 'back' &&
          edge.type === 'step',
      ),
    ).toBe(true);
    expect(
      repeatEdges.some(
        (edge) =>
          edge.source === 'lp' && edge.target === 'd' && edge.sourceHandle === 'body' && edge.type === 'step',
      ),
    ).toBe(true);
  });

  it('循环里空条件：成立和不成立都可以折线回到循环', () => {
    const steps: FlowStep[] = [
      { id: 't', type: 'manual', params: {} },
      { id: 'lp', type: 'loop', params: { count: 10 } },
      { id: 'c', type: 'cond', params: { rec: 'x' } },
      { id: 'ce', type: 'condend', params: { back: 'c' } },
      { id: 'le', type: 'loopend', params: { back: 'lp' } },
    ];
    const edges = buildBranchFlowEdges(steps);
    expect(
      edges.some(
        (edge) =>
          edge.source === 'c' &&
          edge.sourceHandle === 'then' &&
          edge.target === 'lp' &&
          edge.targetHandle === 'back',
      ),
    ).toBe(true);
    expect(
      edges.some(
        (edge) =>
          edge.source === 'c' &&
          edge.sourceHandle === 'else' &&
          edge.target === 'lp' &&
          edge.targetHandle === 'back',
      ),
    ).toBe(true);
  });

  it('循环体内的条件：成立支末尾折线回到循环节点，不接到隐藏的 condend/loopend', () => {
    const steps: FlowStep[] = [
      { id: 't', type: 'manual', params: {} },
      { id: 'lp', type: 'loop', params: { count: 10 } },
      { id: 'c', type: 'cond', params: { rec: 'x' } },
      { id: 'yes', type: 'delay', params: { ms: 500 } },
      { id: 'e', type: 'else', params: {} },
      { id: 'br', type: 'loopbreak', params: {} },
      { id: 'ce', type: 'condend', params: { back: 'c' } },
      { id: 'le', type: 'loopend', params: { back: 'lp' } },
      { id: 'after', type: 'delay', params: { ms: 1 } },
    ];
    const edges = buildBranchFlowEdges(steps);
    expect(
      edges.some(
        (edge) =>
          edge.source === 'yes' &&
          edge.target === 'lp' &&
          edge.targetHandle === 'back' &&
          edge.type === 'step',
      ),
    ).toBe(true);
    expect(
      edges.some((edge) => edge.source === 'lp' && edge.target === 'after' && edge.sourceHandle === 'out'),
    ).toBe(true);
    expect(edges.some((edge) => edge.source === 'br')).toBe(false);
    expect(edges.some((edge) => edge.target === 'ce' || edge.source === 'ce')).toBe(false);
    expect(edges.some((edge) => edge.target === 'le' || edge.source === 'le')).toBe(false);
  });

  it('条件块（3 通模块）：画出成立/不成立两出口，两支末尾直接连向后续节点', () => {
    const steps: FlowStep[] = [
      { id: 't', type: 'manual', params: {} },
      { id: 'c', type: 'cond', params: { rec: 'x' } },
      { id: 'yes', type: 'delay', params: { ms: 1 } },
      { id: 'e', type: 'else', params: {} },
      { id: 'no', type: 'key', params: { value: 'back' } },
      { id: 'ce', type: 'condend', params: { back: 'c' } },
      { id: 'after', type: 'delay', params: { ms: 2, _in: ['yes:out', 'no:out'] } },
    ];
    const edges = buildBranchFlowEdges(steps);
    expect(
      edges.some((edge) => edge.source === 'c' && edge.sourceHandle === 'then' && edge.target === 'yes'),
    ).toBe(true);
    expect(
      edges.some((edge) => edge.source === 'c' && edge.sourceHandle === 'else' && edge.target === 'no'),
    ).toBe(true);
    expect(edges.some((edge) => edge.source === 'yes' && edge.target === 'after')).toBe(true);
    expect(edges.some((edge) => edge.source === 'no' && edge.target === 'after')).toBe(true);
  });
});

describe('嵌套条件块：分支尾巴不能串进外层的「否则」支', () => {
  it('外层「不成立」接到内层分支之后的模块：内层两支尾巴不会一起连过去', () => {
    const steps: FlowStep[] = [
      { id: 't', type: 'manual', params: {} },
      { id: 'outer', type: 'cond', params: { rec: 'a' } },
      { id: 'inner', type: 'cond', params: { rec: 'b' } },
      { id: 'yes', type: 'click', params: {} },
      { id: 'innerElse', type: 'else', params: {} },
      { id: 'no', type: 'click', params: {} },
      { id: 'innerEnd', type: 'condend', params: { back: 'inner' } },
      { id: 'outerEnd', type: 'condend', params: { back: 'outer' } },
      { id: 'team', type: 'click', params: { _pendingLink: true } },
    ];
    const result = connectSteps(steps, 'outer', 'team', 'else');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const edges = buildBranchFlowEdges(result.steps);
    expect(edges.map((edge) => `${edge.source}-${edge.sourceHandle}->${edge.target}`).sort()).toEqual([
      'inner-else->no',
      'inner-then->yes',
      'outer-else->team',
      'outer-then->inner',
      't-out->outer',
    ]);
    expect(result.steps.find((step) => step.id === 'team')?.params?._pendingLink).toBeUndefined();
  });

  it('内层成立支的尾巴接外层块之后的模块，而不是外层「否则」支的首步', () => {
    const steps: FlowStep[] = [
      { id: 't', type: 'manual', params: {} },
      { id: 'outer', type: 'cond', params: { rec: 'a' } },
      { id: 'inner', type: 'cond', params: { rec: 'b' } },
      { id: 'yes', type: 'click', params: {} },
      { id: 'innerEnd', type: 'condend', params: { back: 'inner' } },
      { id: 'outerElse', type: 'else', params: {} },
      { id: 'no', type: 'click', params: {} },
      { id: 'outerEnd', type: 'condend', params: { back: 'outer' } },
      { id: 'after', type: 'click', params: { _in: ['yes:out', 'no:out'] } },
    ];
    const edges = buildBranchFlowEdges(steps);
    expect(
      edges.some((edge) => edge.source === 'outer' && edge.sourceHandle === 'else' && edge.target === 'no'),
    ).toBe(true);
    expect(edges.some((edge) => edge.source === 'yes' && edge.target === 'after')).toBe(true);
    expect(edges.some((edge) => edge.source === 'yes' && edge.target === 'no')).toBe(false);
    expect(edges.some((edge) => edge.source === 'no' && edge.target === 'after')).toBe(true);
  });
});

describe('connectSteps else 口', () => {
  it('从不成立口连线：成立支保持空，目标落在「否则」支里', () => {
    const steps: FlowStep[] = [
      { id: 't', type: 'manual', params: {} },
      { id: 'c', type: 'cond', params: {} },
      { id: 'ce', type: 'condend', params: { back: 'c' } },
      { id: 'x', type: 'delay', params: { ms: 1 } },
    ];
    const result = connectSteps(steps, 'c', 'x', 'else');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // 「否则」标记由结构补出（画布不显示），x 在它后面
    expect(result.steps.map((step) => step.id)).toEqual(['t', 'c', expect.any(String), 'x', 'ce']);
    const edges = buildBranchFlowEdges(result.steps);
    expect(edges.some((edge) => edge.source === 'c' && edge.sourceHandle === 'else')).toBe(true);
    expect(edges.some((edge) => edge.source === 'c' && edge.sourceHandle === 'then')).toBe(false);
  });
});

describe('stepsToFlowCanvas integration', () => {
  it('连线由数组顺序派生；未接入模块不连入链', () => {
    const steps: FlowStep[] = [
      { id: 't', type: 'manual', params: {} },
      { id: 'a', type: 'delay', params: { ms: 1 } },
      { id: 'b', type: 'delay', params: { ms: 2 } },
    ];
    const { edges: all } = stepsToFlowCanvas(steps, {}, null, null);
    expect(all.map((edge) => `${edge.source}->${edge.target}`)).toEqual(['t->a', 'a->b']);

    const detached: FlowStep[] = [
      steps[0] as FlowStep,
      steps[1] as FlowStep,
      { ...(steps[2] as FlowStep), params: { ms: 2, _pendingLink: true } },
    ];
    const { edges: some, nodes } = stepsToFlowCanvas(detached, {}, null, null);
    expect(some.map((edge) => `${edge.source}->${edge.target}`)).toEqual(['t->a']);
    expect(nodes.find((node) => node.id === 'b')?.data.pending).toBe(true);
  });
});

describe('分支口再连一次 = 换掉，旧目标不会自己接回来', () => {
  it('把「成立」从 A 改接到 X：A 变未连线，画布上不再有 c→A', () => {
    const steps: FlowStep[] = [
      { id: 't', type: 'manual', params: {} },
      { id: 'c', type: 'cond', params: { rec: 'a' } },
      { id: 'A', type: 'click', params: {} },
      { id: 'e', type: 'else', params: {} },
      { id: 'B', type: 'click', params: {} },
      { id: 'ce', type: 'condend', params: { back: 'c' } },
      { id: 'X', type: 'click', params: { _pendingLink: true } },
    ];
    const result = connectSteps(steps, 'c', 'X', 'then');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const edges = buildBranchFlowEdges(result.steps).map(
      (edge) => `${edge.source}:${edge.sourceHandle ?? ''}->${edge.target}`,
    );
    expect(edges.sort()).toEqual(['c:else->B', 'c:then->X', 't:out->c']);
    // 旧的「成立」目标不再挂在条件上：变成未接入的独立模块（引擎走到它之前就结束）
    expect(result.steps.at(-1)?.id).toBe('A');
    expect(result.steps.at(-1)?.params?._pendingLink).toBe(true);
    expect(unconnectedFlowSteps(result.steps).map((step) => step.id)).toContain('A');
  });
});

describe('截图里的那份工作流：块后的「创建队伍」没人接', () => {
  const shape = (): FlowStep[] => [
    { id: 't', type: 'manual', params: {} },
    { id: 'c5', type: 'cond', params: { rec: 'a' } },
    { id: 'create', type: 'click', params: {} },
    { id: 'e5', type: 'else', params: {} },
    { id: 'c3', type: 'cond', params: { rec: 'b' } },
    { id: 'chal', type: 'click', params: {} },
    { id: 'e3', type: 'else', params: {} },
    { id: 'ce3', type: 'condend', params: { back: 'c3' } },
    { id: 'ce5', type: 'condend', params: { back: 'c5' } },
    { id: 'team', type: 'click', params: {} },
  ];

  it('没人从某一支接过去：队伍不出线、标未连线；接了之后才进链', () => {
    const before = shape();
    const edgesBefore = buildBranchFlowEdges(before);
    expect(edgesBefore.some((edge) => edge.target === 'team')).toBe(false);
    expect(unconnectedFlowSteps(before).map((step) => step.id)).toEqual(['team']);

    const connected = connectSteps(before, 'c3', 'team', 'else');
    expect(connected.ok).toBe(true);
    if (!connected.ok) {
      return;
    }
    const edgesAfter = buildBranchFlowEdges(connected.steps);
    expect(
      edgesAfter.some(
        (edge) => edge.source === 'c3' && edge.sourceHandle === 'else' && edge.target === 'team',
      ),
    ).toBe(true);
    // 挑战是「成立」那一支的尾巴，不会因为它被连到队伍
    expect(edgesAfter.some((edge) => edge.source === 'chal' && edge.target === 'team')).toBe(false);
    expect(unconnectedFlowSteps(connected.steps)).toEqual([]);
  });
});

describe('「结束」步骤：这一支到此为止', () => {
  const shape = (): FlowStep[] => [
    { id: 't', type: 'manual', params: {} },
    { id: 'c', type: 'cond', params: { rec: 'r' } },
    { id: 'chal', type: 'click', params: {} },
    { id: 'stop', type: 'end', params: {} },
    { id: 'e', type: 'else', params: {} },
    { id: 'team', type: 'click', params: {} },
    { id: 'ce', type: 'condend', params: { back: 'c' } },
    { id: 'tail', type: 'click', params: { _in: ['team:out'] } },
  ];

  it('分支末尾是「结束」：不画续接到块后第一步的线，也和后面的步骤没有边', () => {
    const edges = buildBranchFlowEdges(shape());
    const has = (source: string, target: string): boolean =>
      edges.some((edge) => edge.source === source && edge.target === target);

    // 成立支：条件 → 挑战 → 结束
    expect(has('c', 'chal')).toBe(true);
    expect(has('chal', 'stop')).toBe(true);
    // 「结束」没有出口：不接块后的 tail
    expect(edges.some((edge) => edge.source === 'stop')).toBe(false);
    // 不成立支照旧接到块后的 tail
    expect(has('c', 'team')).toBe(true);
    expect(has('team', 'tail')).toBe(true);
  });
});

describe('循环：结构化闭环虚线 + 一个入口只留一条线', () => {
  const loopWith = (bodyOut: string[], afterOut: string[] = []): FlowStep[] => [
    { id: 't', type: 'manual', params: { _out: ['out>lp'] } },
    { id: 'lp', type: 'loop', params: { count: 10, _out: ['body>b', 'out>after'] } },
    { id: 'b', type: 'click', params: { _out: bodyOut } },
    { id: 'le', type: 'loopend', params: { back: 'lp', _out: [] } },
    { id: 'after', type: 'delay', params: { ms: 1, _out: afterOut } },
  ];

  it('循环体尾巴没接线：补一条删不掉的虚线回环，指向循环开头', () => {
    const edges = buildBranchFlowEdges(loopWith([]));
    const back = edges.find((edge) => edge.id === 'flow_loopback_b_lp');
    expect(back).toBeDefined();
    expect(back?.targetHandle).toBe('back');
    expect(back?.deletable).toBe(false);
    expect(back?.style?.strokeDasharray).toBe('6 4');
  });

  it('用户自己画了回线：不重复补', () => {
    const edges = buildBranchFlowEdges(loopWith(['out>lp']));
    expect(edges.filter((edge) => edge.source === 'b' && edge.target === 'lp')).toHaveLength(1);
    expect(edges.some((edge) => edge.id === 'flow_loopback_b_lp')).toBe(false);
  });

  it('循环体尾巴接去了别处：不补回环（那条线是真的走了）', () => {
    const edges = buildBranchFlowEdges(loopWith(['out>after']));
    expect(edges.some((edge) => edge.id === 'flow_loopback_b_lp')).toBe(false);
  });

  it('合流：两条不同的线可以接同一个模块；但同一个循环不能用自己的两个出口接同一步', () => {
    const merged: FlowStep[] = [
      { id: 't', type: 'manual', params: { _out: ['out>c'] } },
      { id: 'c', type: 'cond', params: { rec: 'x', _out: ['then>a'] } },
      { id: 'a', type: 'click', params: { _out: ['out>after'] } },
      { id: 'e', type: 'else', params: {} },
      { id: 'b', type: 'click', params: { _out: ['out>after'] } },
      { id: 'ce', type: 'condend', params: { back: 'c' } },
      { id: 'after', type: 'delay', params: { ms: 1, _out: [] } },
    ];
    expect(buildBranchFlowEdges(merged).filter((edge) => edge.target === 'after')).toHaveLength(2);
  });

  it('同一个循环的两个出口接同一步：新的那条把旧的换掉', () => {
    const steps: FlowStep[] = [
      { id: 't', type: 'manual', params: { _out: ['out>lp'] } },
      { id: 'lp', type: 'loop', params: { count: 10, _out: ['body>b', 'out>c'] } },
      { id: 'b', type: 'click', params: { _out: [] } },
      { id: 'le', type: 'loopend', params: { back: 'lp', _out: [] } },
      { id: 'c', type: 'click', params: { _out: [] } },
    ];
    const next = connectSteps(steps, 'lp', 'c', 'body', 'in');
    expect(next.ok).toBe(true);
    if (!next.ok) {
      return;
    }
    const stored = next.steps.flatMap((step) => {
      const out = step.params?._out;
      return Array.isArray(out) ? out.map(String) : [];
    });
    expect(stored.filter((item) => item.endsWith('>c'))).toHaveLength(1);
    expect(buildBranchFlowEdges(next.steps).filter((edge) => edge.target === 'c')).toHaveLength(1);
  });
});
