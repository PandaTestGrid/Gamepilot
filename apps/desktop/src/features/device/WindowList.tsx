/**
 * 本机窗口选择器（Windows / macOS 通用）：弹层「本机窗口」Tab 的内容。
 *
 * 它占整个列表区，而不是塞在弹层底部一行 28px 里：
 *   - 打开 Tab 就枚举窗口（一次 `window.list`），带**搜索**（进程 / App 名 / 标题 / 句柄）；
 *   - 行显示 `句柄 进程/App · 标题  尺寸`，点一下就连；**已绑定的窗口**标出来（点它=切换过去）；
 *   - Windows 的句柄按 `0x` 十六进制展示（HWND 本身就是十六进制语义），macOS 用十进制；
 *   - Windows 可选输入方式只保留两档：**前台 SendInput**（可靠，会激活窗口）/
 *     **后台同步 SendMessage**（不抢焦点，先试它；游戏只认真实输入时用前台）；
 *     `post=hybrid` / `cursor=1` 等进阶组合仍可手写 URI 使用，只是界面不再堆按钮；
 *   - 没有「屏幕录制」权限（macOS）时直接说明"抓到的是空白"并给出系统设置路径；
 *   - 手输句柄仍然保留（窗口列表有时抓不到某些 App / 窗口），win32 接受 `0x` 十六进制。
 */
import { RefreshCw, Search } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { windowList, type WindowInfo, type WindowListResult } from '@/lib/rpc';
import { cn } from '@/lib/utils';

/**
 * Windows 的输入方式（界面只保留两档）：
 *   - `global`：前台 SendInput（会激活目标窗口，操作后焦点留在游戏）；
 *   - `sync`：后台同步 SendMessage（Win32 消息直送窗口过程；不抢焦点）。
 *
 * 引擎仍支持 `post=message` / `post=hybrid` / `cursor=1`，需要时手输 URI 即可。
 */
export type WindowPostMode = 'global' | 'sync';

export interface WindowListProps {
  /** 已经连上的窗口 deviceId（`windows:6698742` / `macos:89`）→ 用来标「已绑定」 */
  readonly connected: ReadonlySet<string>;
  /** 当前活动的设备 id：切输入方式时如果是已绑定的窗口，就地重连让新方式立即生效 */
  readonly activeDeviceId?: string;
  readonly onConnect: (deviceId: string, uri: string) => void;
  /** 已绑定的窗口换输入方式：先断开再连（不传就只记住选择，下次连接生效） */
  readonly onReconnect?: (deviceId: string, uri: string) => void;
  readonly onActivate: (deviceId: string) => void;
}

/** Windows 句柄按 0x 展示（HWND 语义）；macOS 的 kCGWindowNumber 用十进制。 */
export function formatWindowHandle(handle: number, platform: string): string {
  return platform === 'win32' ? `0x${handle.toString(16).toUpperCase()}` : String(handle);
}

/** 把输入方式拼进连接 URI（先清掉旧的 post/cursor 参数，重复调用不会叠加）。 */
export function withPostMode(uri: string, mode: WindowPostMode): string {
  const cleaned = uri
    .replace(/([?&])(post|cursor)=[^&]*/g, '')
    .replace(/\?&/, '?')
    .replace(/&$/, '');
  const separator = cleaned.includes('?') ? '&' : '?';
  return `${cleaned}${separator}post=${mode}`;
}

/**
 * 手输句柄解析：win32 接受 `0x1A2B` 这样的十六进制，内部统一换成十进制；
 * macOS 只接受十进制。非法/空输入返回 null（「连接」按钮置灰）。
 */
export function parseHandleInput(raw: string): number | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const value = /^0x/i.test(text)
    ? Number.parseInt(text.slice(2), 16)
    : /^\d+$/.test(text)
      ? Number.parseInt(text, 10)
      : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** 手输句柄 → 绑定目标（deviceId + 连接 URI，URI 里一律写十进制）。 */
export function manualWindowTarget(
  platform: string,
  handle: number,
  mode: WindowPostMode,
): { deviceId: string; uri: string } {
  if (platform === 'win32') {
    return {
      deviceId: `windows:${handle}`,
      uri: withPostMode(`Windows:///?hwnd=${handle}`, mode),
    };
  }
  return { deviceId: `macos:${handle}`, uri: `Mac:///?window=${handle}` };
}

