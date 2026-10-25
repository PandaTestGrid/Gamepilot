import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { useSessionStore } from '@/stores/session.store';
import type { DeviceRuntime } from '@/types';

const handlers = vi.hoisted(
  () => [] as Array<(event: { payload: { method: string; params: Record<string, unknown> } }) => void>,
);
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    (
      _name: string,
      handler: (event: { payload: { method: string; params: Record<string, unknown> } }) => void,
    ) => {
      handlers.push(handler);
      return Promise.resolve(() => {
        handlers.length = 0;
      });
    },
  ),
}));

const DEVICE: DeviceRuntime = {
  id: 'android:emulator-5554:42',
  name: 'MuMu · 屏2',
  uri: 'Android:///?serial=emulator-5554&display=2&physical=42',
  kind: 'emulator',
  status: 'connected',
  resolution: [100, 200],
  fps: 10,
};

function notify(method: string, params: Record<string, unknown>): void {
  handlers[0]?.({ payload: { method, params } });
}

let unlisten: () => void;

describe('截图失败与恢复通知', () => {
  beforeAll(async () => {
    unlisten = await useSessionStore.getState().init();
  });
  afterAll(() => {
    unlisten();
    useSessionStore.getState().setStreamPolicy(DEVICE.id, 0);
  });
  beforeEach(() => {
    useDeviceStore.setState({ devices: [DEVICE], activeId: DEVICE.id });
    useSessionStore.setState({ ready: { [DEVICE.id]: true }, error: null, links: {} });
    useEventStore.setState({ events: {}, seq: 0 });
  });

  it('设备列表变化通知请求刷新，扫描中也保留这次变化', () => {
    const scan = vi.spyOn(useDeviceStore.getState(), 'scan').mockResolvedValue();
    try {
      notify('device.list.changed', { provider: 'android' });
      expect(scan).toHaveBeenCalledWith(true);
    } finally {
      scan.mockRestore();
    }
  });

  it('相同的失败只提示一次，画面恢复后重新显示已连接并更新通道说明', () => {
    const failure = {
      deviceId: DEVICE.id,
      error: '截图失败: 暂时无画面',
      channel: 'scrcpy',
      linkNote: 'scrcpy 608×1280',
    };
    notify('device.failed', failure);
    notify('device.failed', failure);

    expect(useDeviceStore.getState().devices[0]?.status).toBe('failed');
    expect(useSessionStore.getState().ready[DEVICE.id]).toBe(true); // 会话仍在后台重试
    expect(
      (useEventStore.getState().events[DEVICE.id] ?? []).filter((event) => event.type === 'error'),
    ).toHaveLength(1);

    notify('device.recovered', { deviceId: DEVICE.id, channel: 'scrcpy', linkNote: 'scrcpy 608×1280' });
    expect(useDeviceStore.getState().devices[0]?.status).toBe('connected');
    expect(useSessionStore.getState().error).toBeNull();
    expect(useSessionStore.getState().links[DEVICE.id]).toEqual({
      channel: 'scrcpy',
      note: 'scrcpy 608×1280',
    });
  });
});
