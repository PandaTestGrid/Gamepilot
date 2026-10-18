import { describe, expect, it } from 'vitest';

import { FLOW_MODULE_GROUPS } from '@/features/graph/flow/flow-step-meta';

describe('FLOW_MODULE_GROUPS', () => {
  it('流程分组里循环与跳出循环相邻，双列时同一行', () => {
    const flow = FLOW_MODULE_GROUPS.find((group) => group.label === '流程');
    const types = flow?.items.map((item) => item.type) ?? [];
    const loopAt = types.indexOf('loop');
    expect(loopAt).toBeGreaterThanOrEqual(0);
    expect(loopAt % 2).toBe(0);
    expect(types[loopAt + 1]).toBe('loopbreak');
  });
});
