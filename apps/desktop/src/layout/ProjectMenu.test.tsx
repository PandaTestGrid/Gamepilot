/**
 * 顶栏「工作流」菜单（v4：工作区 › 工作流，只有两层）。
 *
 * 覆盖两件事（原来在树组件的测试里，树删掉之后入口挪到了这个菜单）：
 * 1. 列**当前工作区**里的工作流，点一条 = 切过去；
 * 2. 「＋ 新建工作流」是**弹输入框、输名字才建**（v4 明确不许"点一下直接建"，
 *    而且绝不用浏览器原生 prompt —— Tauri 里弹不出来）。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectMenu } from '@/layout/ProjectMenu';
import { workflowCreate, workspaceTree } from '@/lib/rpc';
import { useSessionStore } from '@/stores/session.store';

const { WS, CURRENT, WORKFLOWS } = vi.hoisted(() => {
  const WS = '/Users/me/game-bot';
  const CURRENT = `${WS}/斗技`;
  return {
    WS,
    CURRENT,
    WORKFLOWS: [
      {
        name: '斗技',
        root: CURRENT,
        nodes: 3,
        edges: 2,
        recognizers: 4,
        templates: 5,
        modified: 1_760_000_000,
      },
      { name: '御魂', root: `${WS}/御魂`, nodes: 5, edges: 4, recognizers: 2, templates: 2, modified: 0 },
    ],
  };
});

vi.mock('@/lib/rpc', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/rpc');
  return {
    ...actual,
    devLog: vi.fn(),
    workspaceTree: vi.fn(() => Promise.resolve({ root: WS, workflows: WORKFLOWS })),
    workflowCreate: vi.fn(() =>
      Promise.resolve({ created: `${WS}/签到`, current: CURRENT, items: WORKFLOWS }),
    ),
    projectGet: vi.fn(() =>
      Promise.resolve({ root: CURRENT, graphPath: '', nodes: 3, edges: 2, recognizers: 4, templates: 5 }),
    ),
  };
});

const switchProject = vi.fn((): Promise<void> => Promise.resolve());

describe('顶栏工作流菜单', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      project: {
        root: CURRENT,
        graphPath: '',
        nodes: 3,
        edges: 2,
        recognizers: 4,
        templates: 5,
      },
      error: null,
      switchProject,
    } as never);
  });

  it('打开菜单：列当前工作区里的工作流（点一条切过去），不列别的层级的名字', async () => {
    const user = userEvent.setup();
    render(<ProjectMenu />);

    await user.click(screen.getByTitle(/工作流目录/));

    expect(
      await screen.findByText('切工作流（一个工作流 = 一张流程图：graph.json + templates/）'),
    ).toBeInTheDocument();
    // 「斗技」出现两次：顶栏按钮上的当前工作流名 + 列表里那一行
    expect(screen.getAllByText('斗技')).toHaveLength(2);
    expect(screen.getByText('御魂')).toBeInTheDocument();
    // v4 只有两层：菜单里不该出现「项目」当层级名
    expect(screen.queryByText('项目')).not.toBeInTheDocument();
    expect(workspaceTree).toHaveBeenCalled();

    await user.click(screen.getByText('御魂'));
    expect(switchProject).toHaveBeenCalledWith(`${WS}/御魂`);
  });

  it('「＋ 新建工作流」：弹输入框、输名字才建（不用原生 prompt）', async () => {
    const prompt = vi.fn();
    vi.stubGlobal('prompt', prompt);
    const user = userEvent.setup();
    render(<ProjectMenu />);

    await user.click(screen.getByTitle(/工作流目录/));
    await user.click(screen.getByText('＋ 新建工作流'));

    // 表单出现，但**还没建**；空名字提交不动
    const input = await screen.findByPlaceholderText(/例如/);
    expect(workflowCreate).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();

    await user.type(input, '签到');
    await user.click(screen.getByRole('button', { name: '创建' }));

    expect(workflowCreate).toHaveBeenCalledWith('签到');
    expect(prompt).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
