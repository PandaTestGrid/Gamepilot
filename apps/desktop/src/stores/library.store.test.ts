/**
 * 脚本库 store 的测试：多张状态图的列表、增删改、以及"引擎返回脏数据不能炸界面"。
 *
 * 这里 mock 掉 Tauri 的 invoke（也就是 RPC 出口），只验 store 自己的职责：
 * 调哪个方法、把返回值收窄成什么、失败怎么显示。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectSummary } from '@/lib/rpc';
import { useLibraryStore } from '@/stores/library.store';
import { useSessionStore } from '@/stores/session.store';

/** engine_rpc 的调用形状（method + params）；其它命令（dev_log 等）不关心参数。 */
type RpcCall = { method?: string; params?: Record<string, unknown> };

// 默认返回 Promise：真 invoke 永远是 Promise，mock 成 undefined 会让 devLog 里的 .catch 炸
const invoke = vi.fn((_cmd: string, _args?: RpcCall): Promise<unknown> => Promise.resolve({}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: RpcCall): Promise<unknown> => invoke(cmd, args),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const ITEMS: ProjectSummary[] = [
  { name: 'default', root: '/tmp/projects/default', nodes: 3, edges: 2, recognizers: 4, templates: 4 },
  { name: '日常任务', root: '/tmp/projects/日常任务', nodes: 1, edges: 0, recognizers: 1, templates: 1 },
];

/** 让下一次 engine_rpc 返回给定结果（或抛错）。 */
function reply(method: string, result: unknown, error?: string): void {
  invoke.mockImplementationOnce((cmd: string, args?: RpcCall) => {
    if (cmd !== 'engine_rpc' || args?.method !== method) {
      return Promise.resolve({});
    }
    return error ? Promise.reject(new Error(error)) : Promise.resolve(result);
  });
}

describe('脚本库 store', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((_cmd: string, _args?: RpcCall) => Promise.resolve({}));

    useLibraryStore.setState({ items: [], loading: false, error: null });
    useSessionStore.setState({ project: null, error: null, ready: {} });
  });

  it('刷新：把引擎给的列表收进 store', async () => {
    reply('project.list', { items: ITEMS });
    await useLibraryStore.getState().refresh();

    expect(useLibraryStore.getState().items).toHaveLength(2);
    expect(useLibraryStore.getState().items[1]?.name).toBe('日常任务');
    expect(useLibraryStore.getState().error).toBeNull();
  });

  it('引擎返回缺字段（例如测试里的空对象）时退回空列表，而不是让界面崩在 .length 上', async () => {
    reply('project.list', {});
    await useLibraryStore.getState().refresh();

    expect(useLibraryStore.getState().items).toEqual([]);
  });

  it('刷新失败：错误留在面板里，不抛给调用方', async () => {
    reply('project.list', null, '引擎未启动');
    await useLibraryStore.getState().refresh();

    expect(useLibraryStore.getState().error).toBe('引擎未启动');
    expect(useLibraryStore.getState().loading).toBe(false);
  });

  it('新建：调 project.create，并用引擎返回的整份列表刷新（它会自动切到新脚本）', async () => {
    reply('project.create', { items: ITEMS, current: '/tmp/projects/日常任务' });
    reply('project.get', { root: '/tmp/projects/日常任务' });

    const ok = await useLibraryStore.getState().create('日常任务');

    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('engine_rpc', {
      method: 'project.create',
      params: { name: '日常任务' },
    });
    expect(useLibraryStore.getState().items).toHaveLength(2);
    // 引擎侧已经切好脚本，界面回显"当前脚本"
    expect(useSessionStore.getState().project?.root).toBe('/tmp/projects/日常任务');
  });

  it('重命名与移除：走对应 RPC，失败时返回 false 并留下错误', async () => {
    reply('project.rename', { items: ITEMS, current: ITEMS[1]?.root });
    reply('project.get', { root: ITEMS[1]?.root });
    expect(await useLibraryStore.getState().rename('/tmp/projects/日常任务', '日常任务2')).toBe(true);

    reply('project.delete', null, '不允许删除 default');
    expect(await useLibraryStore.getState().remove('/tmp/projects/default')).toBe(false);
    expect(useLibraryStore.getState().error).toBe('不允许删除 default');
  });

  it('复制：把源目录与新名字一起发给引擎', async () => {
    reply('project.duplicate', { items: ITEMS, current: ITEMS[1]?.root });
    reply('project.get', { root: ITEMS[1]?.root });

    await useLibraryStore.getState().duplicate('/tmp/projects/default', 'default-副本');

    expect(invoke).toHaveBeenCalledWith('engine_rpc', {
      method: 'project.duplicate',
      params: { dir: '/tmp/projects/default', name: 'default-副本' },
    });
  });
});
