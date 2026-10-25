/**
 * 中间开始页：没有打开的工作流时，它替代原来的三行灰字。
 *
 * 参照 IDE 欢迎页：三张卡 + 「最近」「历史」。**没有 SSH** —— 这是本机工作台。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphStartPage } from '@/features/graph/GraphStartPage';
import type * as WorkflowIo from '@/features/library/workflow-io';
import { useLibraryStore } from '@/stores/library.store';
import { useUiStore } from '@/stores/ui.store';

const pickDirectoryResult = vi.fn(
  (): Promise<
    { kind: 'cancelled' } | { kind: 'unavailable'; reason: string } | { kind: 'picked'; path: string }
  > => Promise.resolve({ kind: 'cancelled' }),
);
const pickWorkflowJsonFileNamed = vi.fn((): Promise<{ name: string; text: string } | null> =>
  Promise.resolve(null),
);

vi.mock('@/features/library/native-dialog', () => ({
  pickDirectoryResult: () => pickDirectoryResult(),
}));
vi.mock('@/features/library/workflow-io', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkflowIo>();
  return { ...actual, pickWorkflowJsonFileNamed: () => pickWorkflowJsonFileNamed() };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const WS = 'S:\\game\\games';

describe('中间开始页', () => {
  beforeEach(() => {
    pickDirectoryResult.mockReset();
    pickDirectoryResult.mockResolvedValue({ kind: 'cancelled' });
    pickWorkflowJsonFileNamed.mockReset();
    pickWorkflowJsonFileNamed.mockResolvedValue(null);

    useLibraryStore.setState({
      workspaceRoot: WS,
      workspaces: [{ name: 'games', root: WS, active: true, exists: true }],
      workflows: [],
      error: null,
    });
    useUiStore.setState({ workflowHistory: [] });
  });

  it('三张卡 + 最近 + 历史，且没有 SSH', () => {
    render(<GraphStartPage onOpen={vi.fn()} />);

    expect(screen.getByText('打开工作区')).toBeInTheDocument();
    expect(screen.getByText('新建工作流')).toBeInTheDocument();
    expect(screen.getByText('导入工作流')).toBeInTheDocument();
    expect(screen.getByText('最近')).toBeInTheDocument();
    expect(screen.getByText('历史')).toBeInTheDocument();
    expect(screen.queryByText(/SSH/i)).not.toBeInTheDocument();
  });

  it('最近列出登记过的工作区；点当前工作区里的行会打开它的工作流', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    useLibraryStore.setState({
      workflows: [
        { name: '挑战', root: `${WS}\\挑战`, nodes: 1, edges: 0, recognizers: 1, templates: 1, modified: 10 },
      ],
    });
    render(<GraphStartPage onOpen={onOpen} />);

    expect(screen.getByText('games')).toBeInTheDocument();
    await user.click(screen.getByText('games'));
    expect(onOpen).toHaveBeenCalledWith(`${WS}\\挑战`);
  });

  it('历史里的条目点一下就打开（同一工作区内不重复登记）', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    useUiStore.setState({ workflowHistory: [{ root: `${WS}\\挑战`, at: Date.now() }] });
    render(<GraphStartPage onOpen={onOpen} />);

    await user.click(screen.getByText('挑战'));
    expect(onOpen).toHaveBeenCalledWith(`${WS}\\挑战`);
  });

  it('导入 graph.json：先选文件，再起名，最后建工作流并写图', async () => {
    const user = userEvent.setup();
    const importWorkflow = vi.fn((_name: string, _graph: unknown) => Promise.resolve(true));
    useLibraryStore.setState({ importWorkflow });
    pickWorkflowJsonFileNamed.mockResolvedValue({
      name: '斗技.json',
      text: JSON.stringify({ version: 1, nodes: [], edges: [], recognizers: {}, flow: { steps: [] } }),
    });
    render(<GraphStartPage onOpen={vi.fn()} />);

    await user.click(screen.getByText('导入工作流'));
    const input = await screen.findByPlaceholderText('例如 斗技');
    expect(input).toHaveValue('斗技');

    await user.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(() => expect(importWorkflow).toHaveBeenCalledTimes(1));
    expect(importWorkflow.mock.calls[0]?.[0]).toBe('斗技');
  });

  it('用户取消文件夹选择器：不显示"选择器不可用"的假故障', async () => {
    const user = userEvent.setup();
    render(<GraphStartPage onOpen={vi.fn()} />);

    await user.click(screen.getByText('打开工作区'));
    expect(pickDirectoryResult).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText(/没有弹出文件夹选择器/)).not.toBeInTheDocument());
  });

  it('文件夹选择器真的不可用：原地给出绝对路径输入框（不是静默失败）', async () => {
    const user = userEvent.setup();
    const addWorkspace = vi.fn(() => Promise.resolve(true));
    useLibraryStore.setState({ addWorkspace });
    pickDirectoryResult.mockResolvedValue({ kind: 'unavailable', reason: 'dialog:allow-open 被拒' });
    render(<GraphStartPage onOpen={vi.fn()} />);

    await user.click(screen.getByText('打开工作区'));
    await screen.findByText(/dialog:allow-open 被拒/);

    await user.type(screen.getByPlaceholderText(/粘贴工作区绝对路径/), 'S:\\game\\other');
    await user.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(addWorkspace).toHaveBeenCalledWith('S:\\game\\other'));
  });
});
