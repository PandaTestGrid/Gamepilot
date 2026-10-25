/**
 * 中间的 IDE 式标签条：点一个开一个、✕ 关掉、关掉当前那个接相邻那个。
 *
 * 这里只管"标签条 → 会话层"这条链路（切目录由 `switchWorkflow` 负责，它自己那套有测试）。
 * 关标签**不删文件**，所以任何一个用例都不该出现删除类调用。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphTabs } from '@/features/graph/GraphTabs';
import { GraphPane } from '@/features/graph/GraphPane';
import { useDeviceStore } from '@/stores/device.store';
import { useLibraryStore } from '@/stores/library.store';
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

function workflowInfo(root: string): ProjectInfo {
  return { root, graphPath: `${root}/graph.json`, nodes: 0, edges: 0, recognizers: 0, templates: 0 };
}

/** 摆好"开着哪几张 + 当前是哪张"，返回被替换掉的 switchWorkflow 探针。 */
function setup(open: string[], current: string): ReturnType<typeof vi.fn> {
  const switchWorkflow = vi.fn(() => Promise.resolve());
  useUiStore.setState({ openWorkflowTabs: open });
  useSessionStore.setState({
    currentWorkflow: current ? workflowInfo(current) : null,
    switchWorkflow,
  });
  render(<GraphTabs />);
  return switchWorkflow;
}

