import { TriangleAlert, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';

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
  const [dismissed, setDismissed] = useState<string | null>(null);

  const message =
    sessionError ?? scanError ?? (engineStatus === 'error' ? `引擎启动失败：${engineInfo}` : null);

  if (!message || dismissed === message) {
    return null;
  }

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-failed/10 px-2 text-badge">
      <TriangleAlert className="size-3.5 shrink-0 text-failed" />
      <span className="min-w-0 flex-1 truncate text-failed">{message}</span>
      <button
        type="button"
        onClick={() => {
          setDismissed(message);
          clearError();
        }}
        className="flex items-center gap-1 text-dim hover:text-fg"
      >
        <X className="size-3" />
        知道了
      </button>
    </div>
  );
}
