import { describe, expect, it } from 'vitest';

import { wrapSelectionInLoop, wrapSelectionInLoopReason } from '@/features/graph/flow/flow-wrap-loop';
import type { FlowStep } from '@/types';

const s = (id: string, type = 'delay', params: Record<string, unknown> = {}): FlowStep => ({
  id,
  type,
  params,
});

describe('wrapSelectionInLoop', () => {
  it('连续选中中间几步 → 外包 loop + loopend', () => {
    const steps = [s('t', 'manual'), s('a'), s('b'), s('c')];
    const result = wrapSelectionInLoop(steps, ['a', 'b'], 3);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.steps.map((step) => step.type)).toEqual([
      'manual',
      'loop',
      'delay',
      'delay',
      'loopend',
      'delay',
    ]);
    expect(result.steps[1]!.params?.count).toBe(3);
    expect(result.steps[4]!.params?.back).toBe(result.steps[1]!.id);
  });

  it('非连续多选拒绝', () => {
    const steps = [s('t', 'manual'), s('a'), s('b'), s('c')];
    expect(wrapSelectionInLoopReason(steps, ['a', 'c'])).toMatch(/连续/);
  });

  it('不能把触发器套进去', () => {
    const steps = [s('t', 'manual'), s('a')];
    expect(wrapSelectionInLoopReason(steps, ['t'])).toMatch(/触发器/);
  });
});
