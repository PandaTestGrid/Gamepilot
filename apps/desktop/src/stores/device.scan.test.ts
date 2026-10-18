import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceRuntime } from '@/types';

const listDevicesMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/rpc', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listDevices: listDevicesMock,
}));

const { mergeScan, toRuntimeDevice, useDeviceStore } = await import('@/stores/device.store');
const { useSessionStore } = await import('@/stores/session.store');

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

const MAIN = device({
  id: 'android:emulator-5554',
  kind: 'emulator',
  uri: 'Android:///?serial=emulator-5554',
  status: 'connected',
});
const SECONDARY = device({
  id: 'android:emulator-5554:42',
  kind: 'emulator',
  uri: 'Android:///?serial=emulator-5554&display=23&physical=42',
  name: 'MuMu · 屏23',
  status: 'connected',
});

function info(item: DeviceRuntime) {
  return {
    id: item.id,
    name: item.name,
    uri: item.uri,
    kind: item.kind,
    status: 'discovered',
    serial: 'emulator-5554',
    model: null,
    product: null,
    resolution: item.resolution,
    error: null,
    suggestedFix: null,
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

  it('同一物理屏重排逻辑屏号后仍是原会话，更新 URI 与屏幕名称', () => {
    const changed = {
      ...SECONDARY,
      uri: 'Android:///?serial=emulator-5554&display=2&physical=42',
      name: 'MuMu · 屏2',
    };
    const merged = mergeScan([MAIN, SECONDARY], [MAIN, changed], SECONDARY.id);
    expect(merged.activeId).toBe(SECONDARY.id);
    expect(merged.devices.find((item) => item.id === SECONDARY.id)).toMatchObject({
      status: 'connected',
      uri: changed.uri,
      name: changed.name,
    });
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
      missingDisplays: {},
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

  it('一次刷新内复核两次确认附屏消失，立即移走黑屏会话', async () => {
    const originalDisconnect = useSessionStore.getState().disconnect;
    const disconnect = vi.fn(() => Promise.resolve());
    useSessionStore.setState({ disconnect, ready: { [MAIN.id]: true, [SECONDARY.id]: true } });
    useDeviceStore.setState({ devices: [MAIN, SECONDARY], activeId: SECONDARY.id });
    listDevicesMock.mockResolvedValue({ devices: [info(MAIN)], errors: [] });

    try {
      await useDeviceStore.getState().scan();
      expect(listDevicesMock).toHaveBeenCalledTimes(2);
      expect(disconnect).toHaveBeenCalledOnce();
      expect(disconnect).toHaveBeenCalledWith(SECONDARY.id);
      expect(useDeviceStore.getState().activeId).toBe(MAIN.id);
      expect(useDeviceStore.getState().devices.some((item) => item.id === SECONDARY.id)).toBe(false);
    } finally {
      useSessionStore.setState({ disconnect: originalDisconnect, ready: {} });
    }
  });

  it('一次 adb 漏报、复核时屏幕恢复：不误断已连接窗口', async () => {
    const originalDisconnect = useSessionStore.getState().disconnect;
    const disconnect = vi.fn(() => Promise.resolve());
    useSessionStore.setState({ disconnect, ready: { [MAIN.id]: true, [SECONDARY.id]: true } });
    useDeviceStore.setState({ devices: [MAIN, SECONDARY], activeId: SECONDARY.id });
    listDevicesMock
      .mockResolvedValueOnce({ devices: [info(MAIN)], errors: [] })
      .mockResolvedValueOnce({ devices: [info(MAIN), info(SECONDARY)], errors: [] });

    try {
      await useDeviceStore.getState().scan();
      expect(disconnect).not.toHaveBeenCalled();
      expect(useDeviceStore.getState().activeId).toBe(SECONDARY.id);
      expect(useDeviceStore.getState().devices.some((item) => item.id === SECONDARY.id)).toBe(true);
    } finally {
      useSessionStore.setState({ disconnect: originalDisconnect, ready: {} });
    }
  });

  it('复核时 Android 扫描失败：保留旧会话，不把失败当成已关闭', async () => {
    const originalDisconnect = useSessionStore.getState().disconnect;
    const disconnect = vi.fn(() => Promise.resolve());
    useSessionStore.setState({ disconnect, ready: { [MAIN.id]: true, [SECONDARY.id]: true } });
    useDeviceStore.setState({ devices: [MAIN, SECONDARY], activeId: SECONDARY.id });
    listDevicesMock
      .mockResolvedValueOnce({ devices: [info(MAIN)], errors: [] })
      .mockResolvedValueOnce({ devices: [info(MAIN)], errors: [{ provider: 'android', message: '超时' }] });

    try {
      await useDeviceStore.getState().scan();
      expect(disconnect).not.toHaveBeenCalled();
      expect(useDeviceStore.getState().activeId).toBe(SECONDARY.id);
      expect(useDeviceStore.getState().scanErrors).toEqual(['android: 超时']);
    } finally {
      useSessionStore.setState({ disconnect: originalDisconnect, ready: {} });
    }
  });

  it('安卓扫描源报错时不把附屏缺席算作关闭', async () => {
    useDeviceStore.setState({ devices: [MAIN, SECONDARY], activeId: SECONDARY.id });
    listDevicesMock.mockResolvedValue({
      devices: [info(MAIN)],
      errors: [{ provider: 'android', message: 'dumpsys 暂时不可用' }],
    });
    await useDeviceStore.getState().scan();
    expect(useDeviceStore.getState().missingDisplays[SECONDARY.id]).toBeUndefined();
    expect(useDeviceStore.getState().activeId).toBe(SECONDARY.id);
  });
});