describe('状态图标签条', () => {
  beforeEach(() => {
    useUiStore.setState({ openWorkflowTabs: [] });
    useSessionStore.setState({
      currentWorkflow: null,
      switchingWorkflow: false,
      switchingWorkflowRoot: '',
      holdRunningDuringSwitch: false,
      running: {},
      runningWorkflowRoots: {},
    });
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
    const switchWorkflow = setup([A, B], A);

    await user.click(screen.getByText('百鬼'));
    expect(switchWorkflow).toHaveBeenCalledWith(B);

    await user.click(screen.getByText('斗技'));
    expect(switchWorkflow).toHaveBeenCalledTimes(1);
  });

  it('✕ 关掉当前那张 → 从列表移除并切到相邻的（右边优先）', async () => {
    const user = userEvent.setup();
    const switchWorkflow = setup([A, B, C], B);

    await user.click(screen.getAllByTitle('关闭这个标签（只是关掉界面，文件还在）')[1] as HTMLElement);

    expect(useUiStore.getState().openWorkflowTabs).toEqual([A, C]);
    expect(switchWorkflow).toHaveBeenCalledWith(C);
  });

  it('✕ 关掉不是当前那张 → 只是移除，不切目录', async () => {
    const user = userEvent.setup();
    const switchWorkflow = setup([A, B], B);

    await user.click(screen.getAllByTitle('关闭这个标签（只是关掉界面，文件还在）')[0] as HTMLElement);

    expect(useUiStore.getState().openWorkflowTabs).toEqual([B]);
    expect(switchWorkflow).not.toHaveBeenCalled();
  });

  it('关掉最后一个：标签条清空、**不切目录**（引擎那边还指着这个目录，中间显示空态）', async () => {
    const user = userEvent.setup();
    const switchWorkflow = setup([A], A);

    await user.click(screen.getByTitle('关闭这个标签（只是关掉界面，文件还在）'));

    expect(useUiStore.getState().openWorkflowTabs).toEqual([]);
    expect(switchWorkflow).not.toHaveBeenCalled();
  });

  it('切走之后：还在跑的那份工作流标签前面有运行点（不要转圈）', () => {
    useDeviceStore.setState({
      devices: [
        {
          id: 'dev-1',
          name: 'MuMu',
          kind: 'emulator',
          uri: 'Android://127.0.0.1:7555/dev-1',
          resolution: [1080, 1920],
          fps: 20,
          status: 'connected',
        },
      ],
      activeId: 'dev-1',
    });
    useUiStore.setState({ openWorkflowTabs: [A, B] });
    useSessionStore.setState({
      currentWorkflow: workflowInfo(B),
      running: { 'dev-1': true },
      runningWorkflowRoots: { 'dev-1': [A] },
      switchWorkflow: vi.fn(() => Promise.resolve()),
    });
    render(<GraphTabs />);

    const live = screen.getByText('斗技').closest('[role="tab"]');
    expect(live).toHaveAttribute('aria-busy', 'true');
    expect(live?.querySelector('[data-testid="run-live-dot"]')).not.toBeNull();
    expect(live?.querySelector('[data-testid="run-busy-spinner"]')).toBeNull();
    expect(live?.getAttribute('title')).toContain('运行中 · MuMu');
    expect(
      screen.getByText('百鬼').closest('[role="tab"]')?.querySelector('[data-testid="run-live-dot"]'),
    ).toBeNull();
  });

  it('点还在跑的工作流标签：切到那份脚本，并跳到正在跑它的设备', async () => {
    const user = userEvent.setup();
    const switchWorkflow = vi.fn(() => Promise.resolve());
    useDeviceStore.setState({
      devices: [
        {
          id: 'dev-1',
          name: 'MuMu',
          kind: 'emulator',
          uri: 'Android://127.0.0.1:7555/dev-1',
          resolution: [1080, 1920],
          fps: 20,
          status: 'connected',
        },
        {
          id: 'dev-2',
          name: 'SM-G9980',
          kind: 'android',
          uri: 'Android://127.0.0.1:5037/dev-2',
          resolution: [1080, 1920],
          fps: 18,
          status: 'connected',
        },
      ],
      activeId: 'dev-2',
    });
    useUiStore.setState({ openWorkflowTabs: [A, B] });
    useSessionStore.setState({
      currentWorkflow: workflowInfo(B),
      running: { 'dev-1': true },
      runningWorkflowRoots: { 'dev-1': [A] },
      switchWorkflow,
    });
    render(<GraphTabs />);

    await user.click(screen.getByText('斗技'));
    expect(switchWorkflow).toHaveBeenCalledWith(A);
    expect(useDeviceStore.getState().activeId).toBe('dev-1');
  });

  it('运行中关标签：先二次确认，取消不关、确认才关', async () => {
    const user = userEvent.setup();
    useDeviceStore.setState({
      devices: [
        {
          id: 'dev-1',
          name: 'MuMu',
          kind: 'emulator',
          uri: 'Android://127.0.0.1:7555/dev-1',
          resolution: [1080, 1920],
          fps: 20,
          status: 'connected',
        },
      ],
      activeId: 'dev-1',
    });
    useUiStore.setState({ openWorkflowTabs: [A, B] });
    useSessionStore.setState({
      currentWorkflow: workflowInfo(B),
      running: { 'dev-1': true },
      runningWorkflowRoots: { 'dev-1': [A] },
      switchWorkflow: vi.fn(() => Promise.resolve()),
    });
    render(<GraphTabs />);

    await user.click(screen.getByTitle('关闭这个标签（正在运行，会先确认）'));
    expect(useUiStore.getState().openWorkflowTabs).toEqual([A, B]);
    expect(screen.getByTestId('workflow-tab-confirm-close')).toBeInTheDocument();

    await user.click(screen.getByTestId('workflow-tab-cancel-close'));
    expect(useUiStore.getState().openWorkflowTabs).toEqual([A, B]);
    expect(screen.queryByTestId('workflow-tab-confirm-close')).not.toBeInTheDocument();

    await user.click(screen.getByTitle('关闭这个标签（正在运行，会先确认）'));
    await user.click(screen.getByTestId('workflow-tab-confirm-close'));
    expect(useUiStore.getState().openWorkflowTabs).toEqual([B]);
  });

  it('正在切工作流：目标标签前面转圈（哪怕引擎还没把 currentRoot 改过来）', () => {
    useUiStore.setState({ openWorkflowTabs: [A, B] });
    useSessionStore.setState({
      currentWorkflow: workflowInfo(A),
      switchingWorkflow: true,
      switchingWorkflowRoot: B,
      switchWorkflow: vi.fn(() => Promise.resolve()),
    });
    render(<GraphTabs />);

    const target = screen.getByText('百鬼').closest('[role="tab"]');
    expect(target).toHaveAttribute('aria-busy', 'true');
    expect(target?.querySelector('[data-testid="run-busy-spinner"]')).not.toBeNull();
    expect(
      screen.getByText('斗技').closest('[role="tab"]')?.querySelector('[data-testid="run-busy-spinner"]'),
    ).toBeNull();
  });
});

