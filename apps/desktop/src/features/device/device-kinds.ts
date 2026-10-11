/**
 * 设备弹层的纯逻辑：**分类 / 过滤 / 排序**，全部是不碰 React 的函数（可单测）。
 *
 * 为什么单独一个文件：设备来源已经有 安卓 / 模拟器 / iOS / 本机窗口(macOS) / Mock 五种，
 * 而且 macOS 那边是**一个伪设备 + 一串窗口**两条数据路径（见 DevicePopover）。
 * 把"哪些算一类、怎么排、搜什么"收敛在这里，界面只负责画。
 */
import type { DotTone } from '@/layout/PanelShell';
import type { DeviceKind, DeviceRuntime, DeviceStatus } from '@/types';

export type DeviceTabId = 'all' | 'android' | 'ios' | 'mac' | 'mock' | 'other';

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
    case 'mock':
      return 'Mock';
    default:
      return '远程';
  }
}

/**
 * macOS 的本机窗口在引擎里是两条数据：
 *   - `macos:picker`：**伪设备**，只是"这里有 N 个窗口"的入口，点它连接没有意义；
 *   - `Mac:///?window=<句柄>`：真正连上的那些窗口（id 形如 `macos:89`）。
 */
export function isMacDevice(device: DeviceRuntime): boolean {
  return device.id.startsWith('macos:');
}

export function isMacPicker(device: DeviceRuntime): boolean {
  return device.id === 'macos:picker';
}

/** 列表里可连接的设备（把伪设备摘掉——它只用来在 Tab 上提示"有几个窗口"） */
export function connectableDevices(devices: readonly DeviceRuntime[]): DeviceRuntime[] {
  return devices.filter((device) => !isMacPicker(device));
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
      // 模拟器就是安卓模拟器，和真机放一类更符合直觉
      return devices.filter((device) => device.kind === 'android' || device.kind === 'emulator');
    case 'ios':
      return devices.filter((device) => device.kind === 'ios');
    case 'mac':
      return devices.filter(isMacDevice);
    case 'mock':
      return devices.filter((device) => device.kind === 'mock');
    default:
      return devices.filter(
        (device) =>
          !isMacDevice(device) &&
          device.kind !== 'android' &&
          device.kind !== 'emulator' &&
          device.kind !== 'ios' &&
          device.kind !== 'mock',
      );
  }
}

/** Tab 列表：**只显示有内容的分类**（空分类占位置还会让人以为"设备不见了"）。 */
export function buildDeviceTabs(devices: readonly DeviceRuntime[]): DeviceTab[] {
  const specs: ReadonlyArray<{ id: DeviceTabId; label: string }> = [
    { id: 'all', label: '全部' },
    { id: 'android', label: '安卓' },
    { id: 'ios', label: 'iOS' },
    { id: 'mac', label: '本机窗口' },
    { id: 'mock', label: 'Mock' },
    { id: 'other', label: '其它' },
  ];
  const connectable = devices;
  return specs
    .map((spec) => ({ ...spec, count: filterByTab(connectable, spec.id).length }))
    .filter((tab) => tab.id === 'all' || tab.count > 0);
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
