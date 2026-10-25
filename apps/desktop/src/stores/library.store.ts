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
 * 切换工作流走 `session.switchWorkflow`；写操作之后用 `syncCurrentWorkflow` 回显。
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
  graphGet,
  graphSave,
  workflowCreate,
  workflowDelete,
  workflowDuplicate,
  workflowRename,
  workspaceAdd,
  workspaceList,
  workspaceRemove,
  workspaceTree,
  type GraphPayload,
  type WorkspaceSummary,
  type WorkflowSummary,
} from '@/lib/rpc';
import {
  clearStoredPositionsForRoot,
  clearStoredPositionsUnder,
  copyStoredPositions,
  migrateStoredPositions,
} from '@/lib/node-positions';
import { useEngineStore } from '@/stores/engine.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

export interface LibraryState {
  /** **当前工作区**根目录（标题行显示它的 basename；空串 = 还没选过工作区）。 */
  readonly workspaceRoot: string;
  /** 当前工作区里的所有工作流（树/面板的唯一数据源，每项带 `modified`）。 */
  readonly workflows: readonly WorkflowSummary[];
  /** 最近用过的工作区（面板列表；按最近使用排序）。 */
  readonly workspaces: readonly WorkspaceSummary[];
  /** 系统推荐目录（面板底部「默认工作区」用它）。 */
  readonly recommendedWorkspace: string;
  readonly loading: boolean;
  readonly error: string | null;
  /** 重新拉当前工作区的整棵树（挂载、引擎 ready、切工作流后都要拉）。 */
  readonly refresh: () => Promise<void>;
  /** 重新拉工作区列表（打开面板时拉；`workspace.add/remove` 之后也会拉）。 */
  readonly refreshWorkspaces: () => Promise<void>;
  /** 按当前工作区树修剪/清空顶部工作流标签（与右栏列表一致）。 */
  readonly reconcileOpenWorkflowTabs: () => void;
  /** 新建工作流并切过去（**名字必填**：界面弹输入框，v4 §2.2）。 */
  readonly createWorkflow: (name: string, description?: string) => Promise<boolean>;
  /** 导入一份 graph.json 为新工作流（在**当前工作区**下建目录，然后写图并切过去）。 */
  readonly importWorkflow: (name: string, graph: GraphPayload) => Promise<boolean>;
  readonly renameWorkflow: (dir: string, name: string) => Promise<boolean>;
  /** 复制（`name` 省略 = 引擎自动「<原名>-副本」）。 */
  readonly duplicateWorkflow: (dir: string, name?: string) => Promise<boolean>;
  readonly removeWorkflow: (dir: string) => Promise<boolean>;
  /** 登记工作区并切过去（`name` = 用户输的名字，省略退回目录名；同一个 dir 再加一次是幂等的）。 */
  readonly addWorkspace: (dir: string, name?: string, create?: boolean) => Promise<boolean>;
  /**
   * 移除一个工作区：`deleteFiles` 默认 true = **真删除**（连目录里的工作流，不可恢复）；
   * false = 只从列表移除，磁盘一个字节不动。
   */
  readonly removeWorkspace: (dir: string, deleteFiles: boolean) => Promise<boolean>;
}

