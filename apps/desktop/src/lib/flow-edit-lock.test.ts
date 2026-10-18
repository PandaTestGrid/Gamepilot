import { describe, expect, it } from 'vitest';

import { isWorkflowLive } from '@/lib/flow-edit-lock';

describe('isWorkflowLive', () => {
  it('任意设备在跑这份工作流就算 live', () => {
    expect(isWorkflowLive('/p/甲/斗技', { 'dev-1': ['/p/甲/斗技'] })).toBe(true);
    expect(isWorkflowLive('/p/甲/斗技', { 'dev-1': ['/p/甲/其他'] })).toBe(false);
    expect(isWorkflowLive('', { 'dev-1': ['/p/甲/斗技'] })).toBe(false);
  });
});
