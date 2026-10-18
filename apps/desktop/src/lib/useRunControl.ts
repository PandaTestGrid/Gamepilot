/**
 * 运行/停止的**唯一控制器**（工作流画布头部，见 layout/RunButton.tsx）。
 * 工作流 = 当前 `graph.json`；运行 = 当前设备上**当前这份工作流**的开关。
 */
import { useCallback } from 'react';

import { useCurrentWorkflowRunning } from '@/lib/useLiveWorkflow';
import { activeDevice, useDeviceStore } from '@/stores/device.store';
import { graphForDevice, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';

export interface RunControl {
  /** 当前活动设备是否在跑 */
  readonly running: boolean;
  /** 当前活动设备名（没有设备时 null），用于按钮文案/标题 */
  readonly deviceName: string | null;
  /** null = 可以跑；否则是"为什么不能跑"，直接当按钮的 title */
  readonly blocker: string | null;
  /** 运行 ⇄ 停止（被 blocker 挡住时调用无效果） */
  readonly toggle: () => void;
}

export function useRunControl(): RunControl {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const graph = useGraphStore((state) => graphForDevice(state, activeId));
  const flowStepCount = graph?.flow?.steps.length ?? 0;
  const running = useCurrentWorkflowRunning();
  const startRun = useSessionStore((state) => state.startRun);
  const stopRun = useSessionStore((state) => state.stopRun);

  const device = activeDevice(devices, activeId);
  const blocker = !device
    ? '先在设备面板里选择并连接一台设备'
    : device.status !== 'connected'
      ? '设备还没连上（在设备标签条那台点一下，或用画面栏的「连接设备」）'
      : flowStepCount === 0
        ? '工作流还是空的：左侧拖模块到画布'
        : null;

  const toggle = useCallback(() => {
    if (!activeId || blocker) {
      return;
    }
    if (running) {
      void stopRun(activeId);
    } else {
      void startRun(activeId);
    }
  }, [activeId, blocker, running, startRun, stopRun]);

  return { running, deviceName: device?.name ?? null, blocker, toggle };
}
