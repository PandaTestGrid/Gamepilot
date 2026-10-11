/**
 * 设备 store：多设备是一等公民（DESIGN.md §4.6）。
 *
 * 数据来源分两种，注意别混：
 *   1. **扫描结果**（`scan()` → 引擎 `device.list`）——真实 adb 设备列表，
 *      每次刷新整体替换掉"非连接中"的条目；
 *   2. **连接态**（connect/disconnect/心跳）——由引擎 `device.*` 通知驱动，
 *      第 2 块接入；现在用定时器模拟连接过程。
 *
 * 合并规则：**已连接/连接中的设备不被扫描结果覆盖**（它们有活的会话），
 * 其余全量替换。这样刷新不会把正在跑的设备踢掉。
 */
import { create } from 'zustand';

import { type DeviceInfoPayload, listDevices } from '@/lib/rpc';
import type { DeviceKind, DeviceRuntime, DeviceStatus } from '@/types';

export const MAX_ACTIVE_DEVICES = 4;

/*
 * 白名单写成"穷举 Record"而不是数组：`DeviceKind` 里加了新来源（比如 ios、以后的 harmony），
 * 漏一行 TypeScript 直接报错。之前用数组 + includes，结果 `ios` 被漏掉 ——
 * 所有 iPhone 都被降级成 remote，弹层里的「iOS」分类永远是空的（用户看到的是"设备没被分类"）。
 */
const KINDS: Record<DeviceKind, true> = {
  android: true,
  emulator: true,
  windows: true,
  ios: true,
  mock: true,
  remote: true,
};
const STATUSES: Record<DeviceStatus, true> = {
  idle: true,
  discovered: true,
  connecting: true,
  connected: true,
  failed: true,
};

function asKind(value: unknown): DeviceKind {
  return typeof value === 'string' && value in KINDS ? (value as DeviceKind) : 'remote';
}

function asStatus(value: unknown): DeviceStatus {
  return typeof value === 'string' && value in STATUSES ? (value as DeviceStatus) : 'discovered';
}

export type ScanState = 'idle' | 'scanning' | 'error';

interface DeviceState {
  readonly devices: readonly DeviceRuntime[];
  readonly activeId: string;
  readonly gridView: boolean;
  readonly scanState: ScanState;
  /** 各来源的扫描错误（例如 adb 不可用），UI 要显示出来而不是静默吞掉 */
  readonly scanErrors: readonly string[];
  readonly scanError: string | null;
  readonly lastScanAt: number | null;
  readonly scan: () => Promise<void>;
  readonly setActive: (id: string) => void;
  readonly connect: (id: string) => void;
  readonly markConnected: (id: string) => void;
  readonly markConnectedWith: (
    id: string,
    resolution: readonly [number, number],
    uri?: string,
    name?: string,
    kind?: DeviceKind,
  ) => void;
  readonly failConnect: (id: string, error: string) => void;
  readonly disconnect: (id: string) => void;
  readonly toggleGrid: () => void;
  readonly markWindowed: (id: string, windowed: boolean) => void;
}

/** 引擎返回的 payload → 界面模型。未知枚举值一律降级，不抛异常。 */
export function toRuntimeDevice(info: DeviceInfoPayload): DeviceRuntime {
  const kind = asKind(info.kind);
  const status = asStatus(info.status);
  return {
    id: info.id,
    name: info.name,
    uri: info.uri,
    kind,
    status,
    resolution: info.resolution ? [info.resolution[0], info.resolution[1]] : null,
    fps: 0,
    model: info.model ?? undefined,
    error: info.error ?? undefined,
    suggestedFix: info.suggestedFix ?? undefined,
  };
}

/** 扫描结果与现有设备的合并（纯函数，单测直接覆盖）。 */
export function mergeScan(
  current: readonly DeviceRuntime[],
  incoming: readonly DeviceRuntime[],
  activeId: string,
): { devices: DeviceRuntime[]; activeId: string } {
  const live = current.filter((device) => device.status === 'connected' || device.status === 'connecting');
  const liveIds = new Set(live.map((device) => device.id));
  const devices = [...live, ...incoming.filter((device) => !liveIds.has(device.id))];
  const stillThere = devices.some((device) => device.id === activeId);
  const nextActive = stillThere
    ? activeId
    : (devices.find((device) => device.status === 'connected')?.id ?? devices[0]?.id ?? '');
  return { devices, activeId: nextActive };
}

function patch(list: readonly DeviceRuntime[], id: string, value: Partial<DeviceRuntime>): DeviceRuntime[] {
  return list.map((device) => (device.id === id ? { ...device, ...value } : device));
}

export const useDeviceStore = create<DeviceState>()((set) => ({
  devices: [],
  activeId: '',
  gridView: false,
  scanState: 'idle',
  scanErrors: [],
  scanError: null,
  lastScanAt: null,

  scan: async () => {
    set({ scanState: 'scanning', scanError: null });
    try {
      const result = await listDevices(true);
      set((state) => {
        const merged = mergeScan(state.devices, result.devices.map(toRuntimeDevice), state.activeId);
        return {
          devices: merged.devices,
          activeId: merged.activeId,
          scanState: 'idle',
          scanErrors: result.errors.map((error) => `${error.provider}: ${error.message}`),
          lastScanAt: Date.now(),
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ scanState: 'error', scanError: message });
    }
  },

  setActive: (id) => set({ activeId: id }),

  connect: (id) => {
    // 只把 UI 切到"连接中"；真正的连接由 session.store 调 engine 的 device.connect 完成，
    // 结果通过 markConnectedWith / failConnect 回填（引擎是唯一真源）。
    set((state) => ({ devices: patch(state.devices, id, { status: 'connecting', error: undefined }) }));
  },

  markConnected: (id) =>
    set((state) => ({
      devices: patch(state.devices, id, { status: 'connected', fps: 10, error: undefined }),
    })),

  markConnectedWith: (id, resolution, uri, name, kind) =>
    set((state) => {
      // 直接按 URI 连接时，设备可能还不在列表里（没扫描过）→ 补一条，保证 UI 有的显示
      if (!state.devices.some((device) => device.id === id)) {
        return {
          devices: [
            ...state.devices,
            {
              id,
              // 引擎会给一个人类可读的名字（"wisdom (iOS 26.6.2)" / 窗口标题），没有才退回 id
              name: name || id,
              uri: uri ?? id,
              kind: kind ?? 'remote',
              status: 'connected' as const,
              resolution,
              fps: 0,
            },
          ],
          activeId: state.activeId || id,
        };
      }
      return { devices: patch(state.devices, id, { status: 'connected', resolution, error: undefined }) };
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
      const stillConnected = remaining.filter(
        (item) => item.status === 'connected' || item.status === 'connecting',
      );
      return {
        devices: remaining,
        gridView: stillConnected.length >= 2 ? state.gridView : false,
        activeId: state.activeId === id ? (stillConnected[0]?.id ?? id) : state.activeId,
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
