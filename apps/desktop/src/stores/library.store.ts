/**
 * 脚本库 store：管理"多张状态图"的列表与增删改。
 *
 * 数据模型（已拍板）：**一个目录 = 一个状态图**（`graph.json` + `templates/`），
 * 多张图 = 多个目录，互相隔离；库根默认是当前脚本目录的父目录（`projects/`）。
 * 引擎是唯一真源：每次增删改都由引擎返回刷新后的整份列表，这里只缓存与呈现。
 *
 * 切换脚本（点一下某一行）走 session store 的 `switchProject`：它会热重载所有已连接设备的状态图，
 * 这里不重复实现那套逻辑。
 */
import { create } from 'zustand';

import {
  devLog,
  projectCreate,
  projectDelete,
  projectDuplicate,
  projectList,
  projectRename,
  type ProjectSummary,
} from '@/lib/rpc';
import { useSessionStore } from '@/stores/session.store';

export interface LibraryState {
  readonly items: readonly ProjectSummary[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly create: (name: string) => Promise<boolean>;
  readonly duplicate: (dir: string, name: string) => Promise<boolean>;
  readonly rename: (dir: string, name: string) => Promise<boolean>;
  readonly remove: (dir: string) => Promise<boolean>;
}

/**
 * 引擎返回的东西一律当外部数据收窄：字段缺失/类型不对时退回空列表，
 * 不让界面崩在一句 `.length` 上（测试里 mock 的 invoke 就返回 `{}`）。
 */
function toItems(result: unknown): ProjectSummary[] {
  if (typeof result !== 'object' || result === null) {
    return [];
  }
  const items = (result as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return [];
  }
  return items.filter((item): item is ProjectSummary => typeof item === 'object' && item !== null);
}

export const useLibraryStore = create<LibraryState>()((set) => {
  /** 四个写操作共用：调引擎 → 用返回的整份列表刷新 → 让会话层同步"当前脚本"。 */
  const apply = async (
    task: () => Promise<{ items: ProjectSummary[]; current: string }>,
  ): Promise<boolean> => {
    try {
      const result = await task();
      set({ items: toItems(result), error: null });
      // 引擎侧已经切好脚本（create/duplicate 会切过去、rename/delete 会跟着调整），
      // 界面只需要回显 + 重新拉各设备的状态图
      await useSessionStore.getState().applyProjectChange();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      devLog(`脚本库操作失败: ${message}`);
      return false;
    }
  };

  return {
    items: [],
    loading: false,
    error: null,

    refresh: async () => {
      set({ loading: true });
      try {
        // 不传 base：引擎默认用"当前脚本目录的父目录"，避免前端自己拼路径（跨平台也不出错）
        const result = await projectList();
        set({ items: toItems(result), error: null });
      } catch (error) {
        // 引擎没起来是常态（首屏几秒），别把它当异常刷屏，只在面板里显示一行提示
        set({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        set({ loading: false });
      }
    },

    create: (name) => apply(() => projectCreate(name)),
    duplicate: (dir, name) => apply(() => projectDuplicate(dir, name)),
    rename: (dir, name) => apply(() => projectRename(dir, name)),
    remove: (dir) => apply(() => projectDelete(dir)),
  };
});

/** 当前脚本 root（顶栏/库面板要标出"是哪一份在跑"）。 */
export function currentScriptRoot(project: { root: string } | null): string {
  return project?.root ?? '';
}
