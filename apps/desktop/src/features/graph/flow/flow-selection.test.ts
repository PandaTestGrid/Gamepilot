import { describe, expect, it } from 'vitest';

import {
  SELECTION_OPTIONS,
  selectionIndex,
  selectionPatch,
  selectionStrategy,
  selectionSummary,
} from '@/features/graph/flow/flow-selection';

describe('flow-selection', () => {
  it('默认是 auto，未知值也退回 auto', () => {
    expect(selectionStrategy(undefined)).toBe('auto');
    expect(selectionStrategy('')).toBe('auto');
    expect(selectionStrategy('closest')).toBe('auto');
    expect(selectionStrategy('ALL')).toBe('all');
  });

  it('11 种策略都能从界面选到（与引擎 selection.py 同口径）', () => {
    expect(SELECTION_OPTIONS.map((item) => item.id)).toEqual([
      'auto',
      'nearest',
      'first',
      'last',
      'nth',
      'leftmost',
      'rightmost',
      'topmost',
      'bottommost',
      'random',
      'all',
    ]);
  });

  it('切回 auto 会删掉 index，避免旧值残留', () => {
    expect(selectionPatch('auto', 3)).toEqual({ strategy: undefined, index: undefined });
    expect(selectionPatch('nearest')).toEqual({ strategy: 'nearest', index: undefined });
    expect(selectionPatch('nth', 4)).toEqual({ strategy: 'nth', index: 4 });
    expect(selectionPatch('nth', 0)).toEqual({ strategy: 'nth', index: 1 });
  });

  it('index 非法时回到 1', () => {
    expect(selectionIndex(undefined)).toBe(1);
    expect(selectionIndex('3')).toBe(3);
    expect(selectionIndex(-2)).toBe(1);
    expect(selectionIndex('abc')).toBe(1);
  });

  it('节点标题上的摘要', () => {
    expect(selectionSummary('auto')).toBe('');
    expect(selectionSummary('nearest')).toBe('最近');
    expect(selectionSummary('nth', 2)).toBe('第 2 个');
    expect(selectionSummary('all')).toBe('全部');
  });
});
