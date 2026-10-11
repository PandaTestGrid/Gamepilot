/**
 * 运行/停止的**唯一控制器**（顶栏与状态图头部共用一份）。
 *
 * 先明确作用域，避免"运行"被理解成状态图的一部分：
 *   - 状态图 = 脚本数据（`graph.json` → 节点/边/识别器），每个设备会话各加载一份
 *   - 运行   = **设备会话上的开关**（引擎侧 `DeviceSession.running`，RPC 只收 `deviceId`）
 * 所以"运行"永远是"让**当前这台设备**按当前这份图跑"，多开时每台各跑一份；
 * 不运行时引擎照样在识别（画面上的框、读数、阈值都实时），只是不决策、不发动作。
 *
 * 顶栏与图栏头都放按钮，是为了"就近"与"任何布局下都在"，但状态与禁用原因只能有一份 ——
 * 也就是这个 hook：同一个 `running[deviceId]`、同一个 `blocker`，不产生第二份真源。
 */
import { useCallback } from 'react';

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
  const nodeCount = useGraphStore((state) => graphForDevice(state, activeId)?.nodes.length ?? 0);
  const running = useSessionStore((state) => Boolean(state.running[activeId]));
  const startRun = useSessionStore((state) => state.startRun);
  const stopRun = useSessionStore((state) => state.stopRun);

  const device = activeDevice(devices, activeId);
  // 运行按钮必须说清"为什么现在不能跑"，而不是点了没反应
  const blocker = !device
    ? '先在设备面板里选择并连接一台设备'
    : device.status !== 'connected'
      ? '设备还没连上（点顶栏设备名 → 连接）'
      : nodeCount === 0
        ? '状态图里还没有节点：先在画面栏点「框选」录一个界面元素'
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
