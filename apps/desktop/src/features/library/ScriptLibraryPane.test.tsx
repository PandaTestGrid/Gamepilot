/**
 * 脚本库面板：多张状态图的列表 / 新建 / 切图。
 *
 * 面板只做两件事：把 store 里的列表画出来、把用户动作转成 store 调用。
 * 所以测试里直接给 store 塞数据、spy 掉动作，不去碰磁盘（磁盘那侧由引擎测试覆盖）。
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScriptLibraryPane } from '@/features/library/ScriptLibraryPane';
import { scriptNameError } from '@/features/library/script-name';
import type { ProjectSummary } from '@/lib/rpc';
import { useLibraryStore } from '@/stores/library.store';
import { useSessionStore } from '@/stores/session.store';

const SCRIPTS: ProjectSummary[] = [
  { name: 'default', root: '/tmp/projects/default', nodes: 3, edges: 2, recognizers: 4, templates: 4 },
  { name: '日常任务', root: '/tmp/projects/日常任务', nodes: 1, edges: 0, recognizers: 1, templates: 1 },
];

describe('脚本名规则（与引擎同一套）', () => {
  it('拦掉空名、非法字符、首尾点、超长', () => {
    expect(scriptNameError('  ')).toBe('名字不能为空');
    expect(scriptNameError('日常/任务')).toContain('不能包含');
    expect(scriptNameError('.hidden')).toContain('不能以点');
    expect(scriptNameError('副本.')).toContain('不能以点');
    expect(scriptNameError('x'.repeat(65))).toContain('最长');
  });

  it('中文、空格、短横线都是合法名字（游戏脚本常见）', () => {
    expect(scriptNameError('日常任务')).toBeNull();
    expect(scriptNameError('刷副本 - 早上')).toBeNull();
  });
});

describe('脚本库面板', () => {
  beforeEach(() => {
    useLibraryStore.setState({ items: SCRIPTS, loading: false, error: null });
    useSessionStore.setState({ project: { root: SCRIPTS[0]!.root } as never, error: null });
  });

  it('引擎读不到时给出可重试的错误行，而不是空白面板', () => {
    useLibraryStore.setState({ items: [], error: '引擎未启动' });
    render(<ScriptLibraryPane />);

    expect(screen.getByText(/读不到脚本库：引擎未启动/)).toBeInTheDocument();
    expect(screen.getByText('重试')).toBeInTheDocument();
  });
});
