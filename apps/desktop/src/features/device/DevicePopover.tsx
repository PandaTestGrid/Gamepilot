/**
 * 设备弹层：分类 Tab + 一步连接 / 切换 + 行内错误（DESIGN.md §4.3）。
 *
 * 与 AirtestIDE 的差别都体现在这里：
 *   - 四个折叠区 → **按来源分类的 Tab（只显示有内容的分类，带数量）**；
 *   - 「先选下拉再点连接」 → 点行任意位置即连；**已连接的行点一下 = 切换当前设备**；
 *   - 本机窗口（Windows / macOS 通用）不再塞在底部折叠区里 → 独立 Tab，整个列表区都是窗口选择器；
 *   - 裸的「刷新/重启 ADB」 → 收进 ⋯ 高级；
 *   - 键盘可用：↑↓ 换行、Enter 连接/切换、Esc 关闭、打开即聚焦搜索框。
 */
import { MoreHorizontal, RefreshCw, Search } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildDeviceTabs,
  connectableDevices,
  filterByTab,
  isWindowDevice,
  matchDeviceQuery,
  resolveTab,
  sortForDisplay,
} from '@/features/device/device-kinds';
import { DeviceRow } from '@/features/device/DeviceRow';
import { WindowList } from '@/features/device/WindowList';
import { StatusDot } from '@/layout/PanelShell';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

