/**
 * 设备分类/过滤/排序的纯逻辑测试。
 *
 * 为什么值得单测：设备来源已经有 安卓 / 模拟器 / iOS / 本机窗口 / Mock 五种，
 * 而 macOS 是"一个伪设备 + 一串窗口"两条数据路径 —— 分错类、把伪设备当可连设备、
 * 打开弹层落在空分类，都是用户直接能感觉到的"交互很差"。
 */
import { describe, expect, it } from 'vitest';

import {
  buildDeviceTabs,
  connectableDevices,
  filterByTab,
  isMacPicker,
  matchDeviceQuery,
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
const IPHONE = device({ id: 'ios:000081', kind: 'ios', name: 'iPhone 15', status: 'discovered' });
const MAC_PICKER = device({
  id: 'macos:picker',
  kind: 'windows',
  name: '本机窗口（macOS）· 7 个可选窗口',
  status: 'discovered',
});
const MAC_WINDOW = device({ id: 'macos:89', kind: 'windows', name: 'Safari', status: 'connected' });
const MOCK = device({ id: 'mock:mock-1', kind: 'mock', name: 'Mock 合成设备', status: 'discovered' });

const ALL = [ANDROID, EMULATOR, IPHONE, MAC_PICKER, MAC_WINDOW, MOCK];

describe('设备分类', () => {
  it('macOS 的伪设备（picker）不算可连设备，真正的窗口才算', () => {
    expect(isMacPicker(MAC_PICKER)).toBe(true);
    const connectable = connectableDevices(ALL);
    expect(connectable.map((item) => item.id)).not.toContain('macos:picker');
    expect(connectable.map((item) => item.id)).toContain('macos:89');
  });

  it('Tab 只列有内容的分类，并带上数量（模拟器归到安卓）', () => {
    const tabs = buildDeviceTabs(ALL);
    const byId = Object.fromEntries(tabs.map((tab) => [tab.id, tab.count]));

    expect(byId.all).toBe(6);
    expect(byId.android).toBe(2); // 真机 + 模拟器
    expect(byId.ios).toBe(1);
    expect(byId.mac).toBe(2); // picker + 已连窗口
    expect(byId.mock).toBe(1);
    expect(byId.other).toBeUndefined(); // 没有内容就不出现
  });

  it('没有 iOS 设备时不会冒出一个空的 iOS Tab（以前就是这样让人以为设备丢了）', () => {
    const tabs = buildDeviceTabs([ANDROID, MOCK]);
    expect(tabs.map((tab) => tab.id)).toEqual(['all', 'android', 'mock']);
  });

  it('按分类过滤：本机窗口 Tab 只给 macos:*', () => {
    expect(filterByTab(ALL, 'mac').map((item) => item.id)).toEqual(['macos:picker', 'macos:89']);
    expect(filterByTab(ALL, 'android').map((item) => item.id)).toEqual(['android:3387980', 'emulator:5554']);
    expect(filterByTab(ALL, 'ios').map((item) => item.id)).toEqual(['ios:000081']);
  });

  it('打开弹层落在有内容的分类：上次选中的分类空了就退回去', () => {
    const tabs = buildDeviceTabs([ANDROID, MOCK]);
    expect(resolveTab('ios', tabs)).toBe('android'); // iOS 空了 → 退到有内容的
    expect(resolveTab('mock', tabs)).toBe('mock'); // 有内容就保持不变
    expect(resolveTab('all', [])).toBe('all');
  });
});

describe('设备排序与搜索', () => {
  it('当前设备排最前，其次已连接 → 连接中 → 失败 → 未连接', () => {
    const failed = device({ id: 'android:0001', kind: 'android', name: '坏设备', status: 'failed' });
    const connecting = device({ id: 'android:0002', kind: 'android', name: '连着的', status: 'connecting' });
    const order = sortForDisplay([failed, connecting, MOCK, ANDROID, MAC_WINDOW], MAC_WINDOW.id);

    expect(order.map((item) => item.id)).toEqual([
      'macos:89', // 当前
      'android:3387980', // 已连接
      'android:0002', // 连接中
      'android:0001', // 失败
      'mock:mock-1', // 未连接
    ]);
  });

  it('搜索能命中名字 / URI / 来源 / 型号（粘贴 URI 也能直接定位）', () => {
    expect(matchDeviceQuery(ANDROID, 'oppo')).toBe(true);
    expect(matchDeviceQuery(ANDROID, 'android:3387980')).toBe(true); // URI 片段也能命中（粘贴 URI 即可定位）
    expect(matchDeviceQuery(ANDROID, 'ios')).toBe(false);
    expect(matchDeviceQuery(IPHONE, 'IPHONE')).toBe(true);
    expect(matchDeviceQuery(MOCK, '  ')).toBe(true);
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
