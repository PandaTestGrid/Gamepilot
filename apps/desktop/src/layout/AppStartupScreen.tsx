/**
 * 主窗口启动门禁。
 *
 * HTML 中的冷启动层负责 WebView 加载前的第一帧；React 接管后仍停留在同一套启动
 * 画面，只有引擎完成握手才挂载工作台。当前启动链路只有引擎有可观察状态，因此这里
 * 只展示这一件事，避免把设备扫描和工作区恢复误画成已经在等待的步骤。
 */
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { AppMark } from '@/layout/AppMark';
import type { EngineStatus } from '@/stores/engine.store';

export interface AppStartupScreenProps {
  readonly status: EngineStatus;
  readonly info: string;
  readonly onRetry: () => void;
  readonly onRestart: () => void;
}

export function AppStartupScreen({ status, info, onRetry, onRestart }: AppStartupScreenProps): ReactNode {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const slow = status === 'connecting' && elapsedMs >= 15_000;

  return (
    <div
      data-testid="app-loading-screen"
      role="status"
      aria-live="polite"
      className="relative flex h-full items-center justify-center overflow-hidden bg-canvas p-4 text-fg"
    >
      <section className="max-h-full w-full max-w-[440px] overflow-y-auto rounded-xl border border-line bg-panel px-6 py-5">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-[42px] shrink-0 items-center justify-center rounded-[10px] bg-raised">
            <AppMark size={34} monochrome />
          </span>
          <div className="min-w-0">
            <div className="font-serif text-[22px] leading-none tracking-[-0.025em] text-brand">GamePilot</div>
            <div className="mt-1 font-mono text-[9px] tracking-[0.12em] text-dim">FIELDNOTES / AUTOMATION</div>
          </div>
          <span className="ml-auto font-mono text-[10px] text-faint">{formatElapsed(elapsedMs)}</span>
        </div>

        <div className="mt-5 border-t border-line pt-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-[17px] font-semibold tracking-[-0.02em] text-fg">
                {status === 'error' ? '引擎启动失败' : '正在启动引擎'}
              </h1>
              <p className="mt-1 text-[12px] leading-5 text-dim">
                {status === 'error' ? '引擎未就绪，工作台尚未加载。' : '工作台会在引擎启动后自动进入。'}
              </p>
            </div>
            {status === 'error' ? (
              <TriangleAlert className="size-4 shrink-0 text-failed" aria-hidden="true" />
            ) : (
              <span className="relative h-1 w-16 shrink-0 overflow-hidden rounded-full bg-raised" aria-hidden="true">
                <span className="absolute inset-y-0 left-0 w-7 animate-[startup-progress_1.2s_cubic-bezier(0.16,1,0.3,1)_infinite] rounded-full bg-brand motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-60" />
              </span>
            )}
          </div>

          {status === 'error' && (
            <div className="mt-4 rounded-md border border-failed/30 bg-failed/[0.06] p-3 text-[11px] leading-5 text-failed">
              {info || '引擎没有返回可用状态。'}
            </div>
          )}

          {slow && (
            <p className="mt-4 text-[11px] leading-5 text-pending">
              首次启动需要解压运行时，可能被安全软件扫描，请再稍等。
            </p>
          )}

          {status === 'error' && (
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={onRetry}
                className="flex items-center gap-1.5 rounded-sm border border-brand/50 px-3 py-1.5 text-[11px] text-brand hover:bg-brand/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                <RefreshCw className="size-3" /> 重试
              </button>
              <button
                type="button"
                onClick={onRestart}
                className="rounded-sm border border-line px-3 py-1.5 text-[11px] text-dim hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                重启引擎
              </button>
            </div>
          )}

          {slow && (
            <button
              type="button"
              onClick={onRestart}
              className="mt-4 rounded-sm border border-line px-3 py-1.5 text-[11px] text-dim hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              卡住了？重启引擎
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
