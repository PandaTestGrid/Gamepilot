import { describe, expect, it } from 'vitest';

import { buildBranchFlowEdges } from '@/features/graph/flow/flow-branch-layout';
import {
  connectSteps,
  connectionRejectReason,
  insertUnitBefore,
  migrateFlowSteps,
  parseBlocks,
  removeStepKeepingGap,
  removeStepsFromChain,
  validateFlowSteps,
} from '@/features/graph/flow/flow-structure';
import type { FlowStep } from '@/types';

const s = (id: string, type = 'delay', params: Record<string, unknown> = {}): FlowStep => ({
  id,
  type,
  params,
});
const ids = (steps: readonly FlowStep[]): string[] => steps.map((step) => step.id);

function okSteps(result: ReturnType<typeof connectSteps>): FlowStep[] {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.steps;
}

describe('parseBlocks / validateFlowSteps', () => {
  it('条件块按栈配对', () => {
    const steps = [s('t', 'manual'), s('c1', 'cond'), s('ce1', 'condend', { back: 'c1' })];
    expect(parseBlocks(steps).map((block) => block.headId)).toEqual(['c1']);
    expect(validateFlowSteps(steps)).toBeNull();
  });

  it('第一步必须是触发器', () => {
    expect(validateFlowSteps([s('a')])).not.toBeNull();
  });

  it('拒绝未知步骤类型', () => {
    const steps = [s('t', 'manual'), s('l', 'bogus_kind')];
    expect(validateFlowSteps(steps)).toContain('类型不认识');
  });
});

