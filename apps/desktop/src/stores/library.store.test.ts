/**
 * 工作区 store 的测试（v4：工作区 › 工作流）。
 *
 * 这里 mock 掉 Tauri 的 invoke（也就是 RPC 出口），验三件事：
 *   1. **方法名与参数**是否就是契约里的那套（`workflow.*` 只碰工作流，`workspace.add` 带名字）；
 *   2. 树/列表都进了 store（面板与树直接渲染它们）；
 *   3. 引擎返回脏数据（`{}`、少字段）时收窄成空，不让界面崩在 `.length` 上。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowSummary } from '@/lib/rpc';
import { useEngineStore } from '@/stores/engine.store';
import { useLibraryStore } from '@/stores/library.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

/** engine_rpc 的调用形状（method + params）；其它命令（dev_log 等）不关心参数。 */
type RpcCall = { method?: string; params?: Record<string, unknown> };

// 默认返回 Promise：真 invoke 永远是 Promise，mock 成 undefined 会让 devLog 里的 .catch 炸
const invoke = vi.fn((_cmd: string, _args?: RpcCall): Promise<unknown> => Promise.resolve({}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: RpcCall): Promise<unknown> => invoke(cmd, args),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const WS = '/Users/me/game-bot';
const CURRENT = `${WS}/斗技`;

const WORKFLOWS: WorkflowSummary[] = [
  { name: '斗技', root: CURRENT, nodes: 3, edges: 2, recognizers: 4, templates: 5, modified: 1760000000 },
  { name: '御魂', root: `${WS}/御魂`, nodes: 5, edges: 4, recognizers: 2, templates: 2, modified: 0 },
];

const TREE = { root: WS, workflows: WORKFLOWS };

/** 让下一次（或下几次）某个方法返回给定结果（或抛错）。 */
const replies = new Map<string, { result: unknown; error?: string }[]>();

function reply(method: string, result: unknown, error?: string): void {
  const queue = replies.get(method) ?? [];
  queue.push({ result, error });
  replies.set(method, queue);
}

/** engine_rpc 的调用记录（method + params），断言契约用。 */
function calls(method: string): Record<string, unknown>[] {
  return invoke.mock.calls
    .filter(([cmd, args]) => cmd === 'engine_rpc' && args?.method === method)
    .map(([, args]) => args?.params ?? {});
}

/** 引擎侧写完之后界面"回显当前工作流"这一步（真实实现会发 project.get 并重拉各设备状态图）。 */
const syncCurrentWorkflow = vi.fn((): Promise<void> => {
  useSessionStore.setState({
    currentWorkflow: { root: CURRENT, graphPath: '', nodes: 3, edges: 2, recognizers: 4, templates: 5 },
  });
  return Promise.resolve();
});

describe('工作区 store（v4）', () => {
  beforeEach(() => {
    replies.clear();
    invoke.mockReset();
    invoke.mockImplementation((cmd: string, args?: RpcCall) => {
      if (cmd !== 'engine_rpc') {
        return Promise.resolve({});
      }
      const next = replies.get(args?.method ?? '')?.shift();
      if (!next) {
        return Promise.resolve({});
      }
      return next.error ? Promise.reject(new Error(next.error)) : Promise.resolve(next.result);
    });
    syncCurrentWorkflow.mockClear();

    // 失败要能进错误行：这几条用例都是"引擎已就绪、某个写操作失败"
    useEngineStore.setState({ status: 'ready' });
    useLibraryStore.setState({
      workspaceRoot: '',
      workflows: [],
      workspaces: [],
      recommendedWorkspace: '',
      loading: false,
      error: null,
    });
    useSessionStore.setState({
      currentWorkflow: { root: CURRENT, graphPath: '', nodes: 3, edges: 2, recognizers: 4, templates: 5 },
      error: null,
      ready: {},
      syncCurrentWorkflow,
    } as never);
  });

  it('刷新：workspace.tree 一次拉回当前工作区的根 + 全部工作流（含 modified）', async () => {
    reply('workspace.tree', TREE);
    await useLibraryStore.getState().refresh();

    const state = useLibraryStore.getState();
    expect(state.workspaceRoot).toBe(WS);
    expect(state.workflows.map((item) => item.name)).toEqual(['斗技', '御魂']);
    expect(state.workflows[0]?.modified).toBe(1760000000);
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
  });

  it('引擎返回缺字段（空对象）时退回空树，而不是让界面崩在 .length 上', async () => {
    reply('workspace.tree', {});
    await useLibraryStore.getState().refresh();

    expect(useLibraryStore.getState().workflows).toEqual([]);
    expect(useLibraryStore.getState().workspaceRoot).toBe('');
  });

  it('启动时 workspace.list 还没回来（workspaces 为空）但树已经有了：不能把标签清掉', () => {
    // 真实启动顺序：workspace.tree 与 workspace.list 并发，tree 先回。
    // 旧实现在这里 clearOpenWorkflowTabs()，于是「重启后标签全没了」。
    useUiStore.setState({ openWorkflowTabs: [CURRENT, `${WS}/御魂`] });
    useLibraryStore.setState({ workspaces: [], workspaceRoot: WS, workflows: WORKFLOWS });
    useLibraryStore.getState().reconcileOpenWorkflowTabs();

    expect(useUiStore.getState().openWorkflowTabs).toEqual([CURRENT, `${WS}/御魂`]);
  });

  it('没有工作区或工作流时 reconcile 会清掉 localStorage 里的历史 Tab', () => {
    useUiStore.setState({ openWorkflowTabs: [`${WS}/asdasd`] });
    useLibraryStore.setState({ workspaces: [], workflows: [], workspaceRoot: '' });
    useLibraryStore.getState().reconcileOpenWorkflowTabs();
    expect(useUiStore.getState().openWorkflowTabs).toEqual([]);
  });

  it('刷新失败：错误留在面板里，不抛给调用方', async () => {
    reply('workspace.tree', null, '工作区目录不存在');
    await useLibraryStore.getState().refresh();

    expect(useLibraryStore.getState().error).toBe('工作区目录不存在');
    expect(useLibraryStore.getState().loading).toBe(false);
  });

  it('引擎还没起来时的失败只写日志，不把「引擎未启动」挂到面板错误行上', async () => {
    useEngineStore.setState({ status: 'connecting' });
    reply('workspace.tree', null, '引擎没在运行（可能刚退出）：点「重启引擎」重开一次');
    await useLibraryStore.getState().refresh();

    expect(useLibraryStore.getState().error).toBeNull();
    expect(useLibraryStore.getState().loading).toBe(false);
  });

  it('新建工作流：workflow.create 带名字（必填），建完切过去并重拉树', async () => {
    reply('workflow.create', { created: `${WS}/签到`, current: `${WS}/签到`, items: WORKFLOWS });
    reply('workspace.tree', TREE);

    const ok = await useLibraryStore.getState().createWorkflow('签到');

    expect(ok).toBe(true);
    expect(calls('workflow.create')).toEqual([{ name: '签到' }]);
    // 引擎侧已经切好工作流：界面回显（syncCurrentWorkflow）+ 重拉树
    expect(syncCurrentWorkflow).toHaveBeenCalled();
    expect(calls('workspace.tree')).toHaveLength(1);
    expect(useLibraryStore.getState().workflows).toHaveLength(2);
  });

  it('改名 / 复制 / 删除工作流：走 workflow.*，参数是 { dir, name? } / { dir }', async () => {
    reply('workflow.rename', { root: 'x', current: 'x', items: WORKFLOWS });
    reply('workflow.duplicate', { created: 'x', current: 'x', items: WORKFLOWS });
    reply('workflow.delete', { removed: 'x', current: 'x', items: WORKFLOWS });
    reply('workspace.tree', TREE);

    expect(await useLibraryStore.getState().renameWorkflow(CURRENT, '斗技2')).toBe(true);
    expect(await useLibraryStore.getState().duplicateWorkflow(CURRENT, '斗技-副本')).toBe(true);
    expect(await useLibraryStore.getState().removeWorkflow(CURRENT)).toBe(true);

    expect(calls('workflow.rename')).toEqual([{ dir: CURRENT, name: '斗技2' }]);
    expect(calls('workflow.duplicate')).toEqual([{ dir: CURRENT, name: '斗技-副本' }]);
    expect(calls('workflow.delete')).toEqual([{ dir: CURRENT }]);
  });

  it('复制不传名字：只发 dir（引擎自动「<原名>-副本」）', async () => {
    reply('workflow.duplicate', { created: 'x', current: 'x', items: [] });
    reply('workspace.tree', TREE);

    await useLibraryStore.getState().duplicateWorkflow(CURRENT);

    expect(calls('workflow.duplicate')).toEqual([{ dir: CURRENT }]);
  });

  it('工作区列表：workspace.list 的 active/recommended/items 都进 store；脏数据降级成空', async () => {
    reply('workspace.list', {
      active: WS,
      recommended: '/repo/workspaces/默认',
      items: [
        { name: '我的工作区', root: WS, active: true, exists: true },
        { name: 'game-b', root: '/w/game-b', active: false, exists: false },
      ],
    });
    await useLibraryStore.getState().refreshWorkspaces();

    const state = useLibraryStore.getState();
    expect(state.workspaces.map((item) => item.name)).toEqual(['我的工作区', 'game-b']);
    expect(state.workspaces[1]?.exists).toBe(false);
    expect(state.recommendedWorkspace).toBe('/repo/workspaces/默认');

    reply('workspace.list', {});
    await useLibraryStore.getState().refreshWorkspaces();
    expect(useLibraryStore.getState().workspaces).toEqual([]);
  });

  it('添加工作区：workspace.add { dir, name, create }；用返回的树切换当前工作区并刷新列表', async () => {
    const treeB = { root: '/w/game-b', workflows: [] };
    reply('workspace.add', {
      root: '/w/game-b',
      name: '我的第二个工作区',
      current: '',
      tree: treeB,
      items: [{ name: '我的第二个工作区', root: '/w/game-b', active: true, exists: true }],
    });
    reply('workspace.list', {
      active: '/w/game-b',
      recommended: '/repo/workspaces/默认',
      items: [{ name: '我的第二个工作区', root: '/w/game-b', active: true, exists: true }],
    });

    expect(await useLibraryStore.getState().addWorkspace('/w/game-b', '我的第二个工作区')).toBe(true);

    expect(calls('workspace.add')).toEqual([{ dir: '/w/game-b', name: '我的第二个工作区', create: true }]);
    expect(useLibraryStore.getState().workspaceRoot).toBe('/w/game-b');
    expect(useLibraryStore.getState().workflows).toEqual([]);
    expect(useLibraryStore.getState().workspaces.map((item) => item.name)).toEqual(['我的第二个工作区']);
    // 切了工作区 = 当前工作流也换了：会话层要回显
    expect(syncCurrentWorkflow).toHaveBeenCalled();
  });

  it('添加工作区不传名字：只发 dir + create（引擎退回目录名）', async () => {
    reply('workspace.add', { root: '/w/x', name: 'x', current: '', tree: TREE, items: [] });
    reply('workspace.list', { active: '/w/x', items: [] });

    await useLibraryStore.getState().addWorkspace('/w/x');

    expect(calls('workspace.add')).toEqual([{ dir: '/w/x', create: true }]);
  });

  it('添加工作区可以显式 create:false（不建目录）', async () => {
    reply('workspace.add', { root: '/w/x', name: 'x', current: '', tree: TREE, items: [] });
    reply('workspace.list', { active: '/w/x', items: [] });

    await useLibraryStore.getState().addWorkspace('/w/x', 'x', false);

    expect(calls('workspace.add')).toEqual([{ dir: '/w/x', name: 'x', create: false }]);
  });

  it('移除工作区：deleteFiles 透传；列表空了 workspaceRoot 也归零', async () => {
    reply('workspace.remove', {
      active: null,
      current: '',
      tree: { root: '', workflows: [] },
      removed: '/w/game-b',
      items: [],
    });
    reply('workspace.list', { active: null, recommended: '/repo/workspaces/默认', items: [] });

    expect(await useLibraryStore.getState().removeWorkspace('/w/game-b', true)).toBe(true);

    expect(calls('workspace.remove')).toEqual([{ dir: '/w/game-b', deleteFiles: true }]);
    expect(useLibraryStore.getState().workspaceRoot).toBe('');
    expect(useLibraryStore.getState().workspaces).toEqual([]);
  });

  it('只从列表移除（deleteFiles:false）也走同一个方法，只是参数不同', async () => {
    reply('workspace.remove', {
      active: WS,
      current: CURRENT,
      tree: TREE,
      removed: '',
      items: [{ name: '我的工作区', root: WS, active: true, exists: true }],
    });
    reply('workspace.list', {
      active: WS,
      recommended: '/repo/workspaces/默认',
      items: [{ name: '我的工作区', root: WS, active: true, exists: true }],
    });

    expect(await useLibraryStore.getState().removeWorkspace('/w/game-b', false)).toBe(true);
    expect(calls('workspace.remove')).toEqual([{ dir: '/w/game-b', deleteFiles: false }]);
  });

  it('写操作失败：错误留在 store 里，返回 false（面板照常显示那一行红字）', async () => {
    reply('workflow.create', null, '缺少参数 name');
    expect(await useLibraryStore.getState().createWorkflow('')).toBe(false);
    expect(useLibraryStore.getState().error).toBe('缺少参数 name');

    reply('workspace.add', null, '工作区必须是绝对路径: ./rel');
    expect(await useLibraryStore.getState().addWorkspace('./rel')).toBe(false);
    expect(useLibraryStore.getState().error).toBe('工作区必须是绝对路径: ./rel');
  });
});
