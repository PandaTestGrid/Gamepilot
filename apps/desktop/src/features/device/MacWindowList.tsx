/**
 * 本机窗口（macOS）选择器：弹层「本机窗口」Tab 的内容。
 *
 * 之前它塞在弹层底部一行 28px 里，只能看几个窗口、还得先展开折叠区 —— 交互最差的一处。
 * 现在它占整个列表区：
 *   - 打开 Tab 就枚举窗口（一次 `mac.windows`），带**搜索**（App 名 / 标题 / 句柄都能搜）；
 *   - 行显示 `#句柄 App · 标题  宽x高`，点一下就连；**已连上的窗口**标出来（点它=切换过去）；
 *   - 没有「屏幕录制」权限时直接说明"抓到的是空白"并给出系统设置路径；
 *   - 手输句柄仍然保留（窗口列表有时抓不到某些 App）。
 */
import { RefreshCw, Search } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import { macWindows, type MacWindowInfo } from '@/lib/rpc';

export interface MacWindowListProps {
  /** 已经连上的窗口句柄（id 形如 macos:89）→ 用来标"已连接" */
  readonly connected: ReadonlySet<number>;
  readonly onConnect: (handle: number | string) => void;
  readonly onActivate: (handle: number) => void;
}

export function MacWindowList({ connected, onConnect, onActivate }: MacWindowListProps): ReactNode {
  const [windows, setWindows] = useState<MacWindowInfo[]>([]);
  const [allowed, setAllowed] = useState(true);
  const [platform, setPlatform] = useState('darwin');
  const [note, setNote] = useState('正在枚举窗口…');
  // 初次渲染就是"加载中"：避免在 effect 里同步 setState（会触发级联渲染）
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [handle, setHandle] = useState('');

  /** 结果收口：窗口表、权限、平台、提示语一次写完。 */
  const applyResult = useCallback(
    (result: { platform: string; allowed: boolean; windows: MacWindowInfo[] }) => {
      setWindows(result.windows);
      setAllowed(result.allowed);
      setPlatform(result.platform);
      setNote(
        result.platform !== 'darwin'
          ? '本机窗口只在 macOS 上可用'
          : result.allowed
            ? `${result.windows.length} 个可选窗口`
            : '缺少「屏幕录制」权限：能连上，但抓到的画面是空白',
      );
    },
    [],
  );

  const describeError = (error: unknown): string =>
    `取窗口列表失败：${error instanceof Error ? error.message : String(error)}`;

  /** 初次进入 Tab 枚举一次；setState 只在 promise 回调里（也顺手防了"组件已卸载还 setState"） */
  useEffect(() => {
    let alive = true;
    macWindows()
      .then((result) => {
        if (alive) {
          applyResult(result);
        }
      })
      .catch((error: unknown) => {
        if (alive) {
          setNote(describeError(error));
        }
      })
      .finally(() => {
        if (alive) {
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [applyResult]);

  /** 手动刷新（按钮是事件回调，直接 setState 没问题） */
  const refresh = (): void => {
    setLoading(true);
    void macWindows()
      .then(applyResult)
      .catch((error: unknown) => setNote(describeError(error)))
      .finally(() => setLoading(false));
  };

  const rows = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) {
      return windows;
    }
    return windows.filter((window) =>
      `${window.handle} ${window.app} ${window.title} ${window.label}`.toLowerCase().includes(text),
    );
  }, [windows, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 items-center gap-2 border-b border-line px-2">
        <Search className="size-3.5 text-faint" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜 App 名 / 窗口标题 / 句柄"
          className="h-6 min-w-0 flex-1 bg-transparent text-body placeholder:text-faint focus:outline-none"
        />
        <button
          type="button"
          onClick={refresh}
          title="重新枚举窗口（新开的 App 要刷新才出现）"
          className="flex shrink-0 items-center gap-1 text-badge text-dim hover:text-fg"
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          刷新
        </button>
      </div>

      <div className={cn('shrink-0 px-2 py-1 text-badge', allowed ? 'text-faint' : 'text-pending')}>
        {note}
        {!allowed && (
          <span className="text-faint"> · 系统设置 → 隐私与安全性 → 屏幕录制 里勾上终端/GamePilot</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.map((window) => {
          const isConnected = connected.has(window.handle);
          return (
            <button
              key={window.handle}
              type="button"
              onClick={() => (isConnected ? onActivate(window.handle) : onConnect(window.handle))}
              title={
                isConnected
                  ? `${window.label}（已连接）· 点一下切过去`
                  : `${window.label} · ${window.width}×${window.height}（点一下连接这个窗口）`
              }
              className={cn(
                'flex h-7 w-full items-center gap-2 px-2 text-left hover:bg-raised',
                isConnected && 'bg-active/50',
              )}
            >
              <span className="w-10 shrink-0 text-badge text-faint">#{window.handle}</span>
              <span className="shrink-0 text-body">{window.app}</span>
              <span className="min-w-0 flex-1 truncate text-badge text-dim">
                {window.title || '（无标题）'}
              </span>
              <span className="shrink-0 text-badge text-faint">
                {window.width}×{window.height}
              </span>
              <span
                className={cn(
                  'w-12 shrink-0 text-right text-badge',
                  isConnected ? 'text-brand' : 'text-faint',
                )}
              >
                {isConnected ? '当前' : '连接'}
              </span>
            </button>
          );
        })}
        {rows.length === 0 && (
          <div className="px-3 py-6 text-center text-badge text-faint">
            {loading ? '正在枚举窗口…' : query ? '没有匹配的窗口' : '没有可选窗口 · 点「刷新」重试'}
          </div>
        )}
      </div>

      <div className="flex h-8 shrink-0 items-center gap-1 border-t border-line px-2">
        <span className="text-badge text-faint">或直接输句柄</span>
        <input
          value={handle}
          onChange={(event) => setHandle(event.target.value.replace(/\D/g, ''))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onConnect(handle);
            }
          }}
          placeholder="89"
          className="h-5 w-16 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
        />
        <button
          type="button"
          disabled={platform !== 'darwin' || handle.length === 0}
          onClick={() => onConnect(handle)}
          className="h-5 shrink-0 rounded-sm border border-line px-1.5 text-badge text-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          连接
        </button>
        <span className="flex-1" />
        <span className="truncate text-badge text-faint">抓的是这个窗口的画面；点/拖/打字都作用在它里面</span>
      </div>
    </div>
  );
}
