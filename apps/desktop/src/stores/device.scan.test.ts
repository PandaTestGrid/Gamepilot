import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceRuntime } from '@/types';

const listDevicesMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/rpc', () => ({ listDevices: listDevicesMock }));

const { mergeScan, toRuntimeDevice, useDeviceStore } = await import('@/stores/device.store');

function device(over: Partial<DeviceRuntime> & { id: string }): DeviceRuntime {
  return {
    name: over.id,
    uri: `Android:///?serial=${over.id}`,
    kind: 'android',
    status: 'discovered',
    resolution: [1080, 1920],
    fps: 0,
    ...over,
  };
}

describe('扫描结果合并（纯函数）', () => {
  it('已连接的设备不被扫描结果覆盖', () => {
    const current = [device({ id: 'a', status: 'connected' }), device({ id: 'old' })];
    const incoming = [device({ id: 'b' }), device({ id: 'old' })];

    const merged = mergeScan(current, incoming, 'a');

    expect(merged.devices.map((item) => item.id)).toEqual(['a', 'b', 'old']);
    expect(merged.devices[0]?.status).toBe('connected');
  });

  it('连接中的设备即使扫描结果里没有也保留（活会话不能被刷新踢掉）', () => {
    const current = [device({ id: 'gone', status: 'connected' })];
    const merged = mergeScan(current, [device({ id: 'x' }), device({ id: 'y' })], 'gone');

    expect(merged.devices.map((item) => item.id)).toEqual(['gone', 'x', 'y']);
    expect(merged.activeId).toBe('gone');
  });

  it('活动设备已不在列表里时回退到列表首项', () => {
    const current = [device({ id: 'a', status: 'discovered' })];
    const merged = mergeScan(current, [device({ id: 'x' }), device({ id: 'y' })], 'a');

    expect(merged.devices.map((item) => item.id)).toEqual(['x', 'y']);
    expect(merged.activeId).toBe('x');
  });

  it('活动设备仍在列表里时保持不变', () => {
    const merged = mergeScan([device({ id: 'a' })], [device({ id: 'a' }), device({ id: 'b' })], 'a');
    expect(merged.activeId).toBe('a');
  });
});

describe('引擎 payload → 界面模型', () => {
  it('未知的 kind / status 降级，不抛异常', () => {
    const runtime = toRuntimeDevice({
      id: 'x',
      uri: 'Harmony:///?serial=x',
      name: '鸿蒙设备',
      kind: 'harmony',
      status: 'weird',
      serial: 'x',
      model: null,
      product: null,
      resolution: null,
      error: null,
      suggestedFix: null,
    });

    expect(runtime.kind).toBe('remote');
    expect(runtime.status).toBe('discovered');
    expect(runtime.resolution).toBeNull();
  });

  it('带分辨率的真机原样映射（含 model）', () => {
    const runtime = toRuntimeDevice({
      id: 'android:3387980',
      uri: 'Android:///?serial=3387980',
      name: 'OPPO A57',
      kind: 'android',
      status: 'discovered',
      serial: '3387980',
      model: 'OPPO_A57',
      product: 'A57',
      resolution: [720, 1280],
      error: null,
      suggestedFix: null,
    });

    expect(runtime.model).toBe('OPPO_A57');
    expect(runtime.resolution).toEqual([720, 1280]);
  });
});

describe('scan()', () => {
  beforeEach(() => {
    listDevicesMock.mockReset();
    useDeviceStore.setState({
      devices: [],
      activeId: '',
      scanState: 'idle',
      scanErrors: [],
      scanError: null,
      lastScanAt: null,
    });
  });

  it('写入设备列表、来源错误与刷新时间', async () => {
    listDevicesMock.mockResolvedValue({
      devices: [
        {
          id: 'android:3387980',
          uri: 'Android:///?serial=3387980',
          name: 'OPPO A57',
          kind: 'android',
          status: 'discovered',
          serial: '3387980',
          model: 'OPPO_A57',
          product: 'A57',
          resolution: [720, 1280],
          error: null,
          suggestedFix: null,
        },
      ],
      errors: [{ provider: 'ios', message: 'usbmux 不可用' }],
    });

    await useDeviceStore.getState().scan();

    const state = useDeviceStore.getState();
    expect(state.devices).toHaveLength(1);
    expect(state.devices[0]?.name).toBe('OPPO A57');
    expect(state.scanErrors).toEqual(['ios: usbmux 不可用']);
    expect(state.scanState).toBe('idle');
    expect(state.lastScanAt).not.toBeNull();
    expect(state.activeId).toBe('android:3387980');
  });

  it('引擎不可用时进入 error 态并保留原有列表', async () => {
    useDeviceStore.setState({ devices: [device({ id: 'keep' })] });
    listDevicesMock.mockRejectedValue(new Error('引擎未启动'));

    await useDeviceStore.getState().scan();

    const state = useDeviceStore.getState();
    expect(state.scanState).toBe('error');
    expect(state.scanError).toContain('引擎未启动');
    expect(state.devices.map((item) => item.id)).toEqual(['keep']);
  });
});
