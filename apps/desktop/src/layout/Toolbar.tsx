import { Cable, ChevronDown, LayoutGrid, Redo2, Undo2, Video } from 'lucide-react';
import { type ReactNode } from 'react';

import { ProjectMenu } from '@/layout/ProjectMenu';
import { LayoutMenu } from '@/layout/LayoutMenu';
import { ToolbarButton, VDivider } from '@/layout/PanelShell';
import { RunButton } from '@/layout/RunButton';
import { formatResolution } from '@/lib/format';
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

export function Toolbar(): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const toggleDevicePopover = useUiStore((state) => state.toggleDevicePopover);
  const recordMode = useUiStore((state) => state.recordMode);
  const toggleRecording = useUiStore((state) => state.toggleRecording);
  const engineStatus = useEngineStore((state) => state.status);
  const engineInfo = useEngineStore((state) => state.info);
  const missingMethods = useEngineStore((state) => state.missingMethods);
  const selfCheck = useEngineStore((state) => state.selfCheck);
  const restartEngine = useEngineStore((state) => state.restart);
  const staleEngine = missingMethods.length > 0;

  const device = activeDevice(devices, activeId);

  return (
    // 顶栏同样允许换行：窗口窄/按钮多的时候不会把右边的状态挤没
    <header className="flex min-h-9 shrink-0 flex-wrap items-center gap-y-0.5 bg-panel pr-2">
      <span className="px-3 text-[15px] font-medium tracking-wide">GamePilot</span>
      <VDivider />
      <ProjectMenu />
      <VDivider />

      {/* 运行/停止：作用域是"当前设备"（不是状态图本身），所以常驻顶栏设备选择器旁 */}
      <RunButton />
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
          {device ? `${device.name} · ${formatResolution(device.resolution)}` : '未连接设备'}
        </span>
        <ChevronDown className="size-3.5 text-dim" />
      </button>

      <VDivider />
      <GridToggle />

      <div className="flex-1" />

      <LayoutMenu />
      <VDivider />

      <ToolbarButton
        title={
          staleEngine
            ? `引擎是旧进程（缺 ${missingMethods.length} 个方法）：点这里重启引擎`
            : `${engineInfo} · 点这里重新自检/启动`
        }
        onClick={() => void (staleEngine ? restartEngine() : selfCheck())}
      >
        <Cable
          className={cn(
            'size-3.5',
            engineStatus === 'ready' && !staleEngine && 'text-confirmed',
            (engineStatus === 'error' || staleEngine) && 'text-failed',
            engineStatus === 'connecting' && 'text-pending',
          )}
        />
        <span
          className={cn(
            (engineStatus === 'error' || staleEngine) && 'text-failed',
            engineStatus === 'ready' && !staleEngine && 'text-confirmed',
            engineStatus === 'idle' && 'text-dim',
          )}
        >
          {staleEngine ? '引擎旧进程 · 重启' : engineLabel(engineStatus)}
        </span>
      </ToolbarButton>
      <VDivider />
      <span className="px-2 text-badge text-faint">─ □ ✕</span>
    </header>
  );
}

function engineLabel(status: 'idle' | 'connecting' | 'ready' | 'error'): string {
  switch (status) {
    case 'ready':
      return '引擎已就绪';
    case 'connecting':
      return '引擎启动中…';
    case 'error':
      return '引擎启动失败 · 重试';
    default:
      return '引擎未连接 · 点击启动';
  }
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
