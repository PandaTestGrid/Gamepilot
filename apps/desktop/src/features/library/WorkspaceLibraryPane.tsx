/**
 * 右栏「工作区」Tab 的外壳（v4：工作区 › 工作流）。
 * 列表本体是 `WorkspacePanel`；数据在 `stores/library.store.ts`。
 */
import { type ReactNode, useEffect, useRef } from 'react';

import { WorkspacePanel } from '@/features/library/WorkspacePanel';
import { isUnknownMethodError } from '@/lib/engine-methods';
import { devLog } from '@/lib/rpc';
import { useEngineStore } from '@/stores/engine.store';
import { useLibraryStore } from '@/stores/library.store';
import { useSessionStore } from '@/stores/session.store';
export function WorkspaceLibraryPane(): ReactNode {
  const error = useLibraryStore((state) => state.error);
  const refresh = useLibraryStore((state) => state.refresh);
  const refreshWorkspaces = useLibraryStore((state) => state.refreshWorkspaces);
  const addWorkspace = useLibraryStore((state) => state.addWorkspace);
  const reconcileOpenWorkflowTabs = useLibraryStore((state) => state.reconcileOpenWorkflowTabs);
  const bootstrappedDefaultRef = useRef(false);

  const currentRoot = useSessionStore((state) => state.currentWorkflow?.root ?? '');
  const engineStatus = useEngineStore((state) => state.status);
  const missingMethods = useEngineStore((state) => state.missingMethods);
  const restartEngine = useEngineStore((state) => state.restart);
  const staleEngine = missingMethods.length > 0 || isUnknownMethodError(error);

  useEffect(() => {
    if (engineStatus !== 'ready') {
      return;
    }
    void (async () => {
      await Promise.all([refresh(), refreshWorkspaces()]);
      const lib = useLibraryStore.getState();
      // 一行诊断日志：用户报"没有工作区"时，看这条就知道是列表空、还是引擎报错
      devLog(
        `工作区加载：${lib.workspaces.length} 个工作区 · 当前根 ${lib.workspaceRoot || '(空)'} · ` +
          `${lib.workflows.length} 个工作流${lib.error ? ` · 错误 ${lib.error}` : ''}`,
      );
      if (lib.error) {
        return;
      }
      if (
        !bootstrappedDefaultRef.current &&
        lib.workspaces.length === 0 &&
        !lib.workspaceRoot &&
        lib.recommendedWorkspace
      ) {
        // 第一次启动、一个工作区都没有：直接把推荐目录登记成「默认工作区」，开箱就能用
        bootstrappedDefaultRef.current = true;
        devLog(`没有工作区，自动创建默认工作区：${lib.recommendedWorkspace}`);
        await addWorkspace(lib.recommendedWorkspace, '默认工作区', true);
        return;
      }
      reconcileOpenWorkflowTabs();
    })();
  }, [engineStatus, refresh, refreshWorkspaces, addWorkspace, reconcileOpenWorkflowTabs]);

  useEffect(() => {
    if (engineStatus !== 'ready') {
      return;
    }
    void refresh();
  }, [currentRoot, engineStatus, refresh]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <div className="shrink-0 border-b border-line px-2 py-1 text-badge text-failed">
          读不到工作区：{error}
          <button type="button" className="ml-2 text-dim hover:text-fg" onClick={() => void refresh()}>
            重试
          </button>
          {staleEngine && (
            <button
              type="button"
              className="ml-2 text-failed hover:text-fg"
              title="停掉正在跑的引擎进程、拉起新的（会断开当前设备连接，重连即可）"
              onClick={() => void restartEngine()}
            >
              重启引擎
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <WorkspacePanel />
      </div>

      <div className="shrink-0 border-t border-line px-2 py-1 text-badge text-faint">
        当前工作流：<span className="text-dim">{currentRoot || '未选择'}</span>
      </div>
    </div>
  );
}