describe('connectSteps', () => {
  it('out→in：把目标搬到来源后面，并清掉未接入标记', () => {
    const steps = [s('t', 'manual'), s('a'), s('b', 'delay', { _pendingLink: true })];
    const next = okSteps(connectSteps(steps, 'a', 'b', 'out'));
    expect(ids(next)).toEqual(['t', 'a', 'b']);
    expect(next[2]!.params?._pendingLink).toBeFalsy();
  });

  it('把后面的模块连到前面：不搬节点，往回连会形成环被拒绝', () => {
    const steps = [s('t', 'manual'), s('a'), s('b')];
    const result = connectSteps(steps, 'b', 'a', 'out');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('环');
  });

  it('自连、连到触发器、不属于该模块的出口都被拒绝', () => {
    const steps = [s('t', 'manual'), s('a'), s('b')];
    expect(connectSteps(steps, 'a', 'a', 'out').ok).toBe(false);
    expect(connectSteps(steps, 'a', 't', 'out').ok).toBe(false);
    expect(connectSteps(steps, 'a', 'b', 'then').ok).toBe(false);
    expect(connectionRejectReason(steps, 'a', 't', 'out')).toContain('触发器');
  });

  it('不成立口：只有这一支有线，目标就落在「否则」支里（成立支走过它就不走）', () => {
    const steps = [
      s('t', 'manual'),
      s('c', 'cond'),
      s('ce', 'condend', { back: 'c' }),
      s('x', 'delay', { _pendingLink: true }),
    ];
    const next = okSteps(connectSteps(steps, 'c', 'x', 'else'));
    // 「否则」标记是结构需要的，画布上不显示；x 在它后面 = 只有不成立才会走到
    expect(next.map((step) => step.type)).toEqual(['manual', 'cond', 'else', 'delay', 'condend']);
    expect(validateFlowSteps(next)).toBeNull();
  });

  it('条件内可嵌套条件', () => {
    const steps = [
      s('t', 'manual'),
      s('c1', 'cond', { rec: 'a' }),
      s('c2', 'cond', { rec: 'b' }),
      s('ce2', 'condend', { back: 'c2' }),
      s('ce1', 'condend', { back: 'c1' }),
    ];
    const nested = okSteps(connectSteps(steps, 'c1', 'c2', 'then'));
    expect(validateFlowSteps(nested)).toBeNull();
  });

  it('从「开始」直接连到后面的条件：不搬块，跳过的键盘变未接入', () => {
    const steps = [
      s('t', 'manual'),
      s('key', 'key', { value: 'back' }),
      s('c', 'cond', { rec: 'x' }),
      s('inner'),
      s('ce', 'condend', { back: 'c' }),
    ];
    const before = ids(steps);
    const next = okSteps(connectSteps(steps, 't', 'c', 'out'));
    // 数组顺序会跟着接线重排，但位置（画布坐标）不变
    expect(ids(next)).toEqual(['t', 'c', 'inner', 'ce', 'key']);
    expect(next.find((step) => step.id === 'key')?.params?._pendingLink).toBe(true);
    expect(ids(steps)).toEqual(before);
  });

  it('搬动块头会带着整个块；不能把条件块连进它自己里面', () => {
    const steps = [s('t', 'manual'), s('a'), s('c', 'cond'), s('inner'), s('ce', 'condend', { back: 'c' })];
    const next = okSteps(connectSteps(steps, 'a', 'c', 'out'));
    expect(ids(next)).toEqual(['t', 'a', 'c', 'inner', 'ce']);
    expect(connectSteps(steps, 'inner', 'c', 'out').ok).toBe(false);
  });

  it('循环里不成立再循环时，成立支最后一个点击可以接到跳出循环', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('c', 'cond', { rec: 'x', _loopRepeat: 'else' }),
      s('yes', 'click'),
      s('ce', 'condend', { back: 'c' }),
      s('le', 'loopend', { back: 'lp' }),
      s('br', 'loopbreak', { _pendingLink: true }),
    ];
    const next = okSteps(connectSteps(steps, 'yes', 'br', 'out'));
    expect(ids(next)).toEqual(['t', 'lp', 'c', 'yes', 'br', 'ce', 'le']);
    expect(next.find((step) => step.id === 'br')?.params?._pendingLink).toBeFalsy();
    const edges = buildBranchFlowEdges(next);
    expect(
      edges.some((edge) => edge.source === 'yes' && edge.target === 'br' && edge.sourceHandle === 'out'),
    ).toBe(true);
  });

  it('「跳出循环」没有出口：不能再往后连', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('br', 'loopbreak'),
      s('le', 'loopend', { back: 'lp' }),
      s('x', 'key', { value: 'back', _pendingLink: true }),
    ];
    expect(connectSteps(steps, 'br', 'x', 'out').ok).toBe(false);
    expect(connectionRejectReason(steps, 'br', 'x', 'out')).toContain('跳出循环');
  });

  it('从未连线的循环拉「进入」只接循环体，循环本身仍是未接入段', () => {
    const steps = [
      s('t', 'manual'),
      s('a'),
      s('lp', 'loop', { count: 2, _pendingLink: true }),
      s('le', 'loopend', { back: 'lp' }),
      s('d', 'delay', { ms: 1, _pendingLink: true }),
    ];
    const next = okSteps(connectSteps(steps, 'lp', 'd', 'body'));
    // 循环体要真正排进「循环 … 循环结束」之间，否则画布上看不出它进了循环
    expect(ids(next)).toEqual(['t', 'a', 'lp', 'd', 'le']);
    // 内部接线（body）不提交循环本身：否则上一段的 out 会立刻推导出连到它
    expect(next.find((step) => step.id === 'lp')?.params?._pendingLink).toBe(true);
    expect(next.find((step) => step.id === 'd')?.params?._pendingLink).toBeFalsy();
  });

  it('外层循环不会自动连到「未接入」的新循环（body 接线不提交）', () => {
    const steps = [
      s('t', 'manual'),
      s('lp1', 'loop', { count: 100000 }),
      s('a', 'click'),
      s('le1', 'loopend', { back: 'lp1' }),
      s('lp2', 'loop', { count: 10, _pendingLink: true }),
      s('le2', 'loopend', { back: 'lp2' }),
      s('x', 'delay', { ms: 5000, _pendingLink: true }),
    ];
    const next = okSteps(connectSteps(steps, 'lp2', 'x', 'body'));
    expect(next.find((step) => step.id === 'lp2')?.params?._pendingLink).toBe(true);
    expect(next.find((step) => step.id === 'x')?.params?._pendingLink).toBeFalsy();
    expect(buildBranchFlowEdges(next).some((edge) => edge.source === 'lp1' && edge.target === 'lp2')).toBe(
      false,
    );
  });

  it('未接入的单步从出口往外接也不提交：上游不会自动接上', () => {
    const steps = [s('t', 'manual'), s('a'), s('x', 'delay', { _pendingLink: true }), s('y')];
    const next = okSteps(connectSteps(steps, 'x', 'y', 'out'));
    expect(next.find((step) => step.id === 'x')?.params?._pendingLink).toBe(true);
    expect(buildBranchFlowEdges(next).some((edge) => edge.source === 'a' && edge.target === 'x')).toBe(false);
  });

  it('从「未接入」段的主出口往外接：只延长游离段，不接进主链', () => {
    const steps = [
      s('t', 'manual'),
      s('lp1', 'loop', { count: 100000 }),
      s('a', 'click'),
      s('le1', 'loopend', { back: 'lp1' }),
      s('lp2', 'loop', { count: 10, _pendingLink: true }),
      s('le2', 'loopend', { back: 'lp2' }),
      s('x', 'delay', { ms: 5000, _pendingLink: true }),
    ];
    const next = okSteps(connectSteps(steps, 'lp2', 'x', 'out'));
    expect(next.find((step) => step.id === 'lp2')?.params?._pendingLink).toBe(true);
    expect(next.find((step) => step.id === 'x')?.params?._pendingLink).toBeFalsy();
    expect(buildBranchFlowEdges(next).some((edge) => edge.source === 'lp1' && edge.target === 'lp2')).toBe(
      false,
    );
  });

  it('从入口接上「未接入」循环才算接入主链：外层循环会连到它', () => {
    const steps = [
      s('t', 'manual'),
      s('lp1', 'loop', { count: 100000 }),
      s('a', 'click'),
      s('le1', 'loopend', { back: 'lp1' }),
      s('lp2', 'loop', { count: 10, _pendingLink: true }),
      s('le2', 'loopend', { back: 'lp2' }),
      s('x', 'delay', { ms: 5000, _pendingLink: true }),
    ];
    const next = okSteps(connectSteps(steps, 'lp1', 'lp2', 'out'));
    expect(next.find((step) => step.id === 'lp2')?.params?._pendingLink).toBeFalsy();
    expect(buildBranchFlowEdges(next).some((edge) => edge.source === 'lp1' && edge.target === 'lp2')).toBe(
      true,
    );
  });

  it('成立支已有模块时，从不成立口连回循环会在成立支末尾跳出', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('body', 'click'),
      s('c', 'cond', { rec: 'x' }),
      s('yes', 'click'),
      s('ce', 'condend', { back: 'c' }),
      s('le', 'loopend', { back: 'lp' }),
      s('after', 'delay', { ms: 1 }),
    ];
    const next = okSteps(connectSteps(steps, 'c', 'lp', 'else', 'back'));
    expect(next.some((step) => step.type === 'loopbreak')).toBe(false);
    expect(next.find((step) => step.id === 'c')?.params?._loopRepeat).toBe('else');
    expect(next.find((step) => step.id === 'c')?.params?._loopRepeatLoop).toBe('lp');
    const edges = buildBranchFlowEdges(next);
    expect(
      edges.some(
        (edge) =>
          edge.source === 'c' &&
          edge.sourceHandle === 'else' &&
          edge.target === 'lp' &&
          edge.targetHandle === 'back',
      ),
    ).toBe(true);
    expect(edges.some((edge) => edge.source === 'yes' && edge.target === 'lp')).toBe(false);
    expect(edges.some((edge) => edge.source === 'yes' && edge.target === 'after')).toBe(false);
  });

  it('从不成立口连回循环：成立不再自动回环，改为跳出，不成立再循环', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('click', 'click'),
      s('c', 'cond', { rec: 'x' }),
      s('ce', 'condend', { back: 'c' }),
      s('le', 'loopend', { back: 'lp' }),
      s('after', 'delay', { ms: 1 }),
    ];
    const next = okSteps(connectSteps(steps, 'c', 'lp', 'else', 'back'));
    expect(next.some((step) => step.type === 'loopbreak')).toBe(false);
    expect(next.find((step) => step.id === 'c')?.params?._loopRepeat).toBe('else');
    expect(next.find((step) => step.id === 'c')?.params?._loopRepeatLoop).toBe('lp');
    const edges = buildBranchFlowEdges(next);
    expect(
      edges.some(
        (edge) =>
          edge.source === 'c' &&
          edge.sourceHandle === 'else' &&
          edge.target === 'lp' &&
          edge.targetHandle === 'back',
      ),
    ).toBe(true);
    expect(
      edges.some((edge) => edge.source === 'c' && edge.sourceHandle === 'then' && edge.target === 'lp'),
    ).toBe(false);
    expect(
      edges.some((edge) => edge.source === 'c' && edge.sourceHandle === 'then' && edge.target === 'after'),
    ).toBe(false);
  });

  it('循环里可把再循环从「不成立」切回「成立」', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('c', 'cond', { rec: 'x' }),
      s('ce', 'condend', { back: 'c' }),
      s('le', 'loopend', { back: 'lp' }),
      s('after', 'delay', { ms: 1 }),
    ];
    const elseLoops = okSteps(connectSteps(steps, 'c', 'lp', 'else', 'back'));
    const thenLoops = okSteps(connectSteps(elseLoops, 'c', 'lp', 'then', 'back'));
    const edges = buildBranchFlowEdges(thenLoops);
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
      edges.some((edge) => edge.source === 'c' && edge.sourceHandle === 'else' && edge.target === 'lp'),
    ).toBe(false);
  });

  it('循环里从不成立口连回循环：只加一条回线，条件后的模块不再被搬进成立支', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('c', 'cond', { rec: 'x' }),
      s('ce', 'condend', { back: 'c' }),
      s('d', 'delay', { ms: 1 }),
      s('le', 'loopend', { back: 'lp' }),
    ];
    const next = okSteps(connectSteps(steps, 'c', 'lp', 'else', 'back'));
    expect(ids(next)).toEqual(['t', 'lp', 'c', 'ce', 'le', 'd']);
    expect(next.find((step) => step.id === 'c')?.params?._loopRepeat).toBe('else');
    expect(next.find((step) => step.id === 'd')?.params?._pendingLink).toBe(true);
  });

  it('还没接进流程的循环：先接「进入」，再把它接回循环头，循环能正常闭环', () => {
    const steps = [
      s('t', 'manual', { _out: ['out>a'] }),
      s('a', 'click', { _out: [] }),
      s('lp', 'loop', { count: 10, _out: [] }),
      s('le', 'loopend', { back: 'lp', _out: [] }),
      s('d', 'delay', { ms: 1, _pendingLink: true }),
    ];
    const withBody = okSteps(connectSteps(steps, 'lp', 'd', 'body', 'in'));
    // 循环体排进「循环 … 循环结束」之间
    expect(ids(withBody)).toEqual(['t', 'a', 'lp', 'd', 'le']);
    const closed = okSteps(connectSteps(withBody, 'd', 'lp', 'out', 'back'));
    const edges = buildBranchFlowEdges(closed);
    expect(edges.some((edge) => edge.source === 'lp' && edge.target === 'd')).toBe(true);
    expect(edges.some((edge) => edge.source === 'd' && edge.target === 'lp')).toBe(true);
    // 再把循环接进主链
    const linked = okSteps(connectSteps(closed, 'a', 'lp', 'out', 'in'));
    expect(ids(linked)).toEqual(['t', 'a', 'lp', 'd', 'le']);
    expect(linked.find((step) => step.id === 'lp')?.params?._pendingLink).toBeFalsy();
  });

  it('没接上循环体时，直接接回循环头会被拒绝，并说明先连「进入」口', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('a', 'click', { _pendingLink: true }),
      s('le', 'loopend', { back: 'lp' }),
    ];
    const result = connectSteps(steps, 'a', 'lp', 'out', 'back');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('「进入」口');
    }
    // 不要"猜"一条进入线出来：循环体和回线都没有被凭空创建
    const edges = buildBranchFlowEdges(steps);
    expect(edges.some((edge) => edge.source === 'a' && edge.target === 'lp')).toBe(false);
    expect(edges.some((edge) => edge.source === 'lp' && edge.target === 'a')).toBe(false);
  });

  it('断开循环进入后，从进入口再连到循环体模块能接上', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('a', 'click', { _pendingLink: true }),
      s('b', 'click'),
      s('le', 'loopend', { back: 'lp' }),
    ];
    const next = okSteps(connectSteps(steps, 'lp', 'a', 'body', 'in'));
    expect(ids(next)).toEqual(['t', 'lp', 'a', 'b', 'le']);
    expect(next.find((step) => step.id === 'a')?.params?._pendingLink).toBeFalsy();
    expect(
      buildBranchFlowEdges(next).some(
        (edge) => edge.source === 'lp' && edge.sourceHandle === 'body' && edge.target === 'a',
      ),
    ).toBe(true);
  });

  it('循环体连回循环头 = 画一条回线；循环之后仍从「循环」的出口拉线', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('d', 'delay', { ms: 1 }),
      s('le', 'loopend', { back: 'lp' }),
      s('x', 'click', { by: '坐标', x: 0.1, y: 0.1, _pendingLink: true }),
    ];
    const back = okSteps(connectSteps(steps, 'd', 'lp', 'out', 'back'));
    expect(ids(back)).toEqual(['t', 'lp', 'd', 'le', 'x']);
    const backEdges = buildBranchFlowEdges(back).filter(
      (edge) => edge.target === 'lp' && edge.targetHandle === 'back',
    );
    expect(backEdges.map((edge) => edge.source)).toEqual(['d']);
    expect(backEdges[0]?.style?.strokeDasharray).toBe('6 4');
    // 不在循环里的模块不能接回循环头
    expect(connectSteps(steps, 'x', 'lp', 'out', 'back').ok).toBe(false);
    const after = okSteps(connectSteps(steps, 'lp', 'x', 'out'));
    expect(ids(after)).toEqual(['t', 'lp', 'd', 'le', 'x']);
    expect(after.find((step) => step.id === 'x')?.params?._pendingLink).toBeFalsy();
  });

  it('连到块标记会被拒绝，原数组不变', () => {
    const steps = [s('t', 'manual'), s('c', 'cond'), s('ce', 'condend', { back: 'c' }), s('b')];
    const before = JSON.stringify(steps);
    const result = connectSteps(steps, 'b', 'ce', 'out');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('结构标记');
    }
    expect(JSON.stringify(steps)).toBe(before);
  });
});

