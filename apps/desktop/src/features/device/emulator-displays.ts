import type { DeviceRuntime } from '@/types';

export interface EmulatorDisplay {
  readonly id: number;
  readonly device: DeviceRuntime;
  /** 引擎目前只能给出顶层应用包名；拿不到时不猜应用名称。 */
  readonly app: string | null;
}

export function androidAddress(uri: string): { serial: string; display: number } | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol.toLowerCase() !== 'android:') {
      return null;
    }
    const serial = parsed.searchParams.get('serial');
    const rawDisplay = parsed.searchParams.get('display');
    const display = rawDisplay === null ? 0 : Number(rawDisplay);
    if (!serial || !Number.isSafeInteger(display) || display < 0) {
      return null;
    }
    return { serial, display };
  } catch {
    return null;
  }
}

/** 附屏是独立可连设备：设备选择器单独成行，画面栏也可从「添加屏幕」接入。 */
export function isSecondaryAndroidDisplay(device: DeviceRuntime): boolean {
  const address = androidAddress(device.uri);
  return address !== null && address.display !== 0;
}

/** 按 adb serial 分组；屏号取 URI 的逻辑 display id，不能按设备名/冒号拆（无线 adb 串口也带冒号）。 */
export function emulatorDisplaysFor(
  devices: readonly DeviceRuntime[],
  current: DeviceRuntime | null,
): EmulatorDisplay[] {
  if (!current) {
    return [];
  }
  const address = androidAddress(current.uri);
  if (!address) {
    return [];
  }
  const displays = devices.flatMap((device): EmulatorDisplay[] => {
    const found = androidAddress(device.uri);
    if (!found || found.serial !== address.serial) {
      return [];
    }
    const marker = ` · 屏${found.display} · `;
    const name = device.name;
    const app = name.includes(marker) ? name.slice(name.indexOf(marker) + marker.length).trim() : '';
    return [{ id: found.display, device, app: app || null }];
  });
  // 单屏真机不增加多余控件；模拟器即使还没发现第二屏，也要有可见的「刷新」入口。
  return displays.length > 1 || current.kind === 'emulator'
    ? displays.sort((left, right) => left.id - right.id)
    : [];
}
