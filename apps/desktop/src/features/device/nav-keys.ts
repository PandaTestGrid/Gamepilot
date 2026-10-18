/**
 * 每台设备**物理上有哪些按键**（引擎侧的实现见 `devices/*.py`）。
 *
 * 分成两拨，因为它们在界面上的位置不同：
 * - `navKeysFor()`：**导航键**（返回 / 桌面 / 最近任务 / 主页）—— 贴在投屏下面那条，
 *   居中摆，看起来就是手机下面那排键；
 * - `powerKeyFor()`：**电源键** —— 它不是导航键，放在画面栏面板头（和 控制 / 录操作 一起）。
 *
 * 为什么要分平台：
 * - **Android**：返回 / 桌面 / 最近任务（三大金刚）+ 电源；
 * - **iOS**：物理上只有一个 Home + 侧边按钮（锁屏）。引擎的
 *   `devices/ios.py: NAMED_BUTTONS` 把 `back` / `recents` 都**映射成 Home**
 *   （注释原话："iOS 没有安卓那几个键，这里做个映射，脚本两边都能用"）——
 *   界面照搬 Android 那三个，用户按「返回」其实按的是「Home」，按钮名和实际动作对不上；
 * - **windows**（macOS 本机窗口走的就是这个 kind，见 `devices/macos.py`）：
 *   这些键一个都没有，`MAC_KEYS` 里只有键盘按键，点下去必然报"macOS 不支持的按键"；
 * - **remote**：未知来源，全给 —— 报错文案明确，不悄悄藏按钮。
 *
 * 纯函数、可单测。
 */
import type { DeviceKind } from '@/types';

export type NavKeyId = 'back' | 'home' | 'recents';
export type DeviceKeyId = NavKeyId | 'power';

export interface KeySpec<T extends DeviceKeyId> {
  readonly id: T;
  /** 按钮文字（iOS 的 home 叫"主页"更贴切） */
  readonly label: string;
  readonly hint: string;
}

/** 导航键（投屏下面那条）：id 只可能是 back / home / recents */
export type NavKeySpec = KeySpec<NavKeyId>;
/** 电源键（面板头）：id 只可能是 power */
export type PowerKeySpec = KeySpec<'power'>;

const BACK: NavKeySpec = { id: 'back', label: '返回', hint: '返回键' };
const HOME: NavKeySpec = { id: 'home', label: '桌面', hint: '回到桌面（Home）' };
const IOS_HOME: NavKeySpec = { id: 'home', label: '主页', hint: '回主屏幕（iOS 只有这一个实体导航键）' };
const RECENTS: NavKeySpec = { id: 'recents', label: '最近任务', hint: '最近任务' };

const ANDROID_KEYS: readonly NavKeySpec[] = [BACK, HOME, RECENTS];
const IOS_KEYS: readonly NavKeySpec[] = [IOS_HOME];
/** macOS 本机窗口：没有实体导航键（只有键盘按键） */
const NO_KEYS: readonly NavKeySpec[] = [];

export function navKeysFor(kind: DeviceKind): readonly NavKeySpec[] {
  switch (kind) {
    case 'android':
    case 'emulator':
      return ANDROID_KEYS;
    case 'ios':
      return IOS_KEYS;
    case 'windows':
      return NO_KEYS;
    default:
      // remote 等未知来源，按 Android 那一套给
      return ANDROID_KEYS;
  }
}

/**
 * 电源键；这台设备没有就返回 null（macOS 本机窗口发不了电源键 ——
 * `MAC_KEYS` 里没有 power，点了只会报"不支持的按键"）。
 */
export function powerKeyFor(kind: DeviceKind): PowerKeySpec | null {
  switch (kind) {
    case 'ios':
      return { id: 'power', label: '电源', hint: '侧边按钮（锁屏/亮屏）' };
    case 'windows':
      return null;
    default:
      return { id: 'power', label: '电源', hint: '电源键（锁屏/亮屏）' };
  }
}
