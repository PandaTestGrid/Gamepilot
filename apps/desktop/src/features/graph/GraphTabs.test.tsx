/**
 * 中间的 IDE 式标签条：点一个开一个、✕ 关掉、关掉当前那个接相邻那个。
 *
 * 这里只管"标签条 → 会话层"这条链路（切目录由 `switchProject` 负责，它自己那套有测试）。
 * 关标签**不删文件**，所以任何一个用例都不该出现删除类调用。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphTabs } from '@/features/graph/GraphTabs';
import { GraphPane } from '@/features/graph/GraphPane';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { ProjectInfo } from '@/lib/rpc';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

// 画布本身在 graph-selection.test.tsx 里测；这里只要 GraphPane 能渲染出"头 + 空态"
vi.mock('@xyflow/react', () => ({
  ReactFlow: () => null,
  MiniMap: () => null,
  Controls: () => null,
  Background: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  MarkerType: { ArrowClosed: 'arrowclosed' },
  ConnectionMode: { Strict: 'strict', Loose: 'loose' },
  BackgroundVariant: { Dots: 'dots' },
  useNodesState: (initial: unknown[]) => [initial, () => undefined, () => undefined],
}));

const A = '/p/甲/斗技';
const B = '/p/甲/百鬼';
const C = '/p/乙/排位';

function project(root: string): ProjectInfo {
  return { root, graphPath: `${root}/graph.json`, nodes: 0, edges: 0, recognizers: 0, templates: 0 };
}

/** 摆好"开着哪几张 + 当前是哪张"，返回被替换掉的 switchProject 探针。 */
function setup(open: string[], current: string): ReturnType<typeof vi.fn> {
  const switchProject = vi.fn(() => Promise.resolve());
  useUiStore.setState({ openGraphs: open });
  useSessionStore.setState({ project: current ? project(current) : null, switchProject });
  render(<GraphTabs />);
  return switchProject;
}

describe('状态图标签条', () => {
  beforeEach(() => {
    useUiStore.setState({ openGraphs: [] });
    useSessionStore.setState({ project: null });
  });

  it('一张标签一个目录名（任务名 = 目录名，和右栏树一致）', () => {
    setup([A, B], A);

    expect(screen.getByText('斗技')).toBeInTheDocument();
    expect(screen.getByText('百鬼')).toBeInTheDocument();
  });

  it('没有打开的东西时整条不渲染（面板头回到「状态图」标题）', () => {
    const { container } = render(<GraphTabs />);
    expect(container).toBeEmptyDOMElement();
  });

  it('点非当前标签 = 切过去；点当前那个不重复切（避免白热重载一次）', async () => {
    const user = userEvent.setup();
    const switchProject = setup([A, B], A);

    await user.click(screen.getByText('百鬼'));
    expect(switchProject).toHaveBeenCalledWith(B);

    await user.click(screen.getByText('斗技'));
    expect(switchProject).toHaveBeenCalledTimes(1);
  });

  it('✕ 关掉当前那张 → 从列表移除并切到相邻的（右边优先）', async () => {
    const user = userEvent.setup();
    const switchProject = setup([A, B, C], B);

    await user.click(screen.getAllByTitle('关闭这个标签（只是关掉界面，文件还在）')[1] as HTMLElement);

    expect(useUiStore.getState().openGraphs).toEqual([A, C]);
    expect(switchProject).toHaveBeenCalledWith(C);
  });

  it('✕ 关掉不是当前那张 → 只是移除，不切目录', async () => {
    const user = userEvent.setup();
    const switchProject = setup([A, B], B);

    await user.click(screen.getAllByTitle('关闭这个标签（只是关掉界面，文件还在）')[0] as HTMLElement);

    expect(useUiStore.getState().openGraphs).toEqual([B]);
    expect(switchProject).not.toHaveBeenCalled();
  });

  it('关掉最后一个：标签条清空、**不切目录**（引擎那边还指着这个目录，中间显示空态）', async () => {
    const user = userEvent.setup();
    const switchProject = setup([A], A);

    await user.click(screen.getByTitle('关闭这个标签（只是关掉界面，文件还在）'));

    expect(useUiStore.getState().openGraphs).toEqual([]);
    expect(switchProject).not.toHaveBeenCalled();
  });
});

describe('图栏与标签的接线（GraphPane）', () => {
  beforeEach(() => {
    useUiStore.setState({ openGraphs: [] });
    useSessionStore.setState({ project: null });
  });

  it('当前是哪张图，它就在标签条里（右栏点一下 = 中间开一个，不用每个调用点各写一遍）', () => {
    useSessionStore.setState({ project: project(A), switchProject: vi.fn(() => Promise.resolve()) });
    render(<GraphPane />);

    expect(useUiStore.getState().openGraphs).toEqual([A]);
    expect(screen.getByText('斗技')).toBeInTheDocument(); // 标签条在面板头的位置
    expect(screen.queryByText('没有打开的状态图')).not.toBeInTheDocument();
  });

  it('全部关掉 → 画布盖一层空态；点「重新打开」还能把它开回来（不是死路）', async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ project: project(A), switchProject: vi.fn(() => Promise.resolve()) });
    render(<GraphPane />);

    await user.click(screen.getByTitle('关闭这个标签（只是关掉界面，文件还在）'));
    expect(screen.getByText('没有打开的状态图')).toBeInTheDocument();

    await user.click(screen.getByText('重新打开「斗技」'));
    expect(useUiStore.getState().openGraphs).toEqual([A]);
    expect(screen.queryByText('没有打开的状态图')).not.toBeInTheDocument();
  });
});
