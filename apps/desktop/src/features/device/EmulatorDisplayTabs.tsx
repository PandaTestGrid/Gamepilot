/** 模拟器内的标签页是 Android 显示器，不是多个 Windows 窗口。 */
import { Plus, RefreshCw, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { statusTone } from '@/features/device/device-kinds';
import { emulatorDisplaysFor } from '@/features/device/emulator-displays';
import { StatusDot } from '@/layout/PanelShell';
import { cn } from '@/lib/utils';
import { activeDevice, useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';

export function EmulatorDisplayTabs(): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const setActive = useDeviceStore((state) => state.setActive);
  const scan = useDeviceStore((state) => state.scan);
  const scanState = useDeviceStore((state) => state.scanState);
  const scanError = useDeviceStore((state) => state.scanError);
  const connect = useSessionStore((state) => state.connect);
  const disconnect = useSessionStore((state) => state.disconnect);
  const ready = useSessionStore((state) => state.ready);
  const displays = emulatorDisplaysFor(devices, activeDevice(devices, activeId));
  const tabs = displays.filter(
    ({ id, device }) =>
      id === 0 || device.status === 'connected' || device.status === 'connecting' || ready[device.id],
  );
  const available = displays.filter(
    ({ id, device }) =>
      id !== 0 && device.status !== 'connected' && device.status !== 'connecting' && !ready[device.id],
  );
  const [adding, setAdding] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const addButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!adding) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (
        !addButton.current?.contains(event.target as Node) &&
        !menu.current?.contains(event.target as Node)
      ) {
        setAdding(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setAdding(false);
        addButton.current?.focus();
      }
    };
    const onResize = (): void => setAdding(false);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, [adding]);

  const toggleAdd = (): void => {
    if (!adding && addButton.current) {
      // MuMu 打开/关闭应用会改变可用标签页；每次展开都刷新，不展示旧的空槽列表。
      void scan();
      const rect = addButton.current.getBoundingClientRect();
      const width = 288;
      const height = Math.min(320, window.innerHeight - 16);
      setMenuPosition({
        top:
          rect.bottom + height + 4 <= window.innerHeight
            ? rect.bottom + 4
            : Math.max(8, rect.top - height - 4),
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      });
    }
    setAdding((open) => !open);
  };

  if (displays.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="emulator-display-tabs"
      role="group"
      aria-label="模拟器窗口切换"
      className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line bg-panel px-2"
    >
      <span className="shrink-0 text-badge text-dim">模拟器窗口</span>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map(({ id, device, app }) => {
          const selected = device.id === activeId;
          const label = id === 0 ? '主屏' : `屏${id}`;
          const connecting = device.status === 'connecting';
          const connected = device.status === 'connected';
          return (
            <div key={device.id} className="flex shrink-0 items-center">
              <button
                type="button"
                aria-current={selected ? 'true' : undefined}
                aria-label={`${label}${app ? ` · ${app}` : ''}${selected ? '，当前窗口' : ''}`}
                title={`${device.name}\n${connected ? '点此切换画面与控制' : connecting ? '正在连接…' : device.status === 'failed' ? '点此重试' : '点此连接主屏'}${device.error ? `\n${device.error}` : ''}`}
                disabled={connecting}
                onClick={() => {
                  if (connected) setActive(device.id);
                  else void connect(device.id, device.uri);
                }}
                className={cn(
                  'flex h-5 max-w-48 items-center gap-1.5 rounded-sm pr-1 pl-2 text-body whitespace-nowrap focus-visible:outline focus-visible:outline-1 focus-visible:outline-brand disabled:cursor-wait',
                  selected ? 'bg-active text-fg' : 'text-dim hover:bg-raised hover:text-fg',
                )}
              >
                <StatusDot tone={statusTone(device.status)} />
                <span className="shrink-0">{label}</span>
                {app && <span className="min-w-0 truncate text-badge text-dim">{app}</span>}
                {!connected && (
                  <span className="shrink-0 text-badge text-dim">
                    {connecting ? '连接中…' : device.status === 'failed' ? '重试' : '连接'}
                  </span>
                )}
              </button>
              {id !== 0 && (connected || ready[device.id]) && (
                <button
                  type="button"
                  aria-label={`断开屏${id}`}
                  title={`断开屏${id}（不会关闭模拟器里的应用）`}
                  onClick={() => void disconnect(device.id)}
                  className="flex size-5 items-center justify-center text-faint hover:bg-raised hover:text-failed focus-visible:outline focus-visible:outline-1 focus-visible:outline-brand"
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        ref={addButton}
        type="button"
        aria-expanded={adding}
        aria-controls={adding ? menuId : undefined}
        title="展开即自动刷新可发现的窗口（在模拟器里新开了应用标签页就点这里）"
        onClick={toggleAdd}
        className="flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-badge text-brand hover:bg-raised focus-visible:outline focus-visible:outline-1 focus-visible:outline-brand"
      >
        <Plus aria-hidden="true" className="size-3" /> 添加屏幕
      </button>
      {adding &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            role="group"
            aria-label="可添加的模拟器屏幕"
            className="fixed z-50 w-72 rounded-sm border border-line bg-panel shadow-lg"
            style={menuPosition}
          >
            <div className="flex h-7 items-center gap-2 border-b border-line px-2 text-badge text-dim">
              <span className="flex-1">可添加的屏幕</span>
              <button
                type="button"
                onClick={() => void scan()}
                disabled={scanState === 'scanning'}
                className="flex items-center gap-1 text-brand hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-brand disabled:opacity-40"
              >
                <RefreshCw
                  aria-hidden="true"
                  className={cn('size-3', scanState === 'scanning' && 'animate-spin')}
                />
                {scanState === 'scanning' ? '扫描中…' : '刷新列表'}
              </button>
            </div>
            {scanError && <p className="px-2 py-1.5 text-badge text-failed">扫描失败：{scanError}</p>}
            <div className="max-h-60 overflow-auto py-1">
              {available.length === 0 ? (
                <p className="px-2 py-2 text-badge text-dim">
                  没有可添加的屏幕。先在模拟器里打开应用标签页，再点「刷新列表」。
                </p>
              ) : (
                available.map(({ id, device, app }) => (
                  <button
                    key={device.id}
                    type="button"
                    aria-label={`添加屏${id}${app ? ` · ${app}` : ''}`}
                    title={device.error ?? device.name}
                    onClick={() => {
                      setAdding(false);
                      void connect(device.id, device.uri);
                    }}
                    className="flex min-h-7 w-full items-center gap-2 px-2 text-left text-body text-fg hover:bg-raised focus-visible:outline focus-visible:outline-1 focus-visible:outline-brand"
                  >
                    <StatusDot tone={statusTone(device.status)} />
                    <span className="shrink-0">屏{id}</span>
                    <span className="min-w-0 flex-1 truncate text-badge text-dim">{app ?? device.name}</span>
                    <span className="shrink-0 text-badge text-brand">
                      {device.status === 'failed' ? '重试' : '添加'}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
