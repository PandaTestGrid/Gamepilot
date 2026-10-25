import { Download, RefreshCw, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import type { Update } from '@tauri-apps/plugin-updater';

import { devLog } from '@/lib/rpc';

/**
 * 发布版自动更新。
 *
 * 只在真正的 Tauri 壳里检查：`tauri dev` / 浏览器预览 / Vitest 都没有更新源，
 * 失败也不能影响启动（最多少一条更新提示）。
 *
 * 检查到新版本后不自动下载：用户需要确认，避免在打本/跑工作流时突然重启。
 */
export function UpdateBanner(): ReactNode {
  const [update, setUpdate] = useState<Update | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checked = useRef(false);

  useEffect(() => {
    if (checked.current || import.meta.env.DEV || !('__TAURI_INTERNALS__' in window)) {
      return;
    }
    checked.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const found = await check();
        if (!cancelled && found) {
          setUpdate(found);
        }
      } catch (cause) {
        // 离线、没有发布更新源、签名不匹配：都只记开发日志，不打扰用户。
        devLog(`更新检查跳过: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!update || dismissed) {
    return null;
  }

  const install = async (): Promise<void> => {
    setInstalling(true);
    setError(null);
    setProgress(null);
    try {
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
          received = 0;
          setProgress(0);
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          setProgress(total > 0 ? Math.min(100, (received / total) * 100) : null);
        } else if (event.event === 'Finished') {
          setProgress(100);
        }
      });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (cause) {
      setInstalling(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-[80] flex justify-center px-3">
      <div className="pointer-events-auto flex w-full max-w-[560px] items-start gap-3 rounded-lg border border-line bg-panel/95 p-3 text-fg shadow-2xl backdrop-blur">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-brand/15 text-brand">
          <Download className="size-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold">发现新版本 v{update.version}</span>
            <span className="text-badge text-dim">当前 v{update.currentVersion}</span>
          </div>
          <p className="mt-1 text-badge leading-relaxed text-dim">
            下载安装完成后会自动重启；正在运行的工作流会被中断，建议先收尾。
          </p>
          {update.body ? (
            <p className="mt-1 line-clamp-2 text-badge leading-relaxed text-dim/80">{update.body}</p>
          ) : null}

          {installing ? (
            <div className="mt-2">
              <div className="h-1 overflow-hidden rounded-full bg-raised">
                <div
                  className="h-full bg-brand transition-[width] duration-300"
                  style={{ width: progress === null ? '35%' : `${progress}%` }}
                />
              </div>
              <p className="mt-1 text-badge text-dim">
                {progress === null ? '正在下载…' : `正在下载 ${Math.round(progress)}%`}
              </p>
            </div>
          ) : null}

          {error ? <p className="mt-1.5 text-badge text-failed">更新失败：{error}</p> : null}
        </div>

        <div className="flex shrink-0 flex-col gap-1.5">
          <button
            type="button"
            disabled={installing}
            onClick={() => void install()}
            className="flex items-center justify-center gap-1.5 rounded-sm bg-brand px-2.5 py-1.5 text-badge font-medium text-canvas hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
          >
            {installing ? <RefreshCw className="size-3 animate-spin" /> : <Download className="size-3" />}
            {installing ? '下载中' : '下载并安装'}
          </button>
          <button
            type="button"
            disabled={installing}
            onClick={() => setDismissed(true)}
            className="flex items-center justify-center gap-1 text-badge text-dim hover:text-fg disabled:opacity-50"
          >
            <X className="size-3" />
            稍后
          </button>
        </div>
      </div>
    </div>
  );
}
