/**
 * 工作区区域的外壳（右栏第一个 Tab 的内容）：**只有一套列表**。
 *
 * 回归：曾经这里是「一棵树 + 一个浮层面板」两份东西，都在列同一批目录（用户原话：
 * "你做了两遍，你不觉得重复么"）。现在整个 Tab 内容就是 `WorkspacePanel`（不是弹框），
 * 所以**同一个工作流只能出现一次** —— 这条断言就是防它再长出第二份列表。
 *
 * 外壳自己只负责：错误行（含"引擎是旧进程 → 重启引擎"）、底部"当前：…"回显。
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceLibraryPane } from '@/features/library/WorkspaceLibraryPane';
import { useEngineStore } from '@/stores/engine.store';
import { useLibraryStore } from '@/stores/library.store';
import { useSessionStore } from '@/stores/session.store';

const { TREE, WORKSPACES } = vi.hoisted(() => {
  const root = '/Users/me/game-bot';
  const TREE = {
    root,
    workflows: [
      { name: '斗技', root: `${root}/斗技`, nodes: 3, edges: 2, recognizers: 4, templates: 5, modified: 0 },
      { name: '御魂', root: `${root}/御魂`, nodes: 5, edges: 4, recognizers: 2, templates: 2, modified: 0 },
    ],
  };
  const WORKSPACES = [{ name: '我的工作区', root, active: true, exists: true }];
  return { TREE, WORKSPACES };
});

vi.mock('@/lib/rpc', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/rpc');
  return {
    ...actual,
    devLog: vi.fn(),
    workspaceTree: vi.fn(() => Promise.resolve(TREE)),
    workspaceList: vi.fn(() =>
      Promise.resolve({
        active: TREE.root,
        recommended: '/repo/workspaces/默认',
        items: WORKSPACES,
      }),
    ),
    projectGet: vi.fn(() => Promise.resolve({ root: `${TREE.root}/斗技` })),
  };
});

const CURRENT = `${TREE.root}/斗技`;

describe('工作区区域（右栏 Tab 内容）', () => {
  beforeEach(() => {
    useLibraryStore.setState({
      workspaceRoot: TREE.root,
      workflows: TREE.workflows,
      workspaces: WORKSPACES,
      recommendedWorkspace: '/repo/workspaces/默认',
      error: null,
    });
    useSessionStore.setState({ currentWorkflow: { root: CURRENT } as never, error: null });
    useEngineStore.setState({ status: 'ready', missingMethods: [] });
  });

  it('引擎读不到时给出可重试的错误行，而不是空白区域', () => {
    useLibraryStore.setState({ workflows: [], error: '引擎未启动' });
    render(<WorkspaceLibraryPane />);

    expect(screen.getByText(/读不到工作区：引擎未启动/)).toBeInTheDocument();
    expect(screen.getByText('重试')).toBeInTheDocument();
  });

  it('引擎是旧进程（方法表缺新方法）时，错误行给出「重启引擎」这条出路', () => {
    useLibraryStore.setState({ workflows: [], error: '引擎返回错误: 未知方法: workflow.create' });
    useEngineStore.setState({ status: 'ready', missingMethods: ['workflow.create'] });
    render(<WorkspaceLibraryPane />);

    expect(screen.getByText('重启引擎')).toBeInTheDocument();
  });

  it('只有一套列表：同一个工作流只出现一次，且区域就是 Tab 的本体（不是浮层）', async () => {
    render(<WorkspaceLibraryPane />);

    // 区域常驻：没有 role=dialog、没有遮罩
    expect(await screen.findByTestId('workspace-region')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-panel-backdrop')).not.toBeInTheDocument();

    // 回归重点：以前树 + 面板各渲染一遍 → 同一个名字会出现两次
    expect(await screen.findByText('斗技')).toBeInTheDocument();
    expect(screen.getAllByText('斗技')).toHaveLength(1);
    expect(screen.getAllByText('御魂')).toHaveLength(1);
    expect(screen.getAllByTestId('workspace-workflow-row')).toHaveLength(TREE.workflows.length);

    // 外壳只剩：错误行 + 区域 + 底部"当前：…"（原来那排"刷新/几个工作流"按钮已经删掉）
    expect(screen.getByText(/当前工作流：/)).toBeInTheDocument();
    expect(screen.getByText(CURRENT)).toBeInTheDocument();
    expect(screen.queryByText('刷新')).not.toBeInTheDocument();
  });
});
