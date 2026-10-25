import { describe, expect, it } from 'vitest';

import { parseWorkflowJson, suggestedWorkflowName } from '@/features/library/workflow-io';

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

  it('导入时用文件名预填工作流名（去掉扩展名与目录）', () => {
    expect(suggestedWorkflowName('斗技.json')).toBe('斗技');
    expect(suggestedWorkflowName('C:\\games\\御魂.JSON')).toBe('御魂');
    expect(suggestedWorkflowName('.json')).toBe('导入的工作流');
  });
});
