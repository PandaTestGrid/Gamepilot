/**
 * 右栏「工作区 › 项目 › 状态图」树的交互（补上之前删掉旧用例欠下的覆盖）。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceTree } from '@/features/library/WorkspaceTree';
import { projectCreate, workspaceTree } from '@/lib/rpc';
import { useSessionStore } from '@/stores/session.store';

const switchProject = vi.fn(() => Promise.resolve());

vi.mock('@/lib/rpc', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/rpc');
  return {
    ...actual,
    devLog: vi.fn(),
    workspaceTree: vi.fn(),
    projectCreate: vi.fn(() => Promise.resolve({})),
    workspaceCreate: vi.fn(() => Promise.resolve({})),
    workspaceMkdir: vi.fn(() => Promise.resolve({})),
  };
});

const TREE = {
  projects: [
    {
      name: '默认',
      root: '/p',
      workspaces: [
        {
          name: '阴阳师',
          root: '/p/阴阳师',
          tasks: [
            { name: '斗技', root: '/p/阴阳师/斗技', nodes: 1, edges: 0, recognizers: 1 },
            { name: '百鬼', root: '/p/阴阳师/百鬼', nodes: 0, edges: 0, recognizers: 0 },
          ],
        },
      ],
    },
  ],
};

describe('工作区树', () => {
  beforeEach(() => {
    vi.mocked(workspaceTree).mockResolvedValue(TREE);
    vi.mocked(projectCreate).mockClear();
    switchProject.mockClear();
    useSessionStore.setState({
      project: { root: '/p/阴阳师/斗技', graphPath: '', templates: 0, nodes: 1, edges: 0, recognizers: 1 },
      switchProject,
    } as never);
  });

  it('展开时能看到项目下的两张状态图；点项目行收起后消失', async () => {
    const user = userEvent.setup();
    render(<WorkspaceTree />);
    expect(await screen.findByText('斗技')).toBeInTheDocument();
    expect(screen.getByText('百鬼')).toBeInTheDocument();

    await user.click(screen.getByText('阴阳师'));
    expect(screen.queryByText('斗技')).not.toBeInTheDocument();
  });

  it('点状态图 = 切过去（走 switchProject）', async () => {
    const user = userEvent.setup();
    render(<WorkspaceTree />);
    await user.click(await screen.findByText('百鬼'));
    expect(switchProject).toHaveBeenCalledWith('/p/阴阳师/百鬼');
  });

  it('「＋状态图」弹内联表单（不是 window.prompt），提交后建在当前项目目录下', async () => {
    const user = userEvent.setup();
    render(<WorkspaceTree />);
    await user.click(await screen.findByTitle('在这个项目下新建状态图'));

    // 内联表单出现（Tauri 的 webview 不支持 window.prompt，所以绝不能用它）
    const input = await screen.findByPlaceholderText(/例如/);
    await user.type(input, '新图');
    await user.click(screen.getByRole('button', { name: /创建/ }));

    expect(projectCreate).toHaveBeenCalledWith('新图', '/p/阴阳师');
  });

  it('目录树为空时不崩（渲染空壳）', async () => {
    vi.mocked(workspaceTree).mockResolvedValue({ projects: [] });
    const { container } = render(<WorkspaceTree />);
    expect(await screen.findByText('工作区')).toBeInTheDocument();
    expect(container.textContent).not.toContain('阴阳师');
  });
});
