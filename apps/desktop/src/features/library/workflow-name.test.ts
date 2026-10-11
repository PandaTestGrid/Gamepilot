/**
 * 工作流名规则（与引擎 `library.validate_name` 同一套）。
 *
 * 前端先拦一道只是"少一次往返"；引擎仍是最终裁判，所以规则必须完全一致：
 * 1~64 字符、禁 `/ \ : * ? " < > |`、不以 `.` 开头/结尾。
 */
import { describe, expect, it } from 'vitest';

import { WORKFLOW_NAME_MAX, workflowNameError } from '@/features/library/workflow-name';

describe('工作流名规则（与引擎同一套）', () => {
  it('拦掉空名、非法字符、首尾点、超长', () => {
    expect(workflowNameError('  ')).toBe('名字不能为空');
    expect(workflowNameError('日常/任务')).toContain('不能包含');
    expect(workflowNameError('.hidden')).toContain('不能以点');
    expect(workflowNameError('副本.')).toContain('不能以点');
    expect(workflowNameError('x'.repeat(WORKFLOW_NAME_MAX + 1))).toContain('最长');
  });

  it('中文、空格、短横线都是合法名字（游戏工作流常见）', () => {
    expect(workflowNameError('斗技')).toBeNull();
    expect(workflowNameError('刷副本 - 早上')).toBeNull();
    expect(workflowNameError('x'.repeat(WORKFLOW_NAME_MAX))).toBeNull();
  });
});
