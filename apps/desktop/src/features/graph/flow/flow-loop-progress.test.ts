import { describe, expect, it } from 'vitest';

import { flowLoopRunningTitle, loopProgressMapFromExtra } from '@/features/graph/flow/flow-loop-progress';

describe('loopProgressMapFromExtra', () => {
  it('把引擎 extra.loops 收成 stepId → current/total', () => {
    expect(
      loopProgressMapFromExtra({
        loops: [
          { stepId: 'lp', current: 2, total: 12 },
          { stepId: 'inner', current: 1, total: 4 },
        ],
      }),
    ).toEqual({
      lp: { current: 2, total: 12 },
      inner: { current: 1, total: 4 },
    });
  });

  it('没有 loops 字段时不改进度（旧引擎）', () => {
    expect(loopProgressMapFromExtra(undefined)).toBeNull();
    expect(loopProgressMapFromExtra({})).toBeNull();
  });

  it('空数组表示循环栈已清空', () => {
    expect(loopProgressMapFromExtra({ loops: [] })).toEqual({});
  });
});

describe('flowLoopRunningTitle', () => {
  it('执行中显示 2 / 12', () => {
    expect(flowLoopRunningTitle({ current: 2, total: 12 })).toBe('循环 · 2 / 12');
  });
});