/** 结果里的 `note` 优先；缺省时按平台给一句人话（权限 / 不可用 / 窗口数）。 */
function describeResult(result: WindowListResult): string {
  if (result.note.trim()) {
    return result.note;
  }
  if (result.platform === 'darwin' && !result.allowed) {
    return '缺少「屏幕录制」权限：能连上，但抓到的画面是空白';
  }
  if (result.platform !== 'win32' && result.platform !== 'darwin') {
    return '本机窗口只在 Windows / macOS 上可用';
  }
  return `${result.windows.length} 个可选窗口`;
}

function describeError(error: unknown): string {
  return `取窗口列表失败：${error instanceof Error ? error.message : String(error)}`;
}

export function WindowList({
  connected,
  activeDeviceId,
  onConnect,
  onReconnect,
  onActivate,
}: WindowListProps): ReactNode {
  const [windows, setWindows] = useState<readonly WindowInfo[]>([]);
  const [platform, setPlatform] = useState('');
  const [allowed, setAllowed] = useState(true);
  const [note, setNote] = useState('正在枚举窗口…');
  // 初次渲染就是"加载中"：避免在 effect 里同步 setState（会触发级联渲染）
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [handle, setHandle] = useState('');
  const [postMode, setPostMode] = useState<WindowPostMode>('global');

  const isWindows = platform === 'win32';
  const canConnect = platform === 'win32' || platform === 'darwin';
  const manualHandle = parseHandleInput(handle);

  /** 结果收口：窗口表、平台、权限、提示语一次写完。 */
  const applyResult = useCallback((result: WindowListResult): void => {
    setWindows(result.windows);
    setPlatform(result.platform);
    setAllowed(result.allowed);
    setNote(describeResult(result));
  }, []);

  /** 初次进入 Tab 枚举一次；setState 只在 promise 回调里（并防"组件已卸载还 setState"） */
  useEffect(() => {
    let alive = true;
    windowList()
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
    void windowList()
      .then(applyResult)
      .catch((error: unknown) => setNote(describeError(error)))
      .finally(() => setLoading(false));
  };

  const rows = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) {
      return windows;
    }
    return windows.filter((item) =>
      `${item.handle} ${formatWindowHandle(item.handle, platform)} ${item.process ?? ''} ${
        item.app
      } ${item.title} ${item.label} ${item.deviceId}`
        .toLowerCase()
        .includes(text),
    );
  }, [windows, platform, query]);

  /** 行点击：已绑定 = 切过去；未绑定 = 用窗口自带的 deviceId/uri 绑定并连接。 */
  const connectRow = (item: WindowInfo): void => {
    onConnect(item.deviceId, isWindows ? withPostMode(item.uri, postMode) : item.uri);
  };

  const connectManual = (): void => {
    if (manualHandle === null || !canConnect) {
      return;
    }
    const target = manualWindowTarget(platform, manualHandle, postMode);
    onConnect(target.deviceId, target.uri);
  };

  /**
   * 切换输入方式：如果当前活动设备正好是**已绑定**的窗口，就地重连让新方式立即生效
   * （否则用户会以为"切了后台但没反应"—— 旧会话仍然跑在前台模式）。
   */
  const selectMode = (mode: WindowPostMode): void => {
    setPostMode(mode);
    if (!isWindows || !activeDeviceId || !connected.has(activeDeviceId)) {
      return;
    }
    const bound = windows.find((item) => item.deviceId === activeDeviceId);
    if (bound && onReconnect) {
      onReconnect(bound.deviceId, withPostMode(bound.uri, mode));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        <Search className="size-3.5 text-faint" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜进程 / App 名 / 窗口标题 / 句柄"
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

      <div
        className={cn(
          'flex shrink-0 items-center gap-1 border-b border-line/60 px-2 py-1 text-badge',
          allowed ? 'text-faint' : 'text-pending',
        )}
      >
        <span className="truncate">{note}</span>
        {!allowed && platform === 'darwin' && (
          <span className="shrink-0 text-faint">
            · 系统设置 → 隐私与安全性 → 屏幕录制 里勾上终端/GamePilot
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.map((item) => {
          const isBound = connected.has(item.deviceId);
          const width = item.clientWidth ?? item.width;
          const height = item.clientHeight ?? item.height;
          const size = `${width}×${height}`;
          return (
            <button
              key={item.deviceId}
              type="button"
              onClick={() => (isBound ? onActivate(item.deviceId) : connectRow(item))}
              title={
                isBound
                  ? `${item.label}（已绑定）· 点一下切过去`
                  : `${item.label} · ${size}（点一下绑定并连接这个窗口）`
              }
              className={cn(
                'flex h-7 w-full items-center gap-2 border-b border-line/60 px-2 text-left hover:bg-raised',
                isBound && 'bg-active/50',
              )}
            >
              <span className="w-16 shrink-0 font-mono text-badge text-faint">
                {formatWindowHandle(item.handle, platform)}
              </span>
              <span className="max-w-24 shrink-0 truncate text-body">{item.process ?? item.app}</span>
              <span className="min-w-0 flex-1 truncate text-badge text-dim">
                {item.title || '（无标题）'}
              </span>
              {item.minimized && (
                <span
                  className="shrink-0 rounded-sm border border-line px-1 text-badge text-pending"
                  title="窗口最小化：可能抓到黑屏，恢复窗口后更稳"
                >
                  最小化
                </span>
              )}
              {item.protected && (
                <span
                  className="shrink-0 rounded-sm border border-line px-1 text-badge text-failed"
                  title="目标可能以管理员运行：不行就以管理员身份运行 GamePilot"
                >
                  管理员
                </span>
              )}
              <span className="w-14 shrink-0 text-right text-badge text-faint">{size}</span>
              <span
                className={cn('w-12 shrink-0 text-right text-badge', isBound ? 'text-brand' : 'text-faint')}
              >
                {isBound ? '已绑定' : '连接'}
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

      <div className="shrink-0 border-t border-line">
        <div className="flex h-8 items-center gap-1.5 px-2">
          <span className="shrink-0 text-badge text-faint">或直接输句柄</span>
          <input
            value={handle}
            onChange={(event) =>
              setHandle(event.target.value.replace(isWindows ? /[^0-9a-fA-FxX]/g : /\D/g, ''))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                connectManual();
              }
            }}
            placeholder={isWindows ? '0x1A2B' : '89'}
            aria-label="窗口句柄"
            className="h-5 w-20 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
          />
          <button
            type="button"
            disabled={!canConnect || manualHandle === null}
            onClick={connectManual}
            className="h-5 shrink-0 rounded-sm border border-line px-1.5 text-badge text-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            连接
          </button>
          <span className="flex-1" />
          {isWindows && (
            <div role="group" aria-label="输入方式" className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                aria-pressed={postMode === 'global'}
                onClick={() => selectMode('global')}
                title="前台输入（SendInput）：最可靠，但会激活目标窗口、抢鼠标/焦点"
                className={cn(
                  'h-5 rounded-sm px-1.5 text-badge',
                  postMode === 'global' ? 'bg-active text-fg' : 'text-dim hover:bg-raised',
                )}
              >
                前台
              </button>
              <button
                type="button"
                aria-pressed={postMode === 'sync'}
                onClick={() => selectMode('sync')}
                title="后台同步消息（SendMessage）：不激活窗口、不抢焦点；游戏没反应就换「前台」"
                className={cn(
                  'h-5 rounded-sm px-1.5 text-badge',
                  postMode === 'sync' ? 'bg-active text-fg' : 'text-dim hover:bg-raised',
                )}
              >
                后台
              </button>
            </div>
          )}
        </div>
        <div className="flex h-6 items-center gap-1 border-t border-line/60 px-2 text-badge text-faint">
          <span className="truncate">
            {isWindows
              ? postMode === 'global'
                ? '前台输入会激活目标窗口，点完鼠标放回原处（最可靠）'
                : '后台同步：不激活窗口、不抢焦点；游戏没反应就换「前台」'
              : '抓的是这个窗口的画面；句柄会随窗口重开而变，重新挑一个即可'}
          </span>
        </div>
      </div>
    </div>
  );
}
