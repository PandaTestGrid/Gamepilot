/**
 * 设备弹层：统一列表 + 一步连接 + 行内错误（DESIGN.md §4.3）。
 *
 * 与 AirtestIDE 的差别都体现在这里：
 *   - 四个折叠区 → 一个列表 + 来源徽标
 *   - 「先选下拉再点连接」 → 点行任意位置即连
 *   - 裸的「刷新/重启 ADB」 → 收进 ⋯ 高级
 *   - iOS 设备由引擎发现（pymobiledevice3 usbmux，仅 17.4+），点一下就连；
 */
import { MoreHorizontal, RefreshCw, Search } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { StatusDot, type DotTone } from '@/layout/PanelShell';
import { formatResolution } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { DeviceKind, DeviceRuntime, DeviceStatus } from '@/types';

const TABS: Array<{ id: 'all' | DeviceKind; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'android', label: '安卓' },
  { id: 'emulator', label: '模拟器' },
  { id: 'windows', label: 'Windows' },
  { id: 'ios', label: 'iOS' },
  { id: 'mock', label: 'Mock' },
];

function toneOf(status: DeviceStatus): DotTone {
  switch (status) {
    case 'connected':
      return 'confirmed';
    case 'connecting':
      return 'pending';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

export function DevicePopover(): ReactNode {
  const open = useUiStore((state) => state.devicePopoverOpen);
  const toggle = useUiStore((state) => state.toggleDevicePopover);
  const devices = useDeviceStore((state) => state.devices);
  const connectSession = useSessionStore((state) => state.connect);
  const disconnectSession = useSessionStore((state) => state.disconnect);
  const scan = useDeviceStore((state) => state.scan);
  const scanState = useDeviceStore((state) => state.scanState);
  const scanErrors = useDeviceStore((state) => state.scanErrors);
  const scanError = useDeviceStore((state) => state.scanError);
  const lastScanAt = useDeviceStore((state) => state.lastScanAt);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | DeviceKind>('all');
  const [advanced, setAdvanced] = useState(false);

  const rows = useMemo(
    () =>
      devices.filter((device) => {
        const matchTab = tab === 'all' || device.kind === tab;
        const text = `${device.name} ${device.uri} ${device.kind}`.toLowerCase();
        return matchTab && (query.trim() === '' || text.includes(query.trim().toLowerCase()));
      }),
    [devices, query, tab],
  );

  const connectedCount = devices.filter((device) => device.status === 'connected').length;

  // 打开就扫一次：这是低频操作，不该让用户再点一次"刷新"（DESIGN.md §4.3.4）
  useEffect(() => {
    if (open) {
      void scan();
    }
  }, [open, scan]);

  if (!open) {
    return null;
  }

  return (
    <div className="absolute inset-0 z-30 bg-canvas/60" onClick={() => toggle(false)} role="presentation">
      <div
        className="absolute top-16 left-3 w-[460px] rounded-sm border border-line bg-panel"
        onClick={(event) => event.stopPropagation()}
        role="presentation"
      >
        <div className="flex h-7 items-center gap-2 border-b border-line px-2">
          <span className="text-panel font-medium">设备</span>
          <span className="text-badge text-faint">
            {connectedCount} 台已连接 · 上限 4
            {scanState === 'scanning' ? ' · 扫描中…' : lastScanAt ? ' · 已刷新' : ''}
          </span>
          <div className="flex-1" />
          <button type="button" onClick={() => toggle(false)} className="px-1 text-dim hover:text-fg">
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-line px-2 py-2">
          <Search className="size-3.5 text-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索设备，或粘贴 URI（Android:///?serial=xxx）"
            className="h-6 flex-1 bg-transparent text-body placeholder:text-faint focus:outline-none"
          />
        </div>

        <div className="flex gap-1 border-b border-line px-2 py-1.5">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                'h-5 rounded-sm px-2 text-badge',
                tab === item.id ? 'bg-active text-fg' : 'text-dim hover:bg-raised',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="max-h-[340px] overflow-auto">
          {rows.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
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
          {rows.length === 0 && (
            <div className="px-3 py-6 text-center text-badge text-faint">没有匹配的设备</div>
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
        </div>

        <div className="relative flex h-8 items-center gap-3 border-t border-line px-2 text-badge text-dim">
          <button
            type="button"
            onClick={() => void scan()}
            className="flex items-center gap-1 hover:text-fg"
            title="重新扫描 adb 设备与可发现的窗口"
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
          <span
            className="text-faint"
            title="QuickTime 采集 + pymobiledevice3 CoreDevice HID；需要 iOS 17.4+"
          >
            iOS：17.4+（QuickTime 采集）· 用前需切 USB config2
          </span>

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

function DeviceRow({
  device,
  onConnect,
  onDisconnect,
}: {
  device: DeviceRuntime;
  onConnect: () => void;
  onDisconnect: () => void;
}): ReactNode {
  const failed = device.status === 'failed';
  return (
    <div className="group border-b border-line/60">
      <div className="flex h-8 items-center gap-2 px-2 hover:bg-raised">
        <button
          type="button"
          onClick={onConnect}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <StatusDot tone={toneOf(device.status)} />
          <span className="truncate text-body">{device.name}</span>
          <span className="text-badge text-faint">{kindLabel(device.kind)}</span>
        </button>
        <span className="w-20 text-right text-badge text-dim">
          {device.status === 'failed' ? '不可用' : formatResolution(device.resolution)}
        </span>
        {device.status === 'connected' ? (
          <button
            type="button"
            onClick={onDisconnect}
            className="w-12 text-right text-badge text-confirmed hover:text-failed"
          >
            断开
          </button>
        ) : device.status === 'connecting' ? (
          <span className="flex w-12 items-center justify-end gap-1 text-badge text-pending">
            <RefreshCw className="size-3 animate-spin" />
          </span>
        ) : (
          <button
            type="button"
            onClick={onConnect}
            className="w-12 text-right text-badge text-brand opacity-0 group-hover:opacity-100"
          >
            连接
          </button>
        )}
      </div>

      {failed && (
        <div className="flex items-center gap-2 bg-raised/40 px-2 py-1.5">
          <StatusDot tone="failed" />
          <span className="flex-1 text-badge text-failed">
            {device.error ?? '连接失败'}
            {device.suggestedFix ? ` · ${device.suggestedFix}` : ''}
          </span>
          <button type="button" onClick={onConnect} className="text-badge text-brand">
            重新检测
          </button>
        </div>
      )}
    </div>
  );
}

function kindLabel(kind: DeviceKind): string {
  switch (kind) {
    case 'android':
      return '安卓';
    case 'ios':
      return 'iOS';
    case 'emulator':
      return '模拟器';
    case 'windows':
      return 'Windows';
    case 'mock':
      return 'Mock';
    default:
      return '远程';
  }
}
