/**
 * 顶部条：设备标签（左）+ 引擎状态（右）。
 *
 * 多设备的核心入口（DESIGN.md §4.6）：
 *   - 每个「已连接」设备一个标签（状态点 + 名称）；**帧率只在底栏指标行显示一处**
 *   - 点击 = 切换活动设备（状态图/事件/识别器/底栏一起跟着切）
 *   - 双击 = 在独立窗口打开该设备画面（Tauri 多窗口）
 *   - 右键菜单：断开 / 复制 URI / 独立窗口
 *
 * 它也是界面上**唯一**的顶部条：原来那条独立工具栏（品牌 / 运行 / 录制 / 设备选择器 / 多开 / 工作流）
 * 已经删掉 —— 那些入口都在就近的面板里（见 docs/DESIGN.md §4.2 A），
 * 引擎状态保留在这一排右端；布局预设入口已移除，避免和现有面板布局控制重复。
 */
import { Cable, MonitorUp, PanelBottom, PanelLeft, PanelRight, Plus, X } from 'lucide-react';
import { type ReactNode } from 'react';

import { taskName } from '@/features/graph/task-name';
import { StatusDot, ToolbarButton, VDivider, type DotTone } from '@/layout/PanelShell';
import { deviceRunLabel } from '@/lib/flow-run-attribution';
import { jumpToDeviceAndWorkflow } from '@/lib/jump-to-run';
import { cn } from '@/lib/utils';
import { openPaneWindow } from '@/lib/windows';
import { useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
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
  // fps 必须读会话里的实时帧：device.fps 没人更新，之前标签永远显示 0fps
  const runningWorkflowRoots = useSessionStore((state) => state.runningWorkflowRoots);
  const markWindowed = useDeviceStore((state) => state.markWindowed);
  const toggleDevicePopover = useUiStore((state) => state.toggleDevicePopover);
  const connected = devices.filter(
    (device) => device.status === 'connected' || device.status === 'connecting',
  );
  const executingCount = connected.filter(
    (device) => (runningWorkflowRoots[device.id] ?? []).length > 0,
  ).length;

  return (
    <div className="flex h-7 min-w-0 shrink-0 items-center gap-1 overflow-hidden border-b border-line bg-panel px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {connected.map((device) => {
          const active = device.id === activeId;
          const liveRoots = runningWorkflowRoots[device.id] ?? [];
          const liveName = deviceRunLabel(liveRoots.map(taskName));
          const live = Boolean(liveName);
          return (
            <div
              key={device.id}
              data-testid={`device-tab-${device.id}`}
              className={cn(
                'group flex h-5 min-w-0 items-center gap-1.5 rounded-sm pr-1 pl-2',
                active ? 'bg-active text-fg' : 'text-dim hover:bg-raised',
              )}
            >
              <button
                type="button"
                onClick={() => {
                  const runningRoot = liveRoots[0];
                  if (runningRoot) {
                    jumpToDeviceAndWorkflow(device.id, runningRoot);
                  } else {
                    setActive(device.id);
                  }
                }}
                onDoubleClick={() => void openDeviceScreenWindow(device.id, markWindowed)}
                title={
                  live
                    ? `${device.name} · 运行中 · ${liveRoots.map(taskName).join('、')}\n单击跳转到这台设备和脚本 · 双击独立窗口`
                    : `${device.uri}\n单击切换 · 双击独立窗口`
                }
                className="flex min-w-0 items-center gap-1.5"
              >
                <StatusDot tone={TONE[device.status] ?? 'idle'} />
                <span className="min-w-0 truncate text-body">{device.name}</span>
                {live ? (
                  <span className="max-w-[8rem] shrink-0 truncate text-badge">{liveName}</span>
                ) : (
                  <span className="shrink-0 text-badge text-faint">
                    {/* 帧率只在底栏那一处显示（这里以前也写一遍，一格画面同时看到三个 31fps） */}
                    {device.status === 'connecting'
                      ? '连接中…'
                      : device.status === 'failed'
                        ? '连接失败'
                        : device.status === 'connected'
                          ? null
                          : '未连接'}
                  </span>
                )}
              </button>
              <button
                type="button"
                title="在独立窗口打开"
                onClick={() => void openDeviceScreenWindow(device.id, markWindowed)}
                className="hidden shrink-0 opacity-0 group-hover:opacity-100 sm:flex"
              >
                <MonitorUp className="size-3 text-dim hover:text-fg" />
              </button>
              <button
                type="button"
                title="断开"
                onClick={() => void disconnect(device.id)}
                className="hidden shrink-0 opacity-0 group-hover:opacity-100 sm:flex"
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
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-dim hover:bg-raised hover:text-fg"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      <span className="min-w-0 max-w-[11rem] shrink truncate text-badge text-faint">
        {executingCount > 0
          ? `${connected.length} 台已连接 · ${executingCount} 台在执行`
          : `${connected.length} 台已连接 · 上限 4 台`}
      </span>
      <VDivider />
      <PaneToggles />
      <EngineStatus />
    </div>
  );
}

/**
 * 顶部栏右侧的面板显隐按钮组（类似 VS Code / Cursor 的左栏、底栏、右栏开关）。
 */
function PaneToggles(): ReactNode {
  const leftPaneOpen = useUiStore((state) => state.leftPaneOpen);
  const flowDockOpen = useUiStore((state) => state.flowDockOpen);
  const rightPaneOpen = useUiStore((state) => state.rightPaneOpen);
  const toggleLeftPane = useUiStore((state) => state.toggleLeftPane);
  const toggleFlowDock = useUiStore((state) => state.toggleFlowDock);
  const toggleRightPane = useUiStore((state) => state.toggleRightPane);

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={toggleLeftPane}
        title={leftPaneOpen ? '收起左侧栏（画面与素材区）' : '展开左侧栏（画面与素材区）'}
        aria-label={leftPaneOpen ? '收起左侧栏' : '展开左侧栏'}
        className={cn(
          'flex size-5 items-center justify-center rounded-sm transition-colors',
          leftPaneOpen ? 'bg-active text-fg' : 'text-dim hover:bg-raised hover:text-fg',
        )}
      >
        <PanelLeft className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={toggleFlowDock}
        title={flowDockOpen ? '收起控制台/配置抽屉' : '展开控制台/配置抽屉'}
        aria-label={flowDockOpen ? '收起控制台抽屉' : '展开控制台抽屉'}
        className={cn(
          'flex size-5 items-center justify-center rounded-sm transition-colors',
          flowDockOpen ? 'bg-active text-fg' : 'text-dim hover:bg-raised hover:text-fg',
        )}
      >
        <PanelBottom className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={toggleRightPane}
        title={rightPaneOpen ? '收起右侧栏（工作区 / 识别器）' : '展开右侧栏（工作区 / 识别器）'}
        aria-label={rightPaneOpen ? '收起右侧栏' : '展开右侧栏'}
        className={cn(
          'flex size-5 items-center justify-center rounded-sm transition-colors',
          rightPaneOpen ? 'bg-active text-fg' : 'text-dim hover:bg-raised hover:text-fg',
        )}
      >
        <PanelRight className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * 引擎状态：常驻状态 + 旧进程一键重启。
 *
 * 引擎是应用启动时拉起的**独立进程**：改了引擎代码但没重启，界面上就会出现"未知方法"这类错，
 * 而这里（以及错误条）是唯一的解法入口，所以哪怕顶部条压缩到只剩一排也要留着。
 */
function EngineStatus(): ReactNode {
  const engineStatus = useEngineStore((state) => state.status);
  const engineInfo = useEngineStore((state) => state.info);
  const missingMethods = useEngineStore((state) => state.missingMethods);
  const selfCheck = useEngineStore((state) => state.selfCheck);
  const restartEngine = useEngineStore((state) => state.restart);
  const staleEngine = missingMethods.length > 0;

  return (
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
  );
}

async function openDeviceScreenWindow(
  deviceId: string,
  markWindowed: (id: string, windowed: boolean) => void,
): Promise<void> {
  try {
    await openPaneWindow('screen', deviceId);
    markWindowed(deviceId, true);
  } catch (error) {
    useSessionStore.setState({
      error: error instanceof Error ? error.message : `无法打开独立窗口：${String(error)}`,
    });
  }
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
