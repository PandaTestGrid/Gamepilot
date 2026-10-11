import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toRuntimeDevice, useDeviceStore } from '@/stores/device.store';
import type { DeviceRuntime } from '@/types';

/**
 * 注意：store 不再预置假设备（首屏空态引导用户去扫描），所以测试自带夹具。
 * 这也顺带保证"假设备能被点连接"这种坑不会再回来。
 */
export const TEST_DEVICES: readonly DeviceRuntime[] = [
  {
    id: 'android:3387980',
    name: 'OPPO A57',
    uri: 'Android:///?serial=3387980',
    kind: 'android',
    status: 'connected',
    resolution: [720, 1280],
    fps: 10,
  },
  {
    id: 'android:7b69da0c',
    name: 'MI 8 Lite',
    uri: 'Android:///?serial=7b69da0c',
    kind: 'android',
    status: 'connected',
    resolution: [1080, 2280],
    fps: 9,
  },
  {
    id: 'mock:mock-1',
    name: 'Mock 合成设备',
    uri: 'Mock:///?width=1280&height=720',
    kind: 'mock',
    status: 'discovered',
    resolution: [1280, 720],
    fps: 0,
  },
];

function reset(): void {
  useDeviceStore.setState({ devices: TEST_DEVICES, activeId: 'android:3387980', gridView: false });
}

describe('多设备 store', () => {
  beforeEach(() => {
    reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connect 只切到 connecting；真实连接结果由引擎回填', () => {
    useDeviceStore.getState().connect('mock:mock-1');
    expect(useDeviceStore.getState().devices.find((item) => item.id === 'mock:mock-1')?.status).toBe(
      'connecting',
    );

    useDeviceStore.getState().markConnectedWith('mock:mock-1', [1280, 720]);
    const device = useDeviceStore.getState().devices.find((item) => item.id === 'mock:mock-1');
    expect(device?.status).toBe('connected');
    expect(device?.resolution).toEqual([1280, 720]);
    expect(device?.error).toBeUndefined();
  });

  it('直接按 URI 连接一台"还没扫描到"的设备时，会补进列表', () => {
    useDeviceStore.setState({ devices: [], activeId: '' });
    useDeviceStore.getState().markConnectedWith('android:999', [1080, 1920], 'Android:///?serial=999');

    const device = useDeviceStore.getState().devices.find((item) => item.id === 'android:999');
    expect(device?.status).toBe('connected');
    expect(device?.uri).toBe('Android:///?serial=999');
    expect(useDeviceStore.getState().activeId).toBe('android:999');
  });

  it('切换活动设备只改 activeId，不影响其他设备', () => {
    useDeviceStore.getState().setActive('android:7b69da0c');
    expect(useDeviceStore.getState().activeId).toBe('android:7b69da0c');
    expect(useDeviceStore.getState().devices.find((item) => item.id === 'android:3387980')?.status).toBe(
      'connected',
    );
  });

  it('断开活动设备时自动切到另一台已连接设备', () => {
    useDeviceStore.getState().disconnect('android:3387980');

    const state = useDeviceStore.getState();
    expect(state.devices.find((item) => item.id === 'android:3387980')?.status).toBe('discovered');
    expect(state.activeId).toBe('android:7b69da0c');
  });

  it('已连接设备少于 2 台时自动退出多开网格', () => {
    useDeviceStore.setState({ gridView: true });
    useDeviceStore.getState().disconnect('android:7b69da0c');

    expect(useDeviceStore.getState().gridView).toBe(false);
  });

  it('失败态会带上错误原因与修复建议', () => {
    useDeviceStore.getState().failConnect('mock:mock-1', '端口被占用');

    const device = useDeviceStore.getState().devices.find((item) => item.id === 'mock:mock-1');
    expect(device?.status).toBe('failed');
    expect(device?.error).toBe('端口被占用');
    expect(device?.suggestedFix).toBeTruthy();
  });
});

describe('引擎 payload → 界面模型', () => {
  const base = {
    id: 'x',
    uri: 'Uri:///?id=x',
    name: 'X',
    kind: 'android',
    status: 'discovered',
    serial: null,
    model: null,
    product: null,
    resolution: null,
    error: null,
    suggestedFix: null,
  };

  it('每种来源都认得出来（ios 曾经被漏掉，iPhone 全被降级成"远程"→ 分类里看不见）', () => {
    for (const kind of ['android', 'emulator', 'ios', 'windows', 'mock']) {
      expect(toRuntimeDevice({ ...base, kind }).kind).toBe(kind);
    }
  });

  it('未知来源降级成 remote，不抛异常', () => {
    expect(toRuntimeDevice({ ...base, kind: 'harmony' }).kind).toBe('remote');
    expect(toRuntimeDevice({ ...base, kind: 'not-a-string' }).kind).toBe('remote');
  });

  it('状态：认识的照原样，不认识的降级成 discovered（idle 是界面态，引擎给了也认）', () => {
    expect(toRuntimeDevice({ ...base, status: 'idle' }).status).toBe('idle');
    expect(toRuntimeDevice({ ...base, status: 'weird' }).status).toBe('discovered');
  });
});
