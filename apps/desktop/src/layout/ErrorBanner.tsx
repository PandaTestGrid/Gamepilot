import { RefreshCw, TriangleAlert, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { isUnknownMethodError, staleEngineHint } from '@/lib/engine-methods';
import { useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
import { useSessionStore } from '@/stores/session.store';

/**
 * 错误条：把"出了什么问题"直接摆在界面上。
 *
 * 之前这些错误只躺在 store 里没人显示，用户看到的就是"点了没反应"——
 * 连接失败、录制失败、运行失败、引擎起不来，全部走这一条。
 */
export function ErrorBanner(): ReactNode {
  const sessionError = useSessionStore((state) => state.error);
  const clearError = useSessionStore((state) => state.clearError);
  const scanError = useDeviceStore((state) => state.scanError);
  const engineStatus = useEngineStore((state) => state.status);
  const engineInfo = useEngineStore((state) => state.info);
  const missingMethods = useEngineStore((state) => state.missingMethods);
  const restartEngine = useEngineStore((state) => state.restart);
  const [dismissed, setDismissed] = useState<string | null>(null);

  /*
   * 三种情况要分开说，因为"怎么修"不一样：
   *   1. 引擎是旧进程（方法表缺东西，或某个调用报了 -32601）→ 重启引擎，一键修
   *   2. 引擎起不来 → 重试（可能是依赖没装，文案里已经写了怎么办）
   *   3. 业务错误（连接/录制/运行失败）→ 原样显示
   */
  const staleEngine = missingMethods.length > 0 || isUnknownMethodError(sessionError);
  const message = staleEngine
    ? missingMethods.length > 0
      ? staleEngineHint(missingMethods)
      : `${sessionError ?? ''}（引擎不认识这个方法：它多半是应用启动时拉起的旧进程）`
    : (sessionError ?? scanError ?? (engineStatus === 'error' ? `引擎启动失败：${engineInfo}` : null));

  if (!message || dismissed === message) {
    return null;
  }

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-failed/10 px-2 text-badge">
      <TriangleAlert className="size-3.5 shrink-0 text-failed" />
      <span className="min-w-0 flex-1 truncate text-failed">{message}</span>

      {(staleEngine || engineStatus === 'error') && (
        <button
          type="button"
          onClick={() => {
            setDismissed(message);
            clearError();
            void restartEngine();
          }}
          className="flex shrink-0 items-center gap-1 rounded-sm border border-failed/50 px-1.5 py-0.5 text-failed hover:bg-raised"
          title="停掉正在跑的引擎进程、拉起新的（会断开当前设备连接，重连即可）"
        >
          <RefreshCw className="size-3" />
          重启引擎
        </button>
      )}

      <button
        type="button"
        onClick={() => {
          setDismissed(message);
          clearError();
        }}
        className="flex shrink-0 items-center gap-1 text-dim hover:text-fg"
      >
        <X className="size-3" />
        知道了
      </button>
    </div>
  );
}
