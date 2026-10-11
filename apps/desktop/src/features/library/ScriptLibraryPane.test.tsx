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

  it('列出库里每个脚本，并标出当前正在用的那张图', () => {
    render(<ScriptLibraryPane />);

    expect(screen.getByText('default')).toBeInTheDocument();
    expect(screen.getByText('日常任务')).toBeInTheDocument();
    expect(screen.getByText('2 个脚本')).toBeInTheDocument();
    // 当前脚本那一行的切换按钮是禁用的（点了也没意义）
    const currentRow = screen.getByText('default').closest('button');
    expect(currentRow).toBeDisabled();
    expect(screen.getByText('3 界面 · 2 步 · 4 识别器')).toBeInTheDocument();
  });

  it('点另一个脚本 = 切图（走 session store 的 switchProject，会热重载设备状态图）', async () => {
    const user = userEvent.setup();
    const switchProject = vi.fn(() => Promise.resolve());
    useSessionStore.setState({ switchProject });
    render(<ScriptLibraryPane />);

    await user.click(screen.getByText('日常任务'));

    expect(switchProject).toHaveBeenCalledWith('/tmp/projects/日常任务');
  });

  it('「新建」打开内联表单；名字非法时提交按钮禁用并给出原因', async () => {
    const user = userEvent.setup();
    const create = vi.fn(() => Promise.resolve(true));
    useLibraryStore.setState({ create });
    render(<ScriptLibraryPane />);

    await user.click(screen.getByText('新建'));
    expect(screen.getByText(/新建脚本/)).toBeInTheDocument();

    const input = screen.getByPlaceholderText('例如 日常任务');
    await user.type(input, '副本/1');
    expect(screen.getByText(/不能包含/)).toBeInTheDocument();
    expect(screen.getByText('创建并切换')).toBeDisabled();

    await user.clear(input);
    await user.type(input, '刷副本');
    await user.click(screen.getByText('创建并切换'));
    expect(create).toHaveBeenCalledWith('刷副本');
  });

  it('重命名：表单带上原名，提交走 rename', async () => {
    const user = userEvent.setup();
    const rename = vi.fn(() => Promise.resolve(true));
    useLibraryStore.setState({ rename });
    render(<ScriptLibraryPane />);

    const row = screen.getByText('日常任务').closest('div');
    await user.click(within(row as HTMLElement).getByTitle('重命名'));

    expect(screen.getByText('重命名「日常任务」')).toBeInTheDocument();
    const input = screen.getByDisplayValue('日常任务');
    await user.clear(input);
    await user.type(input, '日常任务-2');
    await user.click(screen.getByText('重命名'));

    expect(rename).toHaveBeenCalledWith('/tmp/projects/日常任务', '日常任务-2');
  });

  it('引擎读不到时给出可重试的错误行，而不是空白面板', () => {
    useLibraryStore.setState({ items: [], error: '引擎未启动' });
    render(<ScriptLibraryPane />);

    expect(screen.getByText(/读不到脚本库：引擎未启动/)).toBeInTheDocument();
    expect(screen.getByText('重试')).toBeInTheDocument();
  });
});
