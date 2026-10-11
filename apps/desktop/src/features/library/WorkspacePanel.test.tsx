/**
 * 工作区面板（浮层）的交互 —— 契约 v4 §3.2。
 *
 * 形态是「工作区（文件夹）› 会话（= 一张状态图）」：
 * 1. **添加工作区是一步**：挑中文件夹 → 直接 `workspace.add`（显示名默认取文件夹名，之后可改）；
 *    从 Finder 拖文件夹进来走同一条路（webview 拖拽事件给的是真实路径）；
 * 2. **挑文件夹有手输兜底**：原生对话框在 vitest 里必然拿不到（没有 Tauri），
 *    所以这里不 mock `native-dialog`，验证"退回手输绝对路径 + 添加这个工作区"真的能用；
 * 3. **点工作区名字 = 切过去**（幂等 `workspace.add`），不再是那个叫「打开」的按钮；
 *    **行尾的 ＋ = 在这个工作区里新建会话**（自动命名，不弹输入框）；
 * 4. **移除两个入口都有**：`deleteFiles:true`（移到回收站，可恢复，文案显示回收站路径）
 *    与 `deleteFiles:false`（只从列表移除，不动文件），都走行内二次确认；
 * 5. ⌘O 触发同一个添加流程；列表/搜索/相对时间按截图走，全程没有 原生 prompt。
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pickDirectory } from '@/features/library/native-dialog';
import { WorkspacePanel } from '@/features/library/WorkspacePanel';
import {
  workflowCreate,
  workflowDelete,
  workflowDuplicate,
  workflowRename,
  workspaceAdd,
  workspaceList,
  workspaceRemove,
} from '@/lib/rpc';
import { useLibraryStore } from '@/stores/library.store';
import { useSessionStore } from '@/stores/session.store';

const { WS_A, WS_B, WS_GONE, RECOMMENDED, TRASH, WORKFLOWS, WORKSPACES, replies } = vi.hoisted(() => {
  const NOW = Math.floor(Date.now() / 1000);
  const WS_A = '/Users/me/game-a';
  const WS_B = '/Users/me/game-b';
  const WS_GONE = '/Users/me/gone';
  const RECOMMENDED = '/repo/workspaces/默认';
  const TRASH = '/config/gamepilot/.trash';

  const WORKFLOWS = [
    {
      name: '斗技',
      root: `${WS_A}/斗技`,
      nodes: 3,
      edges: 2,
      recognizers: 4,
      templates: 5,
      modified: NOW - 5,
    },
    {
      name: '御魂',
      root: `${WS_A}/御魂`,
      nodes: 5,
      edges: 4,
      recognizers: 2,
      templates: 2,
      modified: NOW - 600,
    },
    {
      name: '14234',
      root: `${WS_A}/14234`,
      nodes: 0,
      edges: 0,
      recognizers: 0,
      templates: 0,
      modified: NOW - 2 * 3600,
    },
    {
      name: '老流程',
      root: `${WS_A}/老流程`,
      nodes: 1,
      edges: 0,
      recognizers: 0,
      templates: 0,
      modified: NOW - 15 * 86400,
    },
  ];

  const WORKSPACES = [
    { name: '我的工作区', root: WS_A, active: true, exists: true },
    { name: 'game-b', root: WS_B, active: false, exists: true },
  ];

  // 每个用例可以改这个（例如 active null 的空配置）
  const replies = {
    list: {
      active: WS_A as string | null,
      recommended: RECOMMENDED,
      trashRoot: TRASH,
      items: WORKSPACES as unknown[],
    },
  };

  return { WS_A, WS_B, WS_GONE, RECOMMENDED, TRASH, WORKFLOWS, WORKSPACES, replies };
});

vi.mock('@/lib/rpc', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/rpc');
  const tree = { root: WS_A, workflows: WORKFLOWS };
  return {
    ...actual,
    devLog: vi.fn(),
    workspaceList: vi.fn(() => Promise.resolve(replies.list)),
    workspaceTree: vi.fn(() => Promise.resolve(tree)),
    workspaceAdd: vi.fn(() =>
      Promise.resolve({ root: WS_B, name: 'game-b', current: '', tree, trashRoot: TRASH, items: WORKSPACES }),
    ),
    workspaceRemove: vi.fn(() =>
      Promise.resolve({
        active: WS_A,
        current: '',
        tree,
        trashRoot: TRASH,
        trashed: `${TRASH}/game-b-1`,
        items: [WORKSPACES[0]],
      }),
    ),
    workflowCreate: vi.fn(() =>
      Promise.resolve({ created: `${WS_A}/新会话`, current: `${WS_A}/新会话`, items: WORKFLOWS }),
    ),
    workflowRename: vi.fn(() => Promise.resolve({ root: `${WS_A}/x`, current: '', items: WORKFLOWS })),
    workflowDuplicate: vi.fn(() => Promise.resolve({ created: `${WS_A}/x`, current: '', items: WORKFLOWS })),
    workflowDelete: vi.fn(() =>
      Promise.resolve({ trashed: `${WS_A}/.trash/x`, current: '', items: WORKFLOWS }),
    ),
    projectGet: vi.fn(() =>
      Promise.resolve({ root: '', graphPath: '', nodes: 0, edges: 0, recognizers: 0, templates: 0 }),
    ),
  };
});

/**
 * webview 的拖拽事件（真实路径）：把回调抓出来，测试里直接喂事件。
 * `vi.hoisted` 是必须的 —— `vi.mock` 会被提升到文件顶部。
 */
