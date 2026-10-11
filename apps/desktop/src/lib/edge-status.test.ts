/**
 * 边的实时状态：调试时"为什么不动"全靠它，逻辑必须和引擎的 _guard_ok 一致。
 */
import { describe, expect, it } from 'vitest';

import { conditionConflicts, evaluateEdge, markShadowed, type DetectionLike } from '@/lib/edge-status';
import type { EdgeCondition, GraphEdgeView } from '@/types';

const base: EdgeCondition = { allOf: ['icon'], anyOf: [], noneOf: [], minScore: 0, withinMs: 0 };

function edge(partial: Partial<GraphEdgeView> = {}): GraphEdgeView {
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
    action: 'click',
    condition: base,
    actionSpec: { type: 'click', x: 0.5, y: 0.5 },
    ...partial,
  };
}

const confirmed = (label: string, score = 0.95): DetectionLike => ({ label, score, state: 'confirmed' });

describe('边能不能走', () => {
  it('识别器命中且条件成立 → matched', () => {
    expect(evaluateEdge(edge(), [confirmed('icon')], 'launcher').kind).toBe('matched');
  });

  it('识别器没命中 → waiting，并说清还差哪个', () => {
    const status = evaluateEdge(edge(), [], 'launcher');
    expect(status.kind).toBe('waiting');
    expect(status.reason).toContain('icon');
  });

  it('投票中（pending）不算命中', () => {
    const status = evaluateEdge(edge(), [{ label: 'icon', score: 0.9, state: 'pending' }], 'launcher');
    expect(status.kind).toBe('waiting');
  });

  it('none_of 出现 → blocked（"有弹窗时不走"）', () => {
    const item = edge({ condition: { ...base, noneOf: ['popup'] } });
    const status = evaluateEdge(item, [confirmed('icon'), confirmed('popup')], 'launcher');
    expect(status.kind).toBe('blocked');
    expect(status.reason).toContain('popup');
  });

  it('分数不够 → waiting，并给出实际分数', () => {
    const item = edge({ condition: { ...base, minScore: 0.9 } });
    const status = evaluateEdge(item, [confirmed('icon', 0.6)], 'launcher');
    expect(status.kind).toBe('waiting');
    expect(status.reason).toContain('0.60');
  });

  it('不在当前界面的出口上 → waiting 并说明原因', () => {
    const status = evaluateEdge(edge(), [confirmed('icon')], 'dialer');
    expect(status.kind).toBe('waiting');
    expect(status.reason).toContain('launcher');
  });

  it('无条件边 → matched', () => {
    const item = edge({ condition: { ...base, allOf: [], always: true } });
    expect(evaluateEdge(item, [], 'launcher').kind).toBe('matched');
  });

  it('any_of 任一命中即可', () => {
    const item = edge({ condition: { ...base, allOf: [], anyOf: ['a', 'b'] } });
    expect(evaluateEdge(item, [confirmed('b')], 'launcher').kind).toBe('matched');
    expect(evaluateEdge(item, [confirmed('c')], 'launcher').kind).toBe('waiting');
  });
});

describe('优先级遮挡', () => {
  it('同一界面里优先级低的 matched 会被标成"这一轮不会走"', () => {
    const high = edge({ id: 'high', priority: 10 });
    const low = edge({ id: 'low', priority: 0 });
    const statuses = {
      get: (id: string) =>
        id === 'low' ? { kind: 'matched' as const, reason: '' } : { kind: 'matched' as const, reason: '' },
    };
    const marked = markShadowed(
      [high, low],
      new Map([
        ['high', statuses.get('high')],
        ['low', statuses.get('low')],
      ]),
    );
    expect(marked.get('high')?.kind).toBe('matched');
    expect(marked.get('low')?.reason).toContain('优先级');
  });
});

describe('条件自相矛盾（conditionConflicts）', () => {
  it('同一个识别器既在「或」又在「非」：永远不会触发，要点出来', () => {
    // 实测遇到过的一条边：any_of=[相机] + none_of=[相机]
    const found = conditionConflicts({ ...base, allOf: [], anyOf: ['相机'], noneOf: ['相机'] });

    expect(found).toEqual(['相机']);
  });

  it('「且」和「非」撞上也算（all_of 要求出现，none_of 要求不出现）', () => {
    expect(conditionConflicts({ ...base, allOf: ['icon', 'start'], noneOf: ['start'] })).toEqual(['start']);
  });

  it('不同标签各管各的：不报', () => {
    expect(conditionConflicts({ ...base, allOf: ['icon'], anyOf: ['start'], noneOf: ['popup'] })).toEqual([]);
  });

  it('重复出现在两边也只报一次', () => {
    expect(conditionConflicts({ ...base, allOf: ['x'], anyOf: ['x'], noneOf: ['x'] })).toEqual(['x']);
  });

  it('无条件边（always）没有矛盾可说', () => {
    expect(conditionConflicts({ ...base, allOf: [], anyOf: [], noneOf: [], always: true })).toEqual([]);
  });
});
