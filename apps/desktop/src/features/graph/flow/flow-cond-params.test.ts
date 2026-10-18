import { describe, expect, it } from 'vitest';

import {
  condGroupsFromParams,
  condMatchTimeoutMs,
  condModeFromParams,
  condParamsFromGroups,
  condRecognizerLabels,
  condSummaryFromParams,
  DEFAULT_COND_MATCH_MS,
  sanitizeCondParamsForSave,
} from '@/features/graph/flow/flow-cond-params';

describe('flow-cond-params', () => {
  it('匹配时间默认 100ms', () => {
    expect(DEFAULT_COND_MATCH_MS).toBe(100);
    expect(condMatchTimeoutMs({})).toBe(100);
    expect(condMatchTimeoutMs({ timeout_ms: 0 })).toBe(0);
    expect(condMatchTimeoutMs({ timeout_ms: 250 })).toBe(250);
  });

  it('legacy rec → 单组', () => {
    expect(condGroupsFromParams({ rec: '弹窗' })).toEqual([{ all: ['弹窗'] }]);
  });

  it('groups 且/或 往返', () => {
    const params = condParamsFromGroups([{ all: ['a', 'b'] }, { all: ['c'] }]);
    expect(params.groups).toEqual([{ all: ['a', 'b'] }, { all: ['c'] }]);
    expect(params.rec).toBe('a');
    expect(condSummaryFromParams(params)).toBe('a 且 b 或 c');
    expect(condRecognizerLabels(params).sort()).toEqual(['a', 'b', 'c']);
  });

  it('添加「且」占位空行会保留在 groups 里，且落盘时不会被 sanitizeCondParamsForSave 抹掉', () => {
    const params = condParamsFromGroups([{ all: ['a', ''] }], 'all');
    expect(params.groups).toEqual([{ all: ['a', ''] }]);
    expect(params.mode).toBe('all');
    expect(condGroupsFromParams(params)[0]?.all).toEqual(['a', '']);

    const saved = sanitizeCondParamsForSave(params);
    expect(saved.groups).toEqual([{ all: ['a', ''] }]);
    expect(saved.mode).toBe('all');
    expect(condModeFromParams(saved)).toBe('all');
    expect(condGroupsFromParams(saved)[0]?.all).toEqual(['a', '']);
  });

  it('切换到「或」但尚未选第二张图时，落盘后仍保留「或」模式与两个槽位', () => {
    const params = condParamsFromGroups([{ all: ['a'] }, { all: [''] }], 'any');
    const saved = sanitizeCondParamsForSave(params);
    expect(saved.mode).toBe('any');
    expect(saved.groups).toEqual([{ all: ['a'] }, { all: [''] }]);
    expect(condModeFromParams(saved)).toBe('any');
    expect(condGroupsFromParams(saved)).toEqual([{ all: ['a'] }, { all: [''] }]);
  });
});
