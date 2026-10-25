/**
 * 按键模块（系统键 + Windows 游戏键盘）的平台适配规则：
 * - 不同系统显示的按键不同：
 *   - `android`（安卓真机）：返回 / 主页 / 最近任务 / 电源 / 音量+ / 音量-
 *   - `emulator`（模拟器）：返回 / 主页 / 最近任务（无实体电源/音量键）
 *   - `ios`（iOS）：主页 / 锁屏 / 音量+ / 音量-
 *   - `windows`（本机窗口）：字母 / 数字 / F1-F12 / 方向键 / 空格 / 回车 / 功能键
 *     （游戏里用 WASD、Space、F 等；值就是引擎 `WINDOW_KEYS` 的键名）
 */
import { coerceStr } from '@/lib/coerce';
import type { DeviceKind } from '@/types';

export type KeyPlatformId = 'android' | 'emulator' | 'ios' | 'windows';

export interface KeyPlatformSpec {
  readonly id: KeyPlatformId;
  readonly label: string;
}

/** Windows 设备自动用 Windows 键集，不需要让用户选平台 */
export const KEY_PLATFORMS: readonly KeyPlatformSpec[] = [
  { id: 'android', label: 'Android' },
  { id: 'emulator', label: '模拟器' },
  { id: 'ios', label: 'iOS' },
];

/** 注意：Windows 键名（a-z / 0-9 / f1-f12 / space...）也属于这个类型 */
export type SystemKeyId = string;

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

/** Windows 首排：游戏最常用的移动/确认/取消/加速键 */
const WINDOWS_PRIMARY_KEYS = ['w', 'a', 's', 'd', 'space', 'shift', 'ctrl', 'enter', 'escape'] as const;
const WINDOWS_PRIMARY_LABELS: Record<string, string> = {
  w: 'W',
  a: 'A',
  s: 'S',
  d: 'D',
  space: '空格',
  shift: 'Shift',
  ctrl: 'Ctrl',
  enter: '回车',
  escape: 'Esc',
};

/** 方向键在按钮/下拉里用箭头更直观 */
const WINDOWS_LABELS: Record<string, string> = {
  left: '←',
  up: '↑',
  right: '→',
  down: '↓',
  space: '空格',
  escape: 'Esc',
  enter: '回车',
  tab: 'Tab',
  backspace: '退格',
  delete: 'Delete',
  shift: 'Shift',
  ctrl: 'Ctrl',
  alt: 'Alt',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  insert: 'Insert',
};

function windowsKey(id: string, primary = false): SystemKeyOption {
  const label = WINDOWS_PRIMARY_LABELS[id] ?? WINDOWS_LABELS[id] ?? id.toUpperCase();
  return { id, label, hint: `按键 ${label}`, primary };
}

const WINDOWS_KEY_OPTIONS: readonly SystemKeyOption[] = [
  ...WINDOWS_PRIMARY_KEYS.map((id) => windowsKey(id, true)),
  ...'abcdefghijklmnopqrstuvwxyz'
    .split('')
    .filter((id) => !(WINDOWS_PRIMARY_KEYS as readonly string[]).includes(id))
    .map((id) => windowsKey(id)),
  ...'0123456789'.split('').map((id) => windowsKey(id)),
  ...Array.from({ length: 12 }, (_, index) => windowsKey(`f${index + 1}`)),
  ...['left', 'up', 'right', 'down'].map((id) => windowsKey(id)),
  ...['tab', 'backspace', 'delete', 'alt', 'home', 'end', 'pageup', 'pagedown', 'insert'].map((id) =>
    windowsKey(id),
  ),
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
 * - Android / 模拟器 / iOS：系统导航键；
 * - Windows 本机窗口：游戏键盘键（引擎 `WINDOW_KEYS`）。
 */
export function supportsKeyModule(kind: DeviceKind | null | undefined): boolean {
  return kind !== null && kind !== undefined;
}

export function resolveKeyPlatform(
  params: Record<string, unknown> | undefined,
  deviceKind?: DeviceKind | null,
): KeyPlatformId {
  const explicit = coerceStr(params?.platform).trim().toLowerCase();
  if (explicit === 'ios' || explicit === 'emulator' || explicit === 'android' || explicit === 'windows') {
    return explicit;
  }
  if (deviceKind === 'ios') {
    return 'ios';
  }
  if (deviceKind === 'emulator') {
    return 'emulator';
  }
  if (deviceKind === 'windows') {
    return 'windows';
  }
  return 'android';
}

export function keysForPlatform(platform: KeyPlatformId): readonly SystemKeyOption[] {
  switch (platform) {
    case 'ios':
      return IOS_KEY_OPTIONS;
    case 'emulator':
      return EMULATOR_KEY_OPTIONS;
    case 'windows':
      return WINDOWS_KEY_OPTIONS;
    default:
      return ANDROID_KEY_OPTIONS;
  }
}

export function defaultKeyForPlatform(platform: KeyPlatformId): SystemKeyId {
  if (platform === 'ios') {
    return 'home';
  }
  if (platform === 'windows') {
    return 'space';
  }
  return 'back';
}

export function normalizeKeyForPlatform(raw: unknown, platform: KeyPlatformId): SystemKeyId {
  const value = coerceStr(raw).trim().toLowerCase();
  const options = keysForPlatform(platform);
  const matched = options.find((item) => item.id === value);
  if (matched) {
    return matched.id;
  }
  return defaultKeyForPlatform(platform);
}

export function keyValueLabel(raw: unknown): string {
  const value = coerceStr(raw, 'back').trim().toLowerCase() || 'back';
  if (/^[a-z]$/.test(value)) {
    return value.toUpperCase();
  }
  if (/^f([1-9]|1[0-2])$/.test(value)) {
    return value.toUpperCase();
  }
  return KEY_LABELS[value] ?? WINDOWS_LABELS[value] ?? value;
}