describe('insertUnitBefore', () => {
  it('插在目标之前；不能插在触发器之前', () => {
    const steps = [s('t', 'manual'), s('a'), s('x', 'delay', { _pendingLink: true })];
    expect(ids(okSteps(insertUnitBefore(steps, 'x', 'a')))).toEqual(['t', 'x', 'a']);
    expect(insertUnitBefore(steps, 'x', 't').ok).toBe(false);
  });
});

describe('removeStepsFromChain', () => {
  it('删条件块 = 成对移除标记与分支', () => {
    const steps = [s('t', 'manual'), s('c', 'cond'), s('inner'), s('ce', 'condend', { back: 'c' })];
    const { steps: next } = removeStepsFromChain(steps, ['c']);
    expect(ids(next)).toEqual(['t', 'inner']);
  });

  it('触发器不能删；删未接入段首会把未接入交给后一个模块', () => {
    const chain = [s('t', 'manual'), s('x', 'delay', { _pendingLink: true }), s('y')];
    expect(ids(removeStepsFromChain(chain, ['t']).steps)).toEqual(['t', 'x', 'y']);
    const { steps: next } = removeStepsFromChain(chain, ['x']);
    expect(ids(next)).toEqual(['t', 'y']);
    expect(next[1]!.params?._pendingLink).toBe(true);
  });
});

