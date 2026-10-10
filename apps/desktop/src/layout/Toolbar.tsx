import { Cable, ChevronDown, CirclePlay, LayoutGrid, Redo2, Square, Undo2, Video } from 'lucide-react';
import { type ReactNode } from 'react';

import { ToolbarButton, VDivider } from '@/layout/PanelShell';
import { cn } from '@/lib/utils';
import { activeDevice, useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
import { useUiStore } from '@/stores/ui.store';
import type { DotTone } from '@/layout/PanelShell';
import { StatusDot } from '@/layout/PanelShell';
import type { DeviceStatus } from '@/types';

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

export function Toolbar({ running, onToggleRun }: { running: boolean; onToggleRun: () => void }): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const toggleDevicePopover = useUiStore((state) => state.toggleDevicePopover);
  const recordMode = useUiStore((state) => state.recordMode);
  const toggleRecording = useUiStore((state) => state.toggleRecording);
  const engineStatus = useEngineStore((state) => state.status);
  const engineInfo = useEngineStore((state) => state.info);
  const selfCheck = useEngineStore((state) => state.selfCheck);

  const device = activeDevice(devices, activeId);

  return (
    <header className="flex h-9 shrink-0 items-center bg-panel pr-2">
      <span className="px-3 text-[15px] font-medium tracking-wide">GamePilot</span>
      <VDivider />

      <ToolbarButton onClick={onToggleRun} active={running}>
        {running ? <Square className="size-3.5" /> : <CirclePlay className="size-3.5" />}
        {running ? '停止' : '运行'}
      </ToolbarButton>
      <ToolbarButton
        onClick={toggleRecording}
        active={recordMode !== 'off'}
        title="录制：框选生成识别器与节点"
      >
        <Video className="size-3.5" />
        录制
      </ToolbarButton>
      <VDivider />

      <ToolbarButton title="撤销（一次录制 = 一个原子操作）">
        <Undo2 className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton title="重做">
        <Redo2 className="size-3.5" />
      </ToolbarButton>
      <VDivider />

      <button
        type="button"
        onClick={() => toggleDevicePopover()}
        className="flex h-6 min-w-0 items-center gap-2 rounded-sm px-2 hover:bg-raised"
        title="设备选择器：多设备管理（DESIGN.md §4.3）"
      >
        <StatusDot tone={toneOf(device?.status ?? 'discovered')} />
        <span className="truncate text-body">
          {device ? `${device.name} · ${device.resolution[0]}×${device.resolution[1]}` : '未连接设备'}
        </span>
        <ChevronDown className="size-3.5 text-dim" />
      </button>

      <VDivider />
      <GridToggle />

      <div className="flex-1" />

      <ToolbarButton title={engineInfo} onClick={() => void selfCheck()}>
        <Cable
          className={cn(
            'size-3.5',
            engineStatus === 'ready' && 'text-confirmed',
            engineStatus === 'error' && 'text-failed',
          )}
        />
        <span
          className={cn(
            engineStatus === 'error' && 'text-failed',
            engineStatus === 'ready' && 'text-confirmed',
          )}
        >
          骨架自检
        </span>
      </ToolbarButton>
      <VDivider />
      <span className="px-2 text-badge text-faint">─ □ ✕</span>
    </header>
  );
}

function GridToggle(): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const gridView = useDeviceStore((state) => state.gridView);
  const toggleGrid = useDeviceStore((state) => state.toggleGrid);
  const connected = devices.filter((item) => item.status === 'connected');

  return (
    <ToolbarButton
      onClick={toggleGrid}
      active={gridView}
      title={connected.length < 2 ? '需要至少 2 台已连接设备才能多开网格' : '在网格里同时看多台设备'}
    >
      <LayoutGrid className="size-3.5" />
      多开 {connected.length > 0 && <span className="text-faint">×{connected.length}</span>}
    </ToolbarButton>
  );
}
