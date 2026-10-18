/**
 * 设备 store：多设备是一等公民（DESIGN.md §4.6）。
 *
 * 数据来源分两种，注意别混：
 *   1. **扫描结果**（`scan()` → 引擎 `device.list`）——真实 adb 设备列表，
 *      每次刷新整体替换掉"非连接中"的条目；
 *   2. **连接态**（connect/disconnect/截图恢复）——由引擎 `device.*` 通知驱动。
 *
 * 合并规则：**已连接/连接中的设备不被扫描结果覆盖**（它们有活的会话），
 * 其余全量替换。这样刷新不会把正在跑的设备踢掉。
 */
import { create } from 'zustand';

import { androidAddress, isSecondaryAndroidDisplay } from '@/features/device/emulator-displays';
import { type DeviceInfoPayload, listDevices } from '@/lib/rpc';
import type { DeviceKind, DeviceRuntime, DeviceStatus } from '@/types';

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
  /** 模拟器屏号枚举偶尔只返回主屏；移除活会话前要复核一次。 */
  readonly missingDisplays: Readonly<Record<string, number>>;
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
  /** 引擎重启后旧会话都没了，扫描前先去掉界面里的假「已连接」。 */
  readonly resetConnections: () => void;
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
  removed: ReadonlySet<string> = new Set(),
  retained: ReadonlySet<string> = new Set(),
): { devices: DeviceRuntime[]; activeId: string } {
  const scanned = new Map(incoming.map((device) => [device.id, device]));
  const live = current
    .filter(
      (device) =>
        (device.status === 'connected' || device.status === 'connecting' || retained.has(device.id)) &&
        !removed.has(device.id),
    )
    .map((device) => {
      const fresh = scanned.get(device.id);
      // 逻辑屏号会重排，但物理 id 不变；保留会话态，更新屏号/URI/窗口名。
      return fresh ? { ...device, name: fresh.name, uri: fresh.uri } : device;
    });
  const liveIds = new Set(live.map((device) => device.id));
  const devices = [...live, ...incoming.filter((device) => !liveIds.has(device.id))];
  const stillThere = devices.some((device) => device.id === activeId);
  const nextActive = stillThere
    ? activeId
    : (devices.find((device) => device.status === 'connected')?.id ?? devices[0]?.id ?? '');
  return { devices, activeId: nextActive };
}

/** 同一台模拟器仍可扫描到，但某块附屏的物理 id 消失：它已被关闭，不能保留旧连接。 */
export function vanishedEmulatorDisplays(
  current: readonly DeviceRuntime[],
  incoming: readonly DeviceRuntime[],
): DeviceRuntime[] {
  const seen = new Set(incoming.map((device) => device.id));
  const emulatorSerials = new Set(
    incoming
      .filter((device) => device.kind === 'emulator')
      .map((device) => androidAddress(device.uri))
      .filter((address) => address?.display === 0)
      .map((address) => address?.serial),
  );
  return current.filter((device) => {
    if (!isSecondaryAndroidDisplay(device) || seen.has(device.id)) {
      return false;
    }
    const address = androidAddress(device.uri);
    return Boolean(address && emulatorSerials.has(address.serial));
  });
}

function patch(list: readonly DeviceRuntime[], id: string, value: Partial<DeviceRuntime>): DeviceRuntime[] {
  return list.map((device) => (device.id === id ? { ...device, ...value } : device));
}

export const useDeviceStore = create<DeviceState>()((set, get) => ({
  devices: [],
  activeId: '',
  gridView: false,
  scanState: 'idle',
  scanErrors: [],
  scanError: null,
  lastScanAt: null,
  missingDisplays: {},

  scan: async () => {
    if (get().scanState === 'scanning') return;
    set({ scanState: 'scanning', scanError: null });
    try {
      let result = await listDevices(true);
      const initial = get().devices;
      const androidFailed = result.errors.some((error) => error.provider === 'android');
      const firstMissing = androidFailed
        ? []
        : vanishedEmulatorDisplays(initial, result.devices.map(toRuntimeDevice));
      const confirmed = new Set<string>();
      if (firstMissing.length > 0) {
        // 一次 dumpsys 抖动不能把活会话踢掉；同一轮刷新里复核一次，
        // 而不是要求用户手动点两次「刷新」才能移走确实关闭的黑屏槽位。
        const checked = await listDevices(true);
        if (checked.errors.some((error) => error.provider === 'android')) {
          result = { ...result, errors: [...result.errors, ...checked.errors] };
        } else {
          result = checked;
          const absent = new Set(
            vanishedEmulatorDisplays(initial, checked.devices.map(toRuntimeDevice)).map((item) => item.id),
          );
          for (const item of firstMissing) {
            if (absent.has(item.id)) confirmed.add(item.id);
          }
        }
      }
      const incoming = result.devices.map(toRuntimeDevice);
      const { useSessionStore } = await import('@/stores/session.store');
      const ready = useSessionStore.getState().ready;
      let vanished: DeviceRuntime[] = [];
      set((state) => {
        const missing = result.errors.some((error) => error.provider === 'android')
          ? []
          : vanishedEmulatorDisplays(state.devices, incoming);
        const counts = Object.fromEntries(
          missing.map((device) => [
            device.id,
            (state.missingDisplays[device.id] ?? 0) + (confirmed.has(device.id) ? 2 : 1),
          ]),
        );
        vanished = missing.filter(
          (device) =>
            (counts[device.id] ?? 0) >= 2 &&
            (device.status === 'connected' || device.status === 'connecting' || ready[device.id]),
        );
        const merged = mergeScan(
          state.devices,
          incoming,
          state.activeId,
          new Set(vanished.map((device) => device.id)),
          new Set(Object.keys(ready).filter((id) => ready[id])),
        );
        return {
          devices: merged.devices,
          activeId: merged.activeId,
          scanState: 'idle',
          scanErrors: result.errors.map((error) => `${error.provider}: ${error.message}`),
          lastScanAt: Date.now(),
          missingDisplays: result.errors.some((error) => error.provider === 'android')
            ? state.missingDisplays
            : counts,
        };
      });
      if (vanished.length > 0) {
        // 两次独立扫描都确认缺席才停旧会话；本次「刷新」已完成两次复核。
        await Promise.all(vanished.map((device) => useSessionStore.getState().disconnect(device.id)));
      }
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
        suggestedFix: '点「重试」重新连接；如果模拟器窗口已关闭，先刷新屏幕列表',
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

  resetConnections: () =>
    set((state) => ({
      devices: state.devices.map((device) => ({
        ...device,
        status: 'discovered' as const,
        fps: 0,
        windowed: false,
        error: undefined,
      })),
      gridView: false,
      missingDisplays: {},
    })),

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
