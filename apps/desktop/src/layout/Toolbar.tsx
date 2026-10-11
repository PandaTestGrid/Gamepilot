import { Cable, ChevronDown, CirclePlay, LayoutGrid, Redo2, Square, Undo2, Video } from 'lucide-react';
import { type ReactNode } from 'react';

import { ProjectMenu } from '@/layout/ProjectMenu';
import { ToolbarButton, VDivider } from '@/layout/PanelShell';
import { formatResolution } from '@/lib/format';
import { cn } from '@/lib/utils';
import { activeDevice, useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';
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
  // 运行按钮要说清"为什么现在不能跑"，而不是点了没反应
  const nodes = useGraphStore((state) => state.graphs[activeId]?.nodes.length ?? 0);
  const runBlocker = !device
    ? '先在设备面板里选择并连接一台设备'
    : device.status !== 'connected'
      ? '设备还没连上（点顶栏设备名 → 连接）'
      : nodes === 0
        ? '状态图里还没有节点：先在画面栏点「框选」录一个界面元素'
        : null;

  return (
    // 顶栏同样允许换行：窗口窄/按钮多的时候不会把右边的状态挤没
    <header className="flex min-h-9 shrink-0 flex-wrap items-center gap-y-0.5 bg-panel pr-2">
      <span className="px-3 text-[15px] font-medium tracking-wide">GamePilot</span>
      <VDivider />
      <ProjectMenu />
      <VDivider />

      <ToolbarButton
        onClick={runBlocker ? undefined : onToggleRun}
        active={running}
        disabled={Boolean(runBlocker)}
        title={runBlocker ?? '开始按状态图跑（需要先连接设备并录好节点）'}
      >
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
          {device ? `${device.name} · ${formatResolution(device.resolution)}` : '未连接设备'}
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
            engineStatus === 'connecting' && 'text-pending',
          )}
        />
        <span
          className={cn(
            engineStatus === 'error' && 'text-failed',
            engineStatus === 'ready' && 'text-confirmed',
            engineStatus === 'idle' && 'text-dim',
          )}
        >
          {engineLabel(engineStatus)}
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
