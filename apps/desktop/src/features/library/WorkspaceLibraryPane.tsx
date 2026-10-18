/**
 * 右栏「工作区」Tab 的外壳（v4：工作区 › 工作流）。
 * 列表本体是 `WorkspacePanel`；数据在 `stores/library.store.ts`。
 */
import { type ReactNode, useEffect } from 'react';

import { WorkspacePanel } from '@/features/library/WorkspacePanel';
import { isUnknownMethodError } from '@/lib/engine-methods';
import { useEngineStore } from '@/stores/engine.store';
import { useLibraryStore } from '@/stores/library.store';
import { useSessionStore } from '@/stores/session.store';
export function WorkspaceLibraryPane(): ReactNode {
  const error = useLibraryStore((state) => state.error);
  const refresh = useLibraryStore((state) => state.refresh);
  const refreshWorkspaces = useLibraryStore((state) => state.refreshWorkspaces);

  const currentRoot = useSessionStore((state) => state.currentWorkflow?.root ?? '');
  const engineStatus = useEngineStore((state) => state.status);
  const missingMethods = useEngineStore((state) => state.missingMethods);
  const restartEngine = useEngineStore((state) => state.restart);
  const staleEngine = missingMethods.length > 0 || isUnknownMethodError(error);

  useEffect(() => {
    if (engineStatus === 'ready') {
      void (async () => {
        await Promise.all([refresh(), refreshWorkspaces()]);
        useLibraryStore.getState().reconcileOpenWorkflowTabs();
      })();
    }
  }, [engineStatus, refresh, refreshWorkspaces]);

  useEffect(() => {
    void refresh();
  }, [currentRoot, refresh]);

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
