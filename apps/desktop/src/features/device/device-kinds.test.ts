/**
 * 设备分类/过滤/排序的纯逻辑测试。
 *
 * 为什么值得单测：设备来源已经有 安卓 / 模拟器 / iOS / 本机窗口 四种，
 * 而本机窗口是"一个伪设备 + 一串窗口"两条数据路径（Windows 与 macOS 同一套形状）——
 * 分错类、把伪设备当可连设备、打开弹层落在空分类，都是用户直接能感觉到的"交互很差"。
 */
import { describe, expect, it } from 'vitest';

import {
  buildDeviceTabs,
  connectableDevices,
  filterByTab,
  isWindowDevice,
  isWindowPicker,
  matchDeviceQuery,
  normalizeDeviceTab,
  resolveTab,
  sortForDisplay,
  statusTone,
} from '@/features/device/device-kinds';
import type { DeviceRuntime } from '@/types';

function device(patch: Partial<DeviceRuntime> & Pick<DeviceRuntime, 'id' | 'kind'>): DeviceRuntime {
  return {
    name: patch.id,
    uri: `Uri:///?id=${patch.id}`,
    status: 'discovered',
    resolution: null,
    fps: 0,
    ...patch,
  };
}

const ANDROID = device({ id: 'android:3387980', kind: 'android', name: 'OPPO A57', status: 'connected' });
const EMULATOR = device({ id: 'emulator:5554', kind: 'emulator', name: 'MuMu 12', status: 'discovered' });
const EMULATOR_SCREEN = device({
  id: 'android:emulator-5554:42',
  kind: 'emulator',
  uri: 'Android:///?serial=emulator-5554&display=4&physical=42',
  name: 'MuMu 12 · 屏4',
});
const IPHONE = device({ id: 'ios:000081', kind: 'ios', name: 'iPhone 15', status: 'discovered' });
const MAC_PICKER = device({
  id: 'macos:picker',
  kind: 'windows',
  name: '本机窗口（macOS）· 7 个可选窗口',
  status: 'discovered',
});
const MAC_WINDOW = device({ id: 'macos:89', kind: 'windows', name: 'Safari', status: 'connected' });
const WINDOWS_PICKER = device({
  id: 'windows:picker',
  kind: 'windows',
  name: '本机窗口（Windows）· 7 个可选窗口',
  status: 'discovered',
});
const WINDOWS_WINDOW = device({
  id: 'windows:6698742',
  kind: 'windows',
  name: '某游戏',
  status: 'connected',
});
const SPARE = device({ id: 'android:0009', kind: 'android', name: 'Pixel 7', status: 'discovered' });

const ALL = [ANDROID, EMULATOR, IPHONE, MAC_PICKER, MAC_WINDOW, WINDOWS_PICKER, WINDOWS_WINDOW];

