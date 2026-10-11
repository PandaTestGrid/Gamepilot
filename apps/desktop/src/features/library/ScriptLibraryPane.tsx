/**
 * 右栏第一个 Tab 的内容：**工作区区域**（v4：工作区 › 工作流，只有一层列表）。
 *
 * 这个区域**就是**用户要的那一屏（照参考截图）：
 *   头部「工作区」+ 🔍 ⚙ ＋ ── 下面列工作区，当前工作区展开显示它的工作流
 *   ── 底部固定「默认工作区」。
 *
 * 历史坑（别再犯）：这里曾经是「树 + 一个浮层面板」两份东西，都在列同一批目录，
 * 用户看到两份不一样的真相；现在**只有一套**列表，就是 `WorkspacePanel` ——
 * 它不是弹框、不是浮层，而是这个 Tab 的本体内容。
 *
 * 这个组件只负责外壳：错误行（含"引擎是旧进程 → 重启引擎"）、当前工作流回显、
 * 以及"引擎后起来时再拉一次"。数据与操作全在 `stores/library.store.ts`。
 */
import { type ReactNode, useEffect } from 'react';

import { WorkspacePanel } from '@/features/library/WorkspacePanel';
import { isUnknownMethodError } from '@/lib/engine-methods';
import { useEngineStore } from '@/stores/engine.store';
import { useLibraryStore } from '@/stores/library.store';
import { useSessionStore } from '@/stores/session.store';

export function ScriptLibraryPane(): ReactNode {
  const error = useLibraryStore((state) => state.error);
  const refresh = useLibraryStore((state) => state.refresh);
  const refreshWorkspaces = useLibraryStore((state) => state.refreshWorkspaces);

  const currentRoot = useSessionStore((state) => state.project?.root ?? '');
  const engineStatus = useEngineStore((state) => state.status);
  const missingMethods = useEngineStore((state) => state.missingMethods);
  const restartEngine = useEngineStore((state) => state.restart);
  // 引擎是旧进程：错误里会出现 -32601 / 未知方法，或缺方法表校验没通过
  const staleEngine = missingMethods.length > 0 || isUnknownMethodError(error);

  // 挂载即拉一次；引擎是后起来的（首次启动 / 点了重试），ready 时再拉一次 ——
  // 否则首屏那次失败会让列表一直空着，用户只能自己去点「刷新」
  useEffect(() => {
    if (engineStatus === 'ready') {
      void refresh();
      // 工作区名字只在 workspace.list 里（列表要显示用户输的名字）
      void refreshWorkspaces();
    }
  }, [engineStatus, refresh, refreshWorkspaces]);

  // 换工作区/切工作流之后列表要跟着换（引擎是唯一真源，重拉一次最稳）
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
          {/* 最常见的原因：引擎是应用启动时拉起的旧进程（不认识 workflow.create）→ 一键重启 */}
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
        当前：<span className="text-dim">{currentRoot || '未选择工作流'}</span>
        <div className="mt-0.5">
          删除是移到工作区根的 .trash/（可恢复）；切工作流会热重载所有已连接设备的状态图。
        </div>
      </div>
    </div>
  );
}
