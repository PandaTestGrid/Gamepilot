/**
 * 设备弹层的纯逻辑：**分类 / 过滤 / 排序**，全部是不碰 React 的函数（可单测）。
 *
 * 为什么单独一个文件：设备来源已经有 安卓 / 模拟器 / iOS / 本机窗口 四种，
 * 而且本机窗口那边是**一个伪设备 + 一串窗口**两条数据路径（见 DevicePopover）。
 * 把"哪些算一类、怎么排、搜什么"收敛在这里，界面只负责画。
 */
import type { DotTone } from '@/layout/PanelShell';
import type { DeviceKind, DeviceRuntime, DeviceStatus } from '@/types';

/** 设备弹层的分类 Tab；`window` = 本机窗口（Windows + macOS 通用）。 */
export type DeviceTabId = 'all' | 'android' | 'emulator' | 'ios' | 'window' | 'other';

export interface DeviceTab {
  readonly id: DeviceTabId;
  readonly label: string;
  /** 这一类里有多少台（macOS 那一类是"可选窗口"数，见下） */
  readonly count: number;
}

/** 设备状态 → 状态点语义色（列表与画面栏共用一套，避免两处色号不一致） */
export function statusTone(status: DeviceStatus): DotTone {
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

export function kindLabel(kind: DeviceKind): string {
  switch (kind) {
    case 'android':
      return '安卓';
    case 'ios':
      return 'iOS';
    case 'emulator':
      return '模拟器';
    case 'windows':
      return '本机窗口';
    default:
      return '远程';
  }
}

/**
 * 本机窗口在引擎里是两条数据（Windows / macOS 同一套形状）：
 *   - `macos:picker` / `windows:picker`：**伪设备**，只是"这里有 N 个窗口"的入口，
 *     点它连接没有意义；
 *   - `Mac:///?window=<句柄>` / `Windows:///?hwnd=<句柄>`：真正连上的窗口
 *     （id 形如 `macos:89` / `windows:6698742`）。
 */
export function isWindowDevice(device: DeviceRuntime): boolean {
  return device.id.startsWith('macos:') || device.id.startsWith('windows:');
}

export function isWindowPicker(device: DeviceRuntime): boolean {
  return device.id.endsWith(':picker');
}

/** 可连设备：去掉本机窗口伪入口。模拟器附屏也是可连项（MuMu 每个应用标签页一块屏）。 */
export function connectableDevices(devices: readonly DeviceRuntime[]): DeviceRuntime[] {
  return devices.filter((device) => !isWindowPicker(device));
}

/** 当前激活的设备排最前，其余按"已连接 > 连接中 > 失败 > 未连接"排，同类按名字。 */
export function sortForDisplay(devices: readonly DeviceRuntime[], activeId: string): DeviceRuntime[] {
  const rank = (device: DeviceRuntime): number => {
    if (device.id === activeId) {
      return 0;
    }
    switch (device.status) {
      case 'connected':
        return 1;
      case 'connecting':
        return 2;
      case 'failed':
        return 3;
      default:
        return 4;
    }
  };
  return [...devices].sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) {
      return byRank;
    }
    if (left.kind !== right.kind) {
      return left.kind.localeCompare(right.kind);
    }
    return left.name.localeCompare(right.name, 'zh-Hans-CN');
  });
}

/** 搜索：名字 / URI / 来源 / 型号都算（粘贴 URI 也能直接命中）。 */
export function matchDeviceQuery(device: DeviceRuntime, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return true;
  }
  return `${device.name} ${device.uri} ${device.kind} ${device.model ?? ''}`.toLowerCase().includes(trimmed);
}

export function filterByTab(devices: readonly DeviceRuntime[], tab: DeviceTabId): DeviceRuntime[] {
  switch (tab) {
    case 'all':
      return [...devices];
    case 'android':
      return devices.filter((device) => device.kind === 'android');
    case 'emulator':
      return devices.filter((device) => device.kind === 'emulator');
    case 'ios':
      return devices.filter((device) => device.kind === 'ios');
    case 'window':
      return devices.filter(isWindowDevice);
    default:
      return devices.filter(
        (device) =>
          !isWindowDevice(device) &&
          device.kind !== 'android' &&
          device.kind !== 'emulator' &&
          device.kind !== 'ios',
      );
  }
}

/**
 * 旧的持久化 Tab 值迁移：macOS 专用时期存过 `'mac'`，现在统一叫 `'window'`。
 * 未知值一律退化成 `'all'` —— 宁可回到"全部"，也不能让界面落在不存在的分类上。
 */
export function normalizeDeviceTab(value: unknown): DeviceTabId {
  if (value === 'mac') {
    return 'window';
  }
  switch (value) {
    case 'all':
    case 'android':
    case 'emulator':
    case 'ios':
    case 'window':
    case 'other':
      return value;
    default:
      return 'all';
  }
}

/** Tab 列表：**只显示有内容的分类**（空分类占位置还会让人以为"设备不见了"）。 */
export function buildDeviceTabs(devices: readonly DeviceRuntime[]): DeviceTab[] {
  const specs: ReadonlyArray<{ id: DeviceTabId; label: string }> = [
    { id: 'all', label: '全部' },
    { id: 'android', label: '安卓' },
    { id: 'emulator', label: '模拟器' },
    { id: 'ios', label: 'iOS' },
    { id: 'window', label: '本机窗口' },
    { id: 'other', label: '其它' },
  ];
  const connectable = connectableDevices(devices);
  return (
    specs
      // picker 本身不能连接，但它是本机窗口 Tab 的入口；否则一台窗口都没连时连 Tab 也消失。
      .map((spec) => ({
        ...spec,
        count: filterByTab(spec.id === 'window' ? devices : connectable, spec.id).length,
      }))
      .filter((tab) => tab.id === 'all' || tab.count > 0)
  );
}

/** 打开弹层时落在哪个 Tab：当前 Tab 没内容就退到第一个有内容的分类（优先"全部"）。 */
export function resolveTab(tab: DeviceTabId, tabs: readonly DeviceTab[]): DeviceTabId {
  const exists = tabs.find((item) => item.id === tab && item.count > 0);
  if (exists) {
    return exists.id;
  }
  const fallback = tabs.find((item) => item.id !== 'all' && item.count > 0) ?? tabs[0];
  return fallback?.id ?? 'all';
}
