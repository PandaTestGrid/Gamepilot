/**
 * 工作区 store：**工作区（= 项目，同一个东西）› 工作流**（v4 只有两层）。
 *
 * 一个工作区 = 用户选的一个文件夹（可以有多个，列表按最近使用排序，名字是用户输的）；
 * 一个工作流 = 一张流程图 = 一个含 `graph.json` 的直接子目录。
 * 数据模型与 RPC 见 `docs/WORKSPACE-CONTRACT.md` **v4**。
 *
 * 引擎是唯一真源：
 *   - `workspace.tree` → 当前工作区里的所有工作流（树、面板、欢迎卡片都渲染它）；
 *   - `workspace.list` → 最近用过的工作区列表（面板那个浮层用它）；
 *   - `workflow.*` → 回**当前工作区**刷新后的工作流列表；
 *   - `workspace.add/remove` → 回列表 + 新工作区的整棵树。
 * 这里不做"本地乐观更新"，避免和磁盘上的真实情况不一致。
 *
 * 切换工作流（点树里的工作流行）走 session store 的 `switchProject`：它会热重载所有已连接设备的状态图，
 * 这里不重复实现；写操作之后统一用 `applyProjectChange` 回显"引擎已经切好了"。
 */
import { create } from 'zustand';

import {
  toMutationTree,
  toTree,
  toWorkflowItems,
  toWorkspaceList,
  toWorkspaces,
} from '@/features/library/workspace-tree';
import {
  devLog,
  workflowCreate,
  workflowDelete,
  workflowDuplicate,
  workflowRename,
  workspaceAdd,
  workspaceList,
  workspaceRemove,
  workspaceTree,
  type WorkspaceSummary,
  type WorkflowSummary,
} from '@/lib/rpc';
import { useSessionStore } from '@/stores/session.store';

export interface LibraryState {
  /** **当前工作区**根目录（标题行显示它的 basename；空串 = 还没选过工作区）。 */
  readonly workspaceRoot: string;
  /** 当前工作区里的所有工作流（树/面板的唯一数据源，每项带 `modified`）。 */
  readonly workflows: readonly WorkflowSummary[];
  /** 最近用过的工作区（面板列表；按最近使用排序）。 */
  readonly workspaces: readonly WorkspaceSummary[];
  /** 系统推荐目录（面板底部「默认工作区」用它）。 */
  readonly recommendedWorkspace: string;
  /** 全局回收站绝对路径（引擎给了就显示绝对路径；拿不到时界面降级说明）。 */
  readonly trashRoot: string;
  readonly loading: boolean;
  readonly error: string | null;
  /** 重新拉当前工作区的整棵树（挂载、引擎 ready、切工作流后都要拉）。 */
  readonly refresh: () => Promise<void>;
  /** 重新拉工作区列表（打开面板时拉；`workspace.add/remove` 之后也会拉）。 */
  readonly refreshWorkspaces: () => Promise<void>;
  /** 新建工作流并切过去（**名字必填**：界面弹输入框，v4 §2.2）。 */
  readonly createWorkflow: (name: string) => Promise<boolean>;
  readonly renameWorkflow: (dir: string, name: string) => Promise<boolean>;
  /** 复制（`name` 省略 = 引擎自动「<原名>-副本」）。 */
  readonly duplicateWorkflow: (dir: string, name?: string) => Promise<boolean>;
  readonly removeWorkflow: (dir: string) => Promise<boolean>;
  /** 登记工作区并切过去（`name` = 用户输的名字，省略退回目录名；同一个 dir 再加一次是幂等的）。 */
  readonly addWorkspace: (dir: string, name?: string, create?: boolean) => Promise<boolean>;
  /**
   * 移除一个工作区：`deleteFiles` 默认 true = 整个目录**移到全局回收站**（可恢复，不是真删除）；
   * false = 只从列表移除，磁盘一个字节不动。
   */
  readonly removeWorkspace: (dir: string, deleteFiles: boolean) => Promise<boolean>;
}

export const useLibraryStore = create<LibraryState>()((set, get) => {
  /** 写入树（工作区的根 + 里面的工作流）。 */
  const applyTree = (tree: ReturnType<typeof toTree>): void => {
    set({ workspaceRoot: tree.root, workflows: tree.workflows, error: null });
  };

  const fail = (error: unknown, what: string): false => {
    const message = error instanceof Error ? error.message : String(error);
    set({ error: message });
    devLog(`${what}: ${message}`);
    return false;
  };

  /**
   * workflow.*：引擎回了"当前工作区刷新后的工作流列表"，先用它更新，
   * 再拉一次树（`modified` 之类的字段要跟着变）并让会话层回显当前工作流。
   */
  const applyWorkflow = async (task: () => Promise<unknown>, what: string): Promise<boolean> => {
    try {
      set({ workflows: toWorkflowItems(await task()), error: null });
      // 引擎侧已经切好工作流（create/duplicate 会切过去、rename/delete 会跟着调整），
      // 界面只需要回显 + 重新拉各设备的状态图
      await useSessionStore.getState().applyProjectChange();
      await get().refresh();
      return true;
    } catch (error) {
      return fail(error, what);
    }
  };

  /** workspace.add / workspace.remove：回整棵树 + 工作区列表（三个方法 items 同形状）。 */
  const applyWorkspace = async (task: () => Promise<unknown>, what: string): Promise<boolean> => {
    try {
      const result = await task();
      applyTree(toMutationTree(result));
      set({ workspaces: toWorkspaces(result) });
      // 引擎侧已经切好当前工作流：界面回显 + 重拉各设备的状态图
      await useSessionStore.getState().applyProjectChange();
      // 排序/active 标记/名字以引擎为准（add 会把目录提到最前、remove 会换 active）
      await get().refreshWorkspaces();
      return true;
    } catch (error) {
      return fail(error, what);
    }
  };

  return {
    workspaceRoot: '',
    workflows: [],
    workspaces: [],
    recommendedWorkspace: '',
    trashRoot: '',
    loading: false,
    error: null,

    refresh: async () => {
      set({ loading: true });
      try {
        applyTree(toTree(await workspaceTree()));
      } catch (error) {
        // 引擎没起来是常态（首屏几秒），别把它当异常刷屏，只在面板里显示一行提示
        set({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        set({ loading: false });
      }
    },

    refreshWorkspaces: async () => {
      try {
        const result = toWorkspaceList(await workspaceList());
        set({
          workspaces: result.items,
          recommendedWorkspace: result.recommended,
          trashRoot: result.trashRoot,
          error: null,
        });
      } catch (error) {
        // 面板里显示一行提示就够了（和 refresh 一样，引擎没起来不算异常）
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    createWorkflow: (name) => applyWorkflow(() => workflowCreate(name), '新建工作流失败'),
    renameWorkflow: (dir, name) => applyWorkflow(() => workflowRename(dir, name), '工作流改名失败'),
    duplicateWorkflow: (dir, name) => applyWorkflow(() => workflowDuplicate(dir, name), '复制工作流失败'),
    removeWorkflow: (dir) => applyWorkflow(() => workflowDelete(dir), '删除工作流失败'),
    addWorkspace: (dir, name, create = true) =>
      applyWorkspace(() => workspaceAdd(dir, name, create), '添加工作区失败'),
    removeWorkspace: (dir, deleteFiles) =>
      applyWorkspace(() => workspaceRemove(dir, deleteFiles), '移除工作区失败'),
  };
});
