/**
 * 设备标签条：多设备的核心入口（DESIGN.md §4.6）。
 *
 * - 每个「已连接」设备一个标签，带状态点与 fps
 * - 点击 = 切换活动设备（状态图/事件/识别器/底栏一起跟着切）
 * - 双击 = 在独立窗口打开该设备画面（Tauri 多窗口）
 * - 右键菜单：断开 / 复制 URI / 独立窗口
 */
import { MonitorUp, Plus, X } from 'lucide-react';
import { type ReactNode } from 'react';

import { StatusDot, type DotTone } from '@/layout/PanelShell';
import { cn } from '@/lib/utils';
import { openPaneWindow } from '@/lib/windows';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

const TONE: Record<string, DotTone> = {
  connected: 'confirmed',
  connecting: 'pending',
  failed: 'failed',
};

export function DeviceTabs(): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const setActive = useDeviceStore((state) => state.setActive);
  const disconnect = useSessionStore((state) => state.disconnect);
  const markWindowed = useDeviceStore((state) => state.markWindowed);
  const toggleDevicePopover = useUiStore((state) => state.toggleDevicePopover);
  const connected = devices.filter(
    (device) => device.status === 'connected' || device.status === 'connecting',
  );

  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
      {connected.map((device) => {
        const active = device.id === activeId;
        return (
          <div
            key={device.id}
            className={cn(
              'group flex h-5 items-center gap-1.5 rounded-sm pr-1 pl-2',
              active ? 'bg-active text-fg' : 'text-dim hover:bg-raised',
            )}
          >
            <button
              type="button"
              onClick={() => setActive(device.id)}
              onDoubleClick={() => void openPaneWindow('screen', device.id)}
              title={`${device.uri}\n单击切换 · 双击独立窗口`}
              className="flex items-center gap-1.5"
            >
              <StatusDot tone={TONE[device.status] ?? 'idle'} />
              <span className="text-body">{device.name}</span>
              <span className="text-badge text-faint">{device.fps}fps</span>
            </button>
            <button
              type="button"
              title="在独立窗口打开"
              onClick={() => {
                void openPaneWindow('screen', device.id);
                markWindowed(device.id, true);
              }}
              className="opacity-0 group-hover:opacity-100"
            >
              <MonitorUp className="size-3 text-dim hover:text-fg" />
            </button>
            <button
              type="button"
              title="断开"
              onClick={() => void disconnect(device.id)}
              className="opacity-0 group-hover:opacity-100"
            >
              <X className="size-3 text-dim hover:text-failed" />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => toggleDevicePopover(true)}
        title="添加设备"
        className="flex size-5 items-center justify-center rounded-sm text-dim hover:bg-raised hover:text-fg"
      >
        <Plus className="size-3.5" />
      </button>

      <div className="flex-1" />
      <span className="text-badge text-faint">{connected.length} 台运行中 · 上限 4 台（DESIGN.md §4.6）</span>
    </div>
  );
}