export function DevicePopover(): ReactNode {
  const open = useUiStore((state) => state.devicePopoverOpen);
  const toggle = useUiStore((state) => state.toggleDevicePopover);
  const tab = useUiStore((state) => state.deviceTab);
  const setTab = useUiStore((state) => state.setDeviceTab);

  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const setActive = useDeviceStore((state) => state.setActive);
  const scan = useDeviceStore((state) => state.scan);
  const scanState = useDeviceStore((state) => state.scanState);
  const scanErrors = useDeviceStore((state) => state.scanErrors);
  const scanError = useDeviceStore((state) => state.scanError);
  const lastScanAt = useDeviceStore((state) => state.lastScanAt);

  const connectSession = useSessionStore((state) => state.connect);
  const disconnectSession = useSessionStore((state) => state.disconnect);

  const [query, setQuery] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () =>
      sortForDisplay(
        connectableDevices(filterByTab(devices, tab)).filter((device) => matchDeviceQuery(device, query)),
        activeId,
      ),
    [devices, tab, query, activeId],
  );

  const tabs = useMemo(() => buildDeviceTabs(devices), [devices]);
  const connectedCount = devices.filter((device) => device.status === 'connected').length;
  // 已连接的窗口按 deviceId 记（windows:6698742 / macos:89），不再用句柄数字
  const connectedWindows = useMemo(
    () =>
      new Set(
        devices
          .filter((device) => isWindowDevice(device) && device.status === 'connected')
          .map((device) => device.id),
      ),
    [devices],
  );
  // 页脚按平台给权限说明：从已发现窗口的 id 前缀推断（Windows 无授权概念 / macOS 需屏幕录制）
  const windowPlatform = useMemo<'win32' | 'darwin' | null>(() => {
    if (devices.some((device) => device.id.startsWith('windows:'))) {
      return 'win32';
    }
    if (devices.some((device) => device.id.startsWith('macos:'))) {
      return 'darwin';
    }
    return null;
  }, [devices]);
  const windowPermissionHint =
    windowPlatform === 'win32'
      ? '本机窗口（Windows）无需额外授权'
      : windowPlatform === 'darwin'
        ? '本机窗口需屏幕录制权限（macOS）'
        : '本机窗口：Windows 无需授权 · macOS 需屏幕录制权限';

  /** 窗口行点击：直接用窗口自带的 deviceId + 绑定 URI（前台/后台输入方式已拼在 URI 里）。 */
  const connectWindow = useCallback(
    (deviceId: string, uri: string): void => {
      void connectSession(deviceId, uri).then((ok) => {
        if (ok) {
          toggle(false);
        }
      });
    },
    [connectSession, toggle],
  );

  /** 已绑定的窗口换输入方式：先断开再连，让 post= 参数立刻生效（不关弹层）。 */
  const reconnectWindow = useCallback(
    (deviceId: string, uri: string): void => {
      void disconnectSession(deviceId).then(() => connectSession(deviceId, uri));
    },
    [connectSession, disconnectSession],
  );

  const activateWindow = useCallback(
    (deviceId: string): void => {
      setActive(deviceId);
      toggle(false);
    },
    [setActive, toggle],
  );

  // 打开就扫一次：低频操作，不该让用户再点一次"刷新"（DESIGN.md §4.3.4）
  useEffect(() => {
    if (open) {
      void scan();
    }
  }, [open, scan]);

  // Esc 关弹层：挂 document 级（焦点在搜索框/列表/任何地方都能关，和「布局」菜单一致）
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        toggle(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, toggle]);

  // 当前 Tab 没内容（例如 iOS 拔了）就退到有内容的分类，避免打开是空列表
  useEffect(() => {
    if (open) {
      setTab(resolveTab(tab, tabs));
    }
  }, [open, tab, tabs, setTab]);

  if (!open) {
    return null;
  }

  /** ↑↓ 在行之间移动焦点；Enter 交给按钮原生行为（更可靠）；Esc 见上面的 document 监听。 */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    const focusables = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [],
    );
    if (focusables.length === 0) {
      return;
    }
    const index = focusables.findIndex((node) => node === document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = index === -1 ? 0 : (index + step + focusables.length) % focusables.length;
    focusables[next]?.focus();
    event.preventDefault();
  };

  return (
    <div className="absolute inset-0 z-30 bg-canvas/60" onClick={() => toggle(false)} role="presentation">
      <div
        className="absolute top-16 left-3 flex h-[420px] w-[520px] flex-col rounded-sm border border-line bg-panel"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        role="presentation"
      >
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2">
          <span className="text-panelhead font-medium">设备</span>
          <span className="text-badge text-faint">
            {connectedCount} 台已连接 · 上限 4
            {scanState === 'scanning' ? ' · 扫描中…' : lastScanAt ? ' · 已刷新' : ''}
          </span>
          <div className="flex-1" />
          <span className="text-badge text-faint">↑↓ 选择 · Enter 连接/切换 · Esc 关闭</span>
          <button type="button" onClick={() => toggle(false)} className="px-1 text-dim hover:text-fg">
            ✕
          </button>
        </div>

        {/* 搜索：本机窗口那一类里搜的是进程/标题/句柄（WindowList 自带搜索） */}
        {tab !== 'window' && (
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
            <Search className="size-3.5 text-faint" />
            <input
              ref={searchRef}
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索设备，或粘贴 URI（Android:///?serial=xxx）"
              className="h-6 min-w-0 flex-1 bg-transparent text-body placeholder:text-faint focus:outline-none"
            />
          </div>
        )}

        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              title={`${item.label}（${item.count}）`}
              className={cn(
                'flex h-5 items-center gap-1 rounded-sm px-2 text-badge',
                tab === item.id ? 'bg-active text-fg' : 'text-dim hover:bg-raised',
              )}
            >
              {item.label}
              <span className="text-faint">{item.count}</span>
            </button>
          ))}
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
          {tab === 'window' ? (
            <WindowList
              connected={connectedWindows}
              activeDeviceId={activeId}
              onConnect={connectWindow}
              onReconnect={reconnectWindow}
              onActivate={activateWindow}
            />
          ) : (
            <>
              {rows.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  active={device.id === activeId}
                  onActivate={() => {
                    setActive(device.id);
                    toggle(false);
                  }}
                  onConnect={() => {
                    // 连上了才收起弹层；失败时保持打开，原因会显示在行内与顶部红条
                    void connectSession(device.id, device.uri).then((ok) => {
                      if (ok) {
                        toggle(false);
                      }
                    });
                  }}
                  onDisconnect={() => void disconnectSession(device.id)}
                />
              ))}
              {(tab === 'all' || tab === 'emulator') &&
                devices.some((device) => device.kind === 'emulator') && (
                  <p className="px-3 py-2 text-badge text-faint">
                    已打开的应用窗口会单独成行；之后新开的标签页可在画面上方点「添加屏幕」。
                  </p>
                )}
              {rows.length === 0 && (
                <div className="px-3 py-6 text-center text-badge text-faint">
                  {query ? '没有匹配的设备' : '这一类还没有设备 · 点下面的「刷新」重新扫描'}
                </div>
              )}

              {(scanError || scanErrors.length > 0) && (
                <div className="flex items-start gap-2 border-t border-line bg-raised/40 px-2 py-1.5">
                  <StatusDot tone="failed" className="mt-0.5" />
                  <span className="flex-1 text-badge text-failed">
                    {scanError ? `扫描失败：${scanError}` : scanErrors.join(' · ')}
                  </span>
                  <button type="button" onClick={() => void scan()} className="text-badge text-brand">
                    重试
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="relative flex h-8 shrink-0 items-center gap-3 border-t border-line px-2 text-badge text-dim">
          <button
            type="button"
            onClick={() => void scan()}
            className="flex items-center gap-1 hover:text-fg"
            title="重新扫描 adb / usbmux / 本机窗口"
          >
            <RefreshCw className={cn('size-3', scanState === 'scanning' && 'animate-spin')} /> 刷新
          </button>
          <button
            type="button"
            onClick={() => setAdvanced((value) => !value)}
            className={cn('flex items-center gap-1 hover:text-fg', advanced && 'text-fg')}
          >
            <MoreHorizontal className="size-3" /> 高级
          </button>
          <div className="flex-1" />
          <span className="truncate text-faint">iOS 17.4+ · {windowPermissionHint}</span>

          {advanced && (
            <div className="absolute bottom-8 left-12 w-52 rounded-sm border border-line bg-raised py-1">
              {['刷新设备列表', '重启 ADB（会断开所有设备）', '复制当前设备 URI', '手动输入 URI…'].map(
                (item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setAdvanced(false)}
                    className="block w-full px-2 py-1 text-left text-badge text-dim hover:bg-active hover:text-fg"
                  >
                    {item}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