export const useLibraryStore = create<LibraryState>()((set, get) => {
  /** 写入树（工作区的根 + 里面的工作流）。 */
  const applyTree = (tree: ReturnType<typeof toTree>): void => {
    set({ workspaceRoot: tree.root, workflows: tree.workflows, error: null });
  };

  /**
   * 引擎还没起来时的失败**不进错误行**：首屏几秒里 RPC 必然被拒，
   * 把「引擎未启动，请先调用 engine_start」挂在工作区面板上纯属噪音（而且它不会自己消失，
   * 因为失败请求可能在引擎就绪之后才落地）。引擎就绪时那次刷新会把列表补上。
   */
  const reportFailure = (message: string): void => {
    if (useEngineStore.getState().status !== 'ready' || message.includes('引擎没在运行')) {
      devLog(`工作区暂时读不到（引擎未就绪）: ${message}`);
      return;
    }
    set({ error: message });
  };

  const fail = (error: unknown, what: string): false => {
    const message = error instanceof Error ? error.message : String(error);
    reportFailure(message);
    devLog(`${what}: ${message}`);
    return false;
  };

  /**
   * workflow.*：引擎回了"当前工作区刷新后的工作流列表"，先用它更新，
   * 再拉一次树（`modified` 之类的字段要跟着变）并让会话层回显当前工作流。
   */
  const reconcileOpenWorkflowTabs = (): void => {
    const { workspaces, workflows, workspaceRoot } = get();
    // 启动时 `workspace.tree` 往往先于 `workspace.list` 回来：那一刻列表还是空的，
    // 不能因此把 localStorage 里的标签清掉（「重启后标签全没了」就是这么来的）。
    // 只有**确实没有任何工作区**时才清；拿不到树根时什么都不做。
    if (!workspaceRoot) {
      if (workspaces.length === 0) {
        useUiStore.getState().clearOpenWorkflowTabs();
        useGraphStore.getState().pruneWorkflowSnapshots([]);
      }
      return;
    }
    if (workflows.length === 0) {
      useUiStore.getState().clearOpenWorkflowTabs();
      useGraphStore.getState().pruneWorkflowSnapshots([]);
      return;
    }
    const validRoots = workflows.map((item) => item.root);
    // 只认树里真实存在的工作流；不要把引擎里过期的 current 路径算进去（否则会留下 asdasd 这种 Tab）
    useUiStore.getState().pruneOpenWorkflowTabs(validRoots);
    useGraphStore.getState().pruneWorkflowSnapshots(validRoots);
  };

  const applyWorkflow = async (task: () => Promise<unknown>, what: string): Promise<boolean> => {
    try {
      set({ workflows: toWorkflowItems(await task()), error: null });
      // 引擎侧已经切好工作流（create/duplicate 会切过去、rename/delete 会跟着调整），
      // 界面只需要回显 + 重新拉各设备的状态图
      await useSessionStore.getState().syncCurrentWorkflow();
      await get().refresh();
      reconcileOpenWorkflowTabs();
      return true;
    } catch (error) {
      return fail(error, what);
    }
  };

  /** workspace.add / workspace.remove：回整棵树 + 工作区列表（三个方法 items 同形状）。 */
  const applyWorkspace = async (task: () => Promise<unknown>, what: string): Promise<boolean> => {
    const session = useSessionStore.getState();
    session.enterWorkflowSwitch();
    try {
      const result = await task();
      applyTree(toMutationTree(result));
      set({ workspaces: toWorkspaces(result) });
      // 引擎侧已经切好当前工作流：界面回显 + 重拉各设备的状态图
      await useSessionStore.getState().syncCurrentWorkflow();
      // 排序/active 标记/名字以引擎为准（add 会把目录提到最前、remove 会换 active）
      await get().refreshWorkspaces();
      reconcileOpenWorkflowTabs();
      return true;
    } catch (error) {
      return fail(error, what);
    } finally {
      useSessionStore.getState().leaveWorkflowSwitch();
    }
  };

  return {
    workspaceRoot: '',
    workflows: [],
    workspaces: [],
    recommendedWorkspace: '',
    loading: false,
    error: null,

    refresh: async () => {
      set({ loading: true });
      try {
        applyTree(toTree(await workspaceTree()));
        reconcileOpenWorkflowTabs();
      } catch (error) {
        // 引擎没起来是常态（首屏几秒），别把它当异常刷屏，只在面板里显示一行提示
        reportFailure(error instanceof Error ? error.message : String(error));
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
          error: null,
        });
      } catch (error) {
        // 面板里显示一行提示就够了（和 refresh 一样，引擎没起来不算异常）
        reportFailure(error instanceof Error ? error.message : String(error));
      }
    },

    importWorkflow: async (name, graph) => {
      let created = '';
      try {
        const result = await workflowCreate(name);
        created = result.created;
        set({ workflows: toWorkflowItems(result), error: null });
        await useSessionStore.getState().syncCurrentWorkflow();
        await graphSave(graph);
        await get().refresh();
        await useSessionStore.getState().syncCurrentWorkflow();
        reconcileOpenWorkflowTabs();
        return true;
      } catch (error) {
        // 建完目录但图写不进去：把刚建的空工作流删掉，别留一个打不开的壳
        if (created) {
          try {
            await workflowDelete(created);
            await useSessionStore.getState().syncCurrentWorkflow();
            await get().refresh();
          } catch {
            // 清理失败也不掩盖原始错误
          }
        }
        return fail(error, '导入工作流失败');
      }
    },

    createWorkflow: async (name, description) => {
      const ok = await applyWorkflow(() => workflowCreate(name), '新建工作流失败');
      const note = description?.trim();
      if (!ok || !note) {
        return ok;
      }
      try {
        const raw = await graphGet();
        await graphSave({
          ...raw,
          defaults: { ...raw.defaults, workflow_note: note },
        });
        await useGraphStore.getState().refresh();
      } catch (error) {
        return fail(error, '保存工作流备注失败');
      }
      return true;
    },
    renameWorkflow: (dir, name) =>
      applyWorkflow(async () => {
        const result = await workflowRename(dir, name);
        if (result?.root) {
          migrateStoredPositions(dir, result.root);
          useUiStore.getState().renameOpenWorkflowTab(dir, result.root);
          useGraphStore.getState().renameWorkflowSnapshot(dir, result.root);
        }
        return result;
      }, '工作流改名失败'),
    duplicateWorkflow: (dir, name) =>
      applyWorkflow(async () => {
        const result = await workflowDuplicate(dir, name);
        if (result?.created) {
          copyStoredPositions(dir, result.created);
        }
        return result;
      }, '复制工作流失败'),
    removeWorkflow: async (dir) => {
      const ok = await applyWorkflow(() => workflowDelete(dir), '删除工作流失败');
      if (ok) {
        clearStoredPositionsForRoot(dir);
        useGraphStore.getState().removeWorkflowSnapshot(dir);
        useUiStore.getState().closeWorkflowTab(dir);
        reconcileOpenWorkflowTabs();
      }
      return ok;
    },

    reconcileOpenWorkflowTabs,
    addWorkspace: (dir, name, create = true) =>
      applyWorkspace(() => workspaceAdd(dir, name, create), '添加工作区失败'),
    removeWorkspace: async (dir, deleteFiles) => {
      const ok = await applyWorkspace(() => workspaceRemove(dir, deleteFiles), '移除工作区失败');
      if (ok && deleteFiles) {
        clearStoredPositionsUnder(dir);
      }
      return ok;
    },
  };
});
