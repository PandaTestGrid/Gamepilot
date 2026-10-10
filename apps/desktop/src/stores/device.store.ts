/**
 * 设备 store：多设备是**一等公民**（DESIGN.md §4.6）。
 *
 * 同时只允许一个「活动设备」驱动中央状态图与事件流，但允许多个设备保持连接
 * 并在多开网格 / 独立窗口里同时运行。
 *
 * M1 起 `connect` 会换成 `engine_rpc('device.connect', { uri })` + 订阅 `device.*` 通知；
 * 现在的延时是模拟连接过程，让人能看到状态机与阶段文案。
 */
import { create } from 'zustand';

import { MOCK_DEVICES } from '@/mock/seed';
import type { DeviceRuntime } from '@/types';

export const MAX_ACTIVE_DEVICES = 4;

interface DeviceState {
  readonly devices: readonly DeviceRuntime[];
  readonly activeId: string;
  readonly gridView: boolean;
  readonly setActive: (id: string) => void;
  readonly connect: (id: string) => void;
  readonly markConnected: (id: string) => void;
  readonly failConnect: (id: string, error: string) => void;
  readonly disconnect: (id: string) => void;
  readonly toggleGrid: () => void;
  readonly markWindowed: (id: string, windowed: boolean) => void;
}

function patch(
  list: readonly DeviceRuntime[],
  id: string,
  patchValue: Partial<DeviceRuntime>,
): DeviceRuntime[] {
  return list.map((device) => (device.id === id ? { ...device, ...patchValue } : device));
}

export const useDeviceStore = create<DeviceState>()((set, get) => ({
  devices: MOCK_DEVICES,
  activeId: MOCK_DEVICES[0]?.id ?? '',
  gridView: false,

  setActive: (id) => set({ activeId: id }),

  connect: (id) => {
    set((state) => ({ devices: patch(state.devices, id, { status: 'connecting', error: undefined }) }));
    // M1：换成真实 RPC；这里模拟「adb 连接 → 读取分辨率 → 首帧截图」
    setTimeout(() => {
      const device = get().devices.find((item) => item.id === id);
      if (device?.status === 'connecting') {
        get().markConnected(id);
      }
    }, 700);
  },

  markConnected: (id) =>
    set((state) => {
      const current = state.devices.find((item) => item.id === id);
      return {
        devices: patch(state.devices, id, {
          status: 'connected',
          fps: current?.fps && current.fps > 0 ? current.fps : 10,
          error: undefined,
        }),
      };
    }),

  failConnect: (id, error) =>
    set((state) => ({
      devices: patch(state.devices, id, {
        status: 'failed',
        fps: 0,
        error,
        suggestedFix: '重新检测设备连接',
      }),
    })),

  disconnect: (id) =>
    set((state) => {
      const remaining = patch(state.devices, id, { status: 'discovered', fps: 0, windowed: false });
      const stillConnected = remaining.filter((item) => item.status === 'connected');
      const needSwitch = state.activeId === id;
      return {
        devices: remaining,
        gridView: stillConnected.length >= 2 ? state.gridView : false,
        activeId: needSwitch ? (stillConnected[0]?.id ?? id) : state.activeId,
      };
    }),

  toggleGrid: () => set((state) => ({ gridView: !state.gridView })),

  markWindowed: (id, windowed) => set((state) => ({ devices: patch(state.devices, id, { windowed }) })),
}));

/** 派生：已连接的设备（组件里用 useMemo 调用，避免选择器返回新数组导致重渲染） */
export function connectedDevices(devices: readonly DeviceRuntime[]): DeviceRuntime[] {
  return devices.filter((device) => device.status === 'connected');
}

export function activeDevice(devices: readonly DeviceRuntime[], activeId: string): DeviceRuntime | null {
  return devices.find((device) => device.id === activeId) ?? null;
}
