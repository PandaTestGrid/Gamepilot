/**
 * 每台设备**物理上有哪些导航键**（引擎侧的实现见 `devices/*.py`）。
 *
 * 为什么不能一套按钮走天下：
 * - **Android**：返回 / 桌面 / 最近任务（三大金刚）+ 电源；
 * - **iOS**：物理上只有一个 Home + 侧边按钮（锁屏）。引擎的
 *   `devices/ios.py: NAMED_BUTTONS` 把 `back` / `recents` 都**映射成 Home**
 *   （注释原话："iOS 没有安卓那几个键，这里做个映射，脚本两边都能用"）——
 *   界面照搬 Android 那三个，用户按「返回」其实按的是「Home」，按钮名和实际动作对不上；
 * - **windows**（macOS 本机窗口走的就是这个 kind，见 `devices/macos.py`）：
 *   没有这些实体键，`MAC_KEYS` 里只有键盘按键，点下去必然报"macOS 不支持的按键"；
 * - **mock / remote**：合成设备与未知来源，四个都给 —— 未知时宁可保留功能
 *   （报错文案是明确的），也不要悄悄把按钮藏掉。
 *
 * 纯函数、可单测。
 */
import type { DeviceKind } from '@/types';

export type NavKeyId = 'back' | 'home' | 'recents' | 'power';

export interface NavKeySpec {
  readonly id: NavKeyId;
  /** 按钮文字（iOS 的 home 叫"主页"更贴切） */
  readonly label: string;
  readonly hint: string;
}

const BACK: NavKeySpec = { id: 'back', label: '返回', hint: '返回键' };
const HOME: NavKeySpec = { id: 'home', label: '桌面', hint: '回到桌面（Home）' };
const IOS_HOME: NavKeySpec = { id: 'home', label: '主页', hint: '回主屏幕（iOS 只有这一个实体导航键）' };
const RECENTS: NavKeySpec = { id: 'recents', label: '最近任务', hint: '最近任务' };
const POWER: NavKeySpec = { id: 'power', label: '电源', hint: '电源键（锁屏/亮屏）' };
const IOS_POWER: NavKeySpec = { id: 'power', label: '电源', hint: '侧边按钮（锁屏/亮屏）' };

const ANDROID_KEYS: readonly NavKeySpec[] = [BACK, HOME, RECENTS, POWER];
const IOS_KEYS: readonly NavKeySpec[] = [IOS_HOME, IOS_POWER];
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
      // mock / remote：合成设备与未知来源，四个都留着
      return ANDROID_KEYS;
  }
}