describe('removeStepKeepingGap', () => {
  it('删中间模块后下游就地未接入，不会自动接回上游', () => {
    const steps = [s('t', 'manual'), s('a'), s('b'), s('c')];
    const next = okSteps(removeStepKeepingGap(steps, 'b'));
    expect(ids(next)).toEqual(['t', 'a', 'c']);
    expect(next[2]!.params?._pendingLink).toBe(true);
    expect(buildBranchFlowEdges(next).map((edge) => `${edge.source}->${edge.target}`)).toEqual(['t->a']);
  });

  it('删最后一个模块：没有下游可标，等于普通删除', () => {
    const steps = [s('t', 'manual'), s('a'), s('b')];
    const next = okSteps(removeStepKeepingGap(steps, 'b'));
    expect(ids(next)).toEqual(['t', 'a']);
    expect(next[1]!.params?._pendingLink).toBeUndefined();
  });

  it('触发器 / 条件块不能走"保留缺口"删除', () => {
    const steps = [s('t', 'manual'), s('c', 'cond'), s('inner'), s('ce', 'condend', { back: 'c' })];
    expect(removeStepKeepingGap(steps, 't').ok).toBe(false);
    expect(removeStepKeepingGap(steps, 'c').ok).toBe(false);
  });

  it('循环里删中间模块：同块下游变未接入；删块尾不把块外模块标上', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('b'),
      s('c'),
      s('le', 'loopend', { back: 'lp' }),
      s('after'),
    ];
    const cutB = okSteps(removeStepKeepingGap(steps, 'b'));
    expect(cutB.find((step) => step.id === 'c')?.params?._pendingLink).toBe(true);

    const cutC = okSteps(removeStepKeepingGap(steps, 'c'));
    expect(cutC.find((step) => step.id === 'after')?.params?._pendingLink).toBeUndefined();
  });

  it('再循环目标显式指向外层循环时，迁移不会改回内层', () => {
    const steps = [
      s('t', 'manual'),
      s('lp1', 'loop', { count: 2 }),
      s('lp2', 'loop', { count: 3 }),
      s('c', 'cond', { rec: 'x', _loopRepeat: 'else', _loopRepeatLoop: 'lp1' }),
      s('ce', 'condend', { back: 'c' }),
      s('le2', 'loopend', { back: 'lp2' }),
      s('le1', 'loopend', { back: 'lp1' }),
    ];
    expect(migrateFlowSteps(steps).find((step) => step.id === 'c')?.params?._loopRepeatLoop).toBe('lp1');
  });

  it('循环体和条件回口都用流动虚线', () => {
    const steps = [
      s('t', 'manual'),
      s('lp', 'loop', { count: 2 }),
      s('c', 'cond', { rec: 'x', _loopRepeat: 'else' }),
      s('ce', 'condend', { back: 'c' }),
      s('le', 'loopend', { back: 'lp' }),
    ];
    const loopEdges = buildBranchFlowEdges(steps).filter(
      (edge) => edge.sourceHandle === 'body' || edge.targetHandle === 'back',
    );
    expect(loopEdges.length).toBeGreaterThan(0);
    for (const edge of loopEdges) {
      expect(edge.style?.strokeDasharray).toBe('6 4');
      expect(edge.animated).toBe(true);
    }
  });

  it('条件分支里删模块：缺口留在本分支内，不跳到「否则」支或块外', () => {
    const steps = [
      s('t', 'manual'),
      s('c', 'cond'),
      s('yes'),
      s('else', 'else'),
      s('no'),
      s('ce', 'condend', { back: 'c' }),
      s('after'),
    ];
    const cut = okSteps(removeStepKeepingGap(steps, 'yes'));
    expect(cut.find((step) => step.id === 'no')?.params?._pendingLink).toBeUndefined();
    expect(cut.find((step) => step.id === 'after')?.params?._pendingLink).toBeUndefined();
  });
});