describe('图栏与标签的接线（GraphPane）', () => {
  beforeEach(() => {
    useUiStore.setState({ openWorkflowTabs: [], startPageOpen: false });
    useSessionStore.setState({
      currentWorkflow: null,
      switchingWorkflow: false,
      switchingWorkflowRoot: '',
      holdRunningDuringSwitch: false,
      running: {},
      runningWorkflowRoots: {},
    });
    useLibraryStore.setState({
      workflows: [{ name: '斗技', root: A, nodes: 0, edges: 0, recognizers: 0, templates: 0, modified: 0 }],
    });
  });

  it('启动时停在开始页（最近 / 历史），不替用户自动开图', () => {
    useUiStore.setState({ openWorkflowTabs: [], startPageOpen: true });
    useSessionStore.setState({
      currentWorkflow: workflowInfo(A),
      switchWorkflow: vi.fn(() => Promise.resolve()),
    });
    render(<GraphPane />);

    expect(useUiStore.getState().openWorkflowTabs).toEqual([]);
    expect(screen.getByText('打开工作区')).toBeInTheDocument();
    expect(screen.getByText('历史')).toBeInTheDocument();
  });

  it('已经开着标签时，当前那张一定在标签条里', () => {
    useUiStore.setState({ openWorkflowTabs: [A] });
    useSessionStore.setState({
      currentWorkflow: workflowInfo(A),
      switchWorkflow: vi.fn(() => Promise.resolve()),
    });
    render(<GraphPane />);

    expect(useUiStore.getState().openWorkflowTabs).toEqual([A]);
    expect(screen.getByText('斗技')).toBeInTheDocument(); // 标签条在面板头的位置
    expect(screen.queryByText('打开工作区')).not.toBeInTheDocument();
  });

  it('全局配置贴在画布右侧，不挤进控制台、也不占详情那一行', () => {
    useUiStore.setState({ openWorkflowTabs: [A], flowGlobalSettingsOpen: true, flowDockOpen: true });
    useSessionStore.setState({
      currentWorkflow: workflowInfo(A),
      switchWorkflow: vi.fn(() => Promise.resolve()),
    });
    render(<GraphPane />);

    const drawer = screen.getByTestId('flow-global-settings-drawer');
    // 在画布这一格里（和画布并排），不在详情/控制台那一格
    expect(drawer.closest('[data-panel]')?.id).toBe('canvas');
    expect(drawer.contains(screen.getByTestId('dock-tab-console'))).toBe(false);
    expect(screen.getByTestId('flow-canvas-wrap').closest('[data-panel]')?.id).toBe('canvas');
  });

  it('全部关掉 → 画布盖一层开始页；点「最近」里那条还能把它开回来（不是死路）', async () => {
    const user = userEvent.setup();
    useUiStore.setState({ openWorkflowTabs: [A] });
    useSessionStore.setState({
      currentWorkflow: workflowInfo(A),
      // 真实现会在 switchWorkflow 里 openWorkflowTab；这里只验"点一下能开回来"这条链路
      switchWorkflow: vi.fn((root: string) => {
        useUiStore.getState().openWorkflowTab(root);
        return Promise.resolve();
      }),
    });
    render(<GraphPane />);

    await user.click(screen.getByTitle('关闭这个标签（只是关掉界面，文件还在）'));
    expect(screen.getByText('打开工作区')).toBeInTheDocument();
    expect(screen.getByText('最近')).toBeInTheDocument();
    expect(screen.getByText('历史')).toBeInTheDocument();

    await user.click(screen.getByText('斗技'));
    expect(useUiStore.getState().openWorkflowTabs).toEqual([A]);
    expect(screen.queryByText('打开工作区')).not.toBeInTheDocument();
  });
});
