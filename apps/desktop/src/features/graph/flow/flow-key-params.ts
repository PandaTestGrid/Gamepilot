/**
 * 按键模块（系统键）的平台适配规则：
 * - 不同系统显示的按键不同：
 *   - `android`（安卓真机）：返回 / 主页 / 最近任务 / 电源 / 音量+ / 音量-
 *   - `emulator`（模拟器）：返回 / 主页 / 最近任务（无实体电源/音量键）
 *   - `ios`（iOS）：主页 / 锁屏 / 音量+ / 音量-（无返回和最近任务键）
 * - 部分系统没有按键模块：
 *   - `windows`（本机窗口）：没有手机系统导航键，模块栏不显示「按键」模块
 */
import { coerceStr } from '@/lib/coerce';
import type { DeviceKind } from '@/types';

export type KeyPlatformId = 'android' | 'emulator' | 'ios';

export interface KeyPlatformSpec {
  readonly id: KeyPlatformId;
  readonly label: string;
}

export const KEY_PLATFORMS: readonly KeyPlatformSpec[] = [
  { id: 'android', label: 'Android' },
  { id: 'emulator', label: '模拟器' },
  { id: 'ios', label: 'iOS' },
];

export type SystemKeyId =
  'back' | 'home' | 'recents' | 'power' | 'volume_up' | 'volume_down' | 'enter' | 'delete';

export interface SystemKeyOption {
  readonly id: SystemKeyId;
  readonly label: string;
  readonly hint: string;
  /** 是否作为节点上的首排高频快捷按钮（如 主页 / 返回 / 最近任务） */
  readonly primary?: boolean;
}

const ANDROID_KEY_OPTIONS: readonly SystemKeyOption[] = [
  { id: 'back', label: '返回', hint: '返回上一级（Back）', primary: true },
  { id: 'home', label: '主页', hint: '回到桌面（Home）', primary: true },
  { id: 'recents', label: '最近任务', hint: '多任务切换（Recents）', primary: true },
  { id: 'power', label: '电源', hint: '锁屏 / 亮屏（Power）' },
  { id: 'volume_up', label: '音量+', hint: '调高音量' },
  { id: 'volume_down', label: '音量-', hint: '调低音量' },
];

const EMULATOR_KEY_OPTIONS: readonly SystemKeyOption[] = [
  { id: 'back', label: '返回', hint: '模拟器返回键（Back）', primary: true },
  { id: 'home', label: '主页', hint: '模拟器主页键（Home）', primary: true },
  { id: 'recents', label: '最近任务', hint: '模拟器最近任务（Recents）', primary: true },
];

const IOS_KEY_OPTIONS: readonly SystemKeyOption[] = [
  { id: 'home', label: '主页', hint: '回主屏幕（Home）', primary: true },
  { id: 'power', label: '锁屏', hint: '侧边电源键（Lock/Power）', primary: true },
  { id: 'volume_up', label: '音量+', hint: '调高音量' },
  { id: 'volume_down', label: '音量-', hint: '调低音量' },
];

const KEY_LABELS: Record<string, string> = {
  back: '返回',
  home: '主页',
  recents: '最近任务',
  power: '电源',
  volume_up: '音量+',
  volume_down: '音量-',
  enter: '回车',
  delete: '退格',
};

/**
 * 该设备类型是否支持「按键」模块：
 * 本机窗口（`windows`）没有手机系统导航键（引擎 `MAC_KEYS` 不支持 back/recents/power），
 * 因此不提供系统按键模块。
 */
export function supportsKeyModule(kind: DeviceKind | null | undefined): boolean {
  if (kind === 'windows') {
    return false;
  }
  return true;
}

export function resolveKeyPlatform(
  params: Record<string, unknown> | undefined,
  deviceKind?: DeviceKind | null,
): KeyPlatformId {
  const explicit = coerceStr(params?.platform).trim().toLowerCase();
  if (explicit === 'ios' || explicit === 'emulator' || explicit === 'android') {
    return explicit;
  }
  if (deviceKind === 'ios') {
    return 'ios';
  }
  if (deviceKind === 'emulator') {
    return 'emulator';
  }
  return 'android';
}

export function keysForPlatform(platform: KeyPlatformId): readonly SystemKeyOption[] {
  switch (platform) {
    case 'ios':
      return IOS_KEY_OPTIONS;
    case 'emulator':
      return EMULATOR_KEY_OPTIONS;
    default:
      return ANDROID_KEY_OPTIONS;
  }
}

export function defaultKeyForPlatform(platform: KeyPlatformId): SystemKeyId {
  return platform === 'ios' ? 'home' : 'back';
}

export function normalizeKeyForPlatform(raw: unknown, platform: KeyPlatformId): SystemKeyId {
  const value = coerceStr(raw).trim();
  const options = keysForPlatform(platform);
  const matched = options.find((item) => item.id === value);
  if (matched) {
    return matched.id;
  }
  return defaultKeyForPlatform(platform);
}

export function keyValueLabel(raw: unknown): string {
  const value = coerceStr(raw, 'back').trim() || 'back';
  return KEY_LABELS[value] ?? value;
}
