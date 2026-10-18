import { describe, expect, it } from 'vitest';

import { parseWorkflowJson } from '@/features/library/workflow-io';

describe('workflow-io', () => {
  it('parseWorkflowJson 接受带 flow 的导出', () => {
    const payload = parseWorkflowJson(
      JSON.stringify({ version: 1, nodes: [], edges: [], recognizers: {}, flow: { steps: [] } }),
    );
    expect(payload.flow?.steps).toEqual([]);
  });

  it('坏 JSON 报错', () => {
    expect(() => parseWorkflowJson('{')).toThrow();
  });
});