const drop = vi.hoisted(() => ({ handler: null as null | ((event: { payload: unknown }) => void) }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (event: { payload: unknown }) => void) => {
      drop.handler = handler;
      return Promise.resolve(() => undefined);
    },
  }),
}));

/** 区域是**常驻内容**（不再是浮层）：直接渲染，没有"打开/关闭"这回事 */
function Harness(): ReactNode {
  return <WorkspacePanel />;
}

const switchProject = vi.fn((): Promise<void> => Promise.resolve());

describe('工作区区域（右栏 Tab 的本体内容）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replies.list = { active: WS_A, recommended: RECOMMENDED, trashRoot: TRASH, items: WORKSPACES };
    useLibraryStore.setState({
      workspaceRoot: WS_A,
      workflows: WORKFLOWS,
      workspaces: WORKSPACES,
      recommendedWorkspace: RECOMMENDED,
      trashRoot: TRASH,
      error: null,
    });
    // 区域要标出"当前这一条"工作流（点线 + 深灰底那条）
    switchProject.mockClear();
    useSessionStore.setState({
      project: { root: `${WS_A}/斗技` } as never,
      switchProject,
      applyProjectChange: () => Promise.resolve(),
    } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('列出所有工作区（当前那个也不高亮），当前工作区下面挂它的工作流 + 相对时间，底部固定「默认工作区」', async () => {
    render(<Harness />);

    // 头部四件套：标题 / 搜索 / 设置 / ＋（添加工作区 ⌘O）
    expect(screen.getByText('工作区')).toBeInTheDocument();
    expect(screen.getByTitle('搜索工作区与工作流（⌘F）')).toBeInTheDocument();
    expect(screen.getByTitle('设置（移除当前工作区）')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-add')).toBeInTheDocument();

    // 列表：当前（我的工作区，名字是用户输的）+ 其他（game-b）
    expect(await screen.findByText('我的工作区')).toBeInTheDocument();
    expect(screen.getByText('game-b')).toBeInTheDocument();

    // 当前工作区下面的工作流列表（相对时间：modified 是 epoch 秒）
    expect(screen.getByText('斗技')).toBeInTheDocument();
    expect(screen.getByText('刚刚')).toBeInTheDocument();
    expect(screen.getByText('御魂')).toBeInTheDocument();
    expect(screen.getByText('10 分钟')).toBeInTheDocument();
    expect(screen.getByText('2 小时')).toBeInTheDocument();
    // 粒度到"天/月"就停（照参照图：15d / 1mo）
    expect(screen.getByText('15 天')).toBeInTheDocument();
    expect(screen.getAllByTestId('workspace-workflow-row')).toHaveLength(WORKFLOWS.length);

    // 底部那个固定的「默认工作区」已经删掉（它和列表里同名的目录重复，用户看到两个"默认"）
    expect(screen.queryByText('默认工作区')).not.toBeInTheDocument();
    // 面板里不该再出现「项目」当层级名
    expect(screen.queryByText('项目')).not.toBeInTheDocument();
  });

  it('当前工作流的行带 aria-current（圆点也标成当前），其他行不带', async () => {
    render(<Harness />);
    await screen.findByText('斗技');

    const rows = screen.getAllByTestId('workspace-workflow-row');
    const currentRows = rows.filter((row) => row.getAttribute('aria-current') === 'true');
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0]?.textContent).toContain('斗技');

    // 圆点：当前那条是实心的（data-current=true），其余是暗点
    const dots = screen.getAllByTestId('workflow-dot');
    expect(dots.filter((dot) => dot.dataset.current === 'true')).toHaveLength(1);
    expect(dots.filter((dot) => dot.dataset.current === 'false')).toHaveLength(WORKFLOWS.length - 1);
  });

  it('工作区行只是普通一行：没有当前态标记、也没有计数/装饰', async () => {
    render(<Harness />);

    const rows = await screen.findAllByTestId('workspace-row');
    expect(rows).toHaveLength(WORKSPACES.length);
    // 当前工作区"不高亮"是结构性约定：行上没有 aria-current（当前态由它下面的工作流行体现）
    for (const row of rows) {
      expect(row).not.toHaveAttribute('aria-current');
    }
    // 行里就是「箭头 + 文件夹 + 名字」（多出来的是悬停才显示的 ＋），不挂计数
    expect(rows[0]?.textContent).toBe('我的工作区');
    expect(rows[1]?.textContent).toBe('game-b');
  });

  it('工作流行只显示"名字 + 相对时间"（不带节点数/边数，那是树里的）', async () => {
    render(<Harness />);
    await screen.findByText('斗技');

    const row = screen.getAllByTestId('workspace-workflow-row')[0];
    expect(row?.textContent).toBe('•斗技刚刚');

    // 树里的 3/2 那种计数不该出现在面板
    expect(screen.queryByText('3/2')).not.toBeInTheDocument();
    expect(screen.queryByText('5/4')).not.toBeInTheDocument();
  });

  it('添加工作区一步到位：选了/输了文件夹就直接 workspace.add（名字交给引擎取文件夹名）', async () => {
    // 非 Tauri 环境（vitest）里原生对话框必然不可用 → pickDirectory 返回 null，走手输兜底
    expect(await pickDirectory()).toBeNull();

    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByTestId('workspace-add'));
    await user.type(await screen.findByPlaceholderText('/Users/me/Documents/game-a'), '/Users/me/game-c');
    await user.click(screen.getByRole('button', { name: '添加这个工作区' }));

    // 名字省略（undefined）= 引擎用文件夹名当显示名；没有"第二步输名字"这回事
    expect(workspaceAdd).toHaveBeenCalledWith('/Users/me/game-c', undefined, true);
    expect(screen.queryByText(/起个名字/)).not.toBeInTheDocument();
  });

  it('从 Finder 拖文件夹进来 = 添加工作区（webview 拖拽事件给真实路径）', async () => {
    render(<Harness />);
    await screen.findByText('game-b');

    act(() => {
      drop.handler?.({ payload: { type: 'enter', paths: [] } });
    });
    expect(screen.getByTestId('workspace-drop-hint')).toBeInTheDocument();

    // 逐个登记是异步的：act 结束前把微任务冲干净（否则第二台还没发出去）
    await act(async () => {
      drop.handler?.({ payload: { type: 'drop', paths: [WS_B, '/Users/me/game-c'] } });
      await Promise.resolve();
    });

    // 一次拖进来的每个文件夹都登记一遍（异步逐个加，等一拍）
    await waitFor(() => expect(workspaceAdd).toHaveBeenCalledWith('/Users/me/game-c', undefined, true));
    expect(workspaceAdd).toHaveBeenCalledWith(WS_B, undefined, true);
    expect(screen.queryByTestId('workspace-drop-hint')).not.toBeInTheDocument();
  });

  it('相对路径在第一步就被拦下（前端先给反馈，不等到引擎报错）', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByTestId('workspace-add'));
    await user.type(await screen.findByPlaceholderText('/Users/me/Documents/game-a'), './rel');

    expect(screen.getByText('要绝对路径（或 ~ 开头）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加这个工作区' })).toBeDisabled();
    expect(workspaceAdd).not.toHaveBeenCalled();
  });

  it('⌘O 也能添加工作区：区域常驻，按下去就出现手输框（原生不可用时的兜底）', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByTestId('workspace-region')).toBeInTheDocument();
    // 一开始没有添加表单
    expect(screen.queryByPlaceholderText('/Users/me/Documents/game-a')).not.toBeInTheDocument();

    await user.keyboard('{Meta>}o{/Meta}');

    expect(await screen.findByPlaceholderText('/Users/me/Documents/game-a')).toBeInTheDocument();
    expect(workspaceAdd).not.toHaveBeenCalled();
  });

  it('点工作区名字 = 切过去（幂等 workspace.add）；「打开」这个按钮已经不存在', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await screen.findByText('game-b');
    expect(screen.queryByText('打开')).not.toBeInTheDocument();

    const rows = screen.getAllByTestId('workspace-row');
    const second = rows[1];
    expect(second).toBeDefined();
    await user.click(within(second as HTMLElement).getByTestId('workspace-switch'));

    expect(workspaceAdd).toHaveBeenCalledWith(WS_B, 'game-b', true);
    expect(screen.getByTestId('workspace-region')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('行尾的 ＋ = 先弹输入框起名，提交才 workflow.create（在**那个**工作区里）', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await screen.findByText('game-b');
    const rows = screen.getAllByTestId('workspace-row');
    const second = rows[1];
    expect(second).toBeDefined();
    await user.click(within(second as HTMLElement).getByTestId('workspace-new-session'));

    // 不是当前工作区：先切过去（幂等）
    await waitFor(() => expect(workspaceAdd).toHaveBeenCalledWith(WS_B, 'game-b', true));

    // 但**还没建**：起名表单出来了，输名字之前一个都不建
    expect(workflowCreate).not.toHaveBeenCalled();
    const input = await screen.findByPlaceholderText('例如 斗技');
    await user.type(input, '新会话甲');
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(workflowCreate).toHaveBeenCalledWith('新会话甲'));
  });

  it('当前工作区行尾的 ＋：不重复切工作区，同样先起名再建；取消则什么都不建', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await screen.findByText('斗技');
    const rows = screen.getAllByTestId('workspace-row');
    const first = rows[0];
    expect(first).toBeDefined();
    await user.click(within(first as HTMLElement).getByTestId('workspace-new-session'));

    expect(workspaceAdd).not.toHaveBeenCalled();
    await screen.findByPlaceholderText('例如 斗技');
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(workflowCreate).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('例如 斗技')).not.toBeInTheDocument();
  });

  it('折叠：点**当前**工作区的名字收起它的会话，再点展开（点别的工作区名字 = 切过去）', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await screen.findByText('斗技');
    const disclosure = screen.getAllByTestId('workspace-disclosure')[0];
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');

    // 点当前工作区的名字 = 折叠（不是切换：不发 workspace.add）
    await user.click(await screen.findByText('我的工作区'));
    expect(workspaceAdd).not.toHaveBeenCalled();

    expect(screen.getAllByTestId('workspace-disclosure')[0]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByTestId('workspace-workflow-row')).toHaveLength(0);

    // noUncheckedIndexedAccess：`[0]` 是 `HTMLElement | undefined`，取出来先兜一下类型
    const toggler = screen.getAllByTestId('workspace-disclosure')[0];
    expect(toggler).toBeDefined();
    await user.click(toggler as HTMLElement);
    expect(screen.getAllByTestId('workspace-workflow-row')).toHaveLength(WORKFLOWS.length);
  });

  it('搜索：按名字过滤工作区与工作流（本地过滤）', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByTitle('搜索工作区与工作流（⌘F）'));
    await user.type(screen.getByPlaceholderText('搜索工作区 / 工作流'), 'game-b');

    expect(screen.getByText('game-b')).toBeInTheDocument();
    expect(screen.queryByText('我的工作区')).not.toBeInTheDocument();
    expect(screen.queryByText('斗技')).not.toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText('搜索工作区 / 工作流'));
    await user.type(screen.getByPlaceholderText('搜索工作区 / 工作流'), '斗');
    expect(screen.getByText('斗技')).toBeInTheDocument();
  });

  it('移除工作区之一：只从列表移除（不动文件）—— 行内二次确认，deleteFiles:false', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByTitle('设置（移除当前工作区）'));
    await user.click(screen.getByText('只从列表移除（不动文件）'));

    expect(screen.getByText(/磁盘上的文件一个都不会动/)).toBeInTheDocument();
    expect(workspaceRemove).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认移除' }));
    expect(workspaceRemove).toHaveBeenCalledWith(WS_A, false);
  });

  it('移除工作区之二：移到回收站（可恢复）—— 文案显示回收站路径，绝不出现"永久删除"', async () => {
    const prompt = vi.fn();
    vi.stubGlobal('prompt', prompt);
    const user = userEvent.setup();
    const { container } = render(<Harness />);

    await user.click(screen.getByTitle('设置（移除当前工作区）'));
    await user.click(screen.getByText('移到回收站（可以恢复）'));

    expect(screen.getByText(new RegExp(TRASH.replace(/[.\\/]/g, '\\$&')))).toBeInTheDocument();
    expect(screen.getByText(/可以恢复/)).toBeInTheDocument();
    expect(container.textContent ?? '').not.toContain('永久删除');
    expect(workspaceRemove).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认移入回收站' }));
    expect(workspaceRemove).toHaveBeenCalledWith(WS_A, true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('目录被删掉的工作区（exists:false）：灰掉 + 「目录不存在」+ 只能从列表移除', async () => {
    replies.list = {
      active: WS_A,
      recommended: RECOMMENDED,
      trashRoot: TRASH,
      items: [...WORKSPACES, { name: 'gone', root: WS_GONE, active: false, exists: false }],
    };
    useLibraryStore.setState({
      workspaces: [...WORKSPACES, { name: 'gone', root: WS_GONE, active: false, exists: false }],
    });
    const user = userEvent.setup();
    render(<Harness />);

    expect(await screen.findByText('目录不存在')).toBeInTheDocument();
    await user.click(screen.getByText('从列表移除'));
    await user.click(screen.getByRole('button', { name: '确认移除' }));

    expect(workspaceRemove).toHaveBeenCalledWith(WS_GONE, false);
  });

  it('一个工作区都没有（active null）：列表为空 + 主按钮「添加工作区…」+ 次按钮「默认工作区」', async () => {
    replies.list = { active: null, recommended: RECOMMENDED, trashRoot: TRASH, items: [] };
    useLibraryStore.setState({ workspaceRoot: '', workspaces: [], workflows: [] });
    render(<Harness />);

    expect(await screen.findByText('还没有工作区')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-add')).toBeInTheDocument();
    // 「用默认工作区」那条次入口也取消了（推荐目录不再是界面上的一个动作）
    expect(screen.queryByText('默认工作区')).not.toBeInTheDocument();
  });

  it('点工作流名字 = 切过去（走 switchProject）', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(await screen.findByText('御魂'));

    expect(switchProject).toHaveBeenCalledWith(`${WS_A}/御魂`);
  });

  it('工作流行悬停「重命名」：内联表单预填当前名字，提交才 renameWorkflow', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const [row] = await screen.findAllByTestId('workspace-workflow-row');

    await user.click(within(row as HTMLElement).getByTitle('重命名'));

    // 内联表单（不是 prompt）：预填当前名字
    const input = await screen.findByDisplayValue('斗技');
    expect(screen.getByText('重命名「斗技」')).toBeInTheDocument();
    expect(workflowRename).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, '斗技2');
    const form = screen.getByText('重命名「斗技」').closest('form');
    await user.click(within(form as HTMLElement).getByRole('button', { name: '重命名' }));

    expect(workflowRename).toHaveBeenCalledWith(`${WS_A}/斗技`, '斗技2');
  });

  it('工作流行悬停「复制一份」：直接复制成「-副本」', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const [row] = await screen.findAllByTestId('workspace-workflow-row');

    await user.click(within(row as HTMLElement).getByTitle('复制一份'));

    expect(workflowDuplicate).toHaveBeenCalledWith(`${WS_A}/斗技`, '斗技-副本');
  });

  it('工作流行悬停「删除」：行内二次确认，取消不删、确认才删', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const [row] = await screen.findAllByTestId('workspace-workflow-row');

    await user.click(within(row as HTMLElement).getByTitle(/移到工作区根的 .trash/));
    expect(await screen.findByText(/删除「斗技」？/)).toBeInTheDocument();
    expect(workflowDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByText(/删除「斗技」？/)).not.toBeInTheDocument();
    expect(workflowDelete).not.toHaveBeenCalled();

    const [again] = await screen.findAllByTestId('workspace-workflow-row');
    await user.click(within(again as HTMLElement).getByTitle(/移到工作区根的 .trash/));
    await user.click(await screen.findByRole('button', { name: '确认删除' }));
    expect(workflowDelete).toHaveBeenCalledWith(`${WS_A}/斗技`);
  });

  it('有工作区但没有工作流：工作区行照常在，只是没有工作流行（不炸、不重复列表）', async () => {
    useLibraryStore.setState({ workspaceRoot: WS_A, workflows: [] });
    render(<Harness />);

    expect(await screen.findByText('我的工作区')).toBeInTheDocument();
    expect(screen.queryAllByTestId('workspace-workflow-row')).toHaveLength(0);
    expect(screen.queryByText('斗技')).not.toBeInTheDocument();
  });

  it('Esc 收起行内表单（区域不消失）；区域挂载即拉一次工作区列表（不做本地缓存）', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(workspaceList).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId('workspace-list')).getByText('我的工作区')).toBeInTheDocument();

    await user.click(screen.getByTestId('workspace-add'));
    expect(await screen.findByPlaceholderText('/Users/me/Documents/game-a')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByPlaceholderText('/Users/me/Documents/game-a')).not.toBeInTheDocument();
    // 区域本身常驻
    expect(screen.getByTestId('workspace-region')).toBeInTheDocument();
  });
});