describe('设备分类', () => {
  it('本机窗口的伪设备（picker）不算可连设备，Windows / macOS 真窗口才算', () => {
    expect(isWindowPicker(MAC_PICKER)).toBe(true);
    expect(isWindowPicker(WINDOWS_PICKER)).toBe(true);
    expect(isWindowPicker(MAC_WINDOW)).toBe(false);
    expect(isWindowDevice(MAC_WINDOW)).toBe(true);
    expect(isWindowDevice(WINDOWS_WINDOW)).toBe(true);
    expect(isWindowDevice(ANDROID)).toBe(false);

    const connectable = connectableDevices(ALL);
    expect(connectable.map((item) => item.id)).not.toContain('macos:picker');
    expect(connectable.map((item) => item.id)).not.toContain('windows:picker');
    expect(connectable.map((item) => item.id)).toContain('macos:89');
    expect(connectable.map((item) => item.id)).toContain('windows:6698742');
  });

  it('模拟器附屏也是可连设备，选择器按窗口分行', () => {
    expect(connectableDevices([...ALL, EMULATOR_SCREEN]).map((item) => item.id)).toContain(
      EMULATOR_SCREEN.id,
    );
    expect(buildDeviceTabs([...ALL, EMULATOR_SCREEN]).find((tab) => tab.id === 'emulator')?.count).toBe(2);
  });

  it('Tab 只列有内容的分类，并带上数量（本机窗口 Windows + macOS 合并成一个 Tab）', () => {
    const tabs = buildDeviceTabs(ALL);
    const byId = Object.fromEntries(tabs.map((tab) => [tab.id, tab.count]));

    expect(byId.all).toBe(5); // 两个 picker 不是可连设备
    expect(byId.android).toBe(1); // 只有真机
    expect(byId.emulator).toBe(1);
    expect(byId.ios).toBe(1);
    expect(byId.window).toBe(4); // Windows / macOS 各一个 picker + 一个已连窗口
    expect(byId.other).toBeUndefined(); // 没有内容就不出现
  });

  it('没有 iOS 设备时不会冒出一个空的 iOS Tab（以前就是这样让人以为设备丢了）', () => {
    const tabs = buildDeviceTabs([ANDROID, SPARE]);
    expect(tabs.map((tab) => tab.id)).toEqual(['all', 'android']);
  });

  it('按分类过滤：本机窗口 Tab 只给 macos:* / windows:*', () => {
    expect(filterByTab(ALL, 'window').map((item) => item.id)).toEqual([
      'macos:picker',
      'macos:89',
      'windows:picker',
      'windows:6698742',
    ]);
    expect(filterByTab(ALL, 'android').map((item) => item.id)).toEqual(['android:3387980']);
    expect(filterByTab(ALL, 'emulator').map((item) => item.id)).toEqual(['emulator:5554']);
    expect(filterByTab(ALL, 'ios').map((item) => item.id)).toEqual(['ios:000081']);
  });

  it('打开弹层落在有内容的分类：上次选中的分类空了就退回去', () => {
    const tabs = buildDeviceTabs([ANDROID, EMULATOR]);
    expect(resolveTab('ios', tabs)).toBe('android'); // iOS 空了 → 退到有内容的
    expect(resolveTab('emulator', tabs)).toBe('emulator'); // 有内容就保持不变
    expect(resolveTab('all', [])).toBe('all');
  });
});

describe('设备弹层分类迁移', () => {
  it('macOS 专用时期存下的 mac 迁移成通用的 window，未知值退化成 all', () => {
    expect(normalizeDeviceTab('mac')).toBe('window');
    expect(normalizeDeviceTab('window')).toBe('window');
    expect(normalizeDeviceTab('all')).toBe('all');
    expect(normalizeDeviceTab('nope')).toBe('all');
    expect(normalizeDeviceTab(null)).toBe('all');
    expect(normalizeDeviceTab(undefined)).toBe('all');
  });
});

describe('设备排序与搜索', () => {
  it('当前设备排最前，其次已连接 → 连接中 → 失败 → 未连接', () => {
    const failed = device({ id: 'android:0001', kind: 'android', name: '坏设备', status: 'failed' });
    const connecting = device({ id: 'android:0002', kind: 'android', name: '连着的', status: 'connecting' });
    const order = sortForDisplay([failed, connecting, SPARE, ANDROID, MAC_WINDOW], MAC_WINDOW.id);

    expect(order.map((item) => item.id)).toEqual([
      'macos:89', // 当前
      'android:3387980', // 已连接
      'android:0002', // 连接中
      'android:0001', // 失败
      'android:0009', // 未连接
    ]);
  });

  it('搜索能命中名字 / URI / 来源 / 型号（粘贴 URI 也能直接定位）', () => {
    expect(matchDeviceQuery(ANDROID, 'oppo')).toBe(true);
    expect(matchDeviceQuery(ANDROID, 'android:3387980')).toBe(true); // URI 片段也能命中（粘贴 URI 即可定位）
    expect(matchDeviceQuery(ANDROID, 'ios')).toBe(false);
    expect(matchDeviceQuery(IPHONE, 'IPHONE')).toBe(true);
    expect(matchDeviceQuery(SPARE, '  ')).toBe(true);
  });
});

describe('状态色', () => {
  it('已连接/连接中/失败/未连接 各自一种语义色', () => {
    expect(statusTone('connected')).toBe('confirmed');
    expect(statusTone('connecting')).toBe('pending');
    expect(statusTone('failed')).toBe('failed');
    expect(statusTone('discovered')).toBe('idle');
  });
});
