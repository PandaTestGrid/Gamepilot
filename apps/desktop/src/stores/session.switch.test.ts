import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectDevice, type ConnectResult } from '@/lib/rpc';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import type { DeviceRuntime } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock('@/lib/rpc', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, connectDevice: vi.fn() };
});

const MAIN: DeviceRuntime = {
  id: 'android:emulator-5554',
  uri: 'Android:///?serial=emulator-5554',
  name: 'MuMu 主屏',
  kind: 'emulator',
  status: 'connected',
  resolution: [720, 1280],
  fps: 10,
};
const GAME: DeviceRuntime = {
  ...MAIN,
  id: 'android:emulator-5554:4',
  uri: 'Android:///?serial=emulator-5554&display=4',
  name: 'MuMu · 屏4',
  status: 'discovered',
};
const OTHER: DeviceRuntime = {
  ...GAME,
  id: 'android:emulator-5554:12',
  uri: 'Android:///?serial=emulator-5554&display=12',
  name: 'MuMu · 屏12',
  status: 'connected',
};

describe('模拟器切屏期间的会话选择', () => {
  beforeEach(() => {
    vi.mocked(connectDevice).mockReset();
    useDeviceStore.setState({ devices: [MAIN, GAME, OTHER], activeId: MAIN.id });
    useSessionStore.setState({ error: null, ready: { [MAIN.id]: true, [OTHER.id]: true } });
  });

  afterEach(() => {
    useSessionStore.getState().setStreamPolicy(GAME.id, 0);
  });

  it('新屏连接失败时保留主屏画面，并在新屏上留错误状态', async () => {
    vi.mocked(connectDevice).mockRejectedValueOnce(new Error('显示器已关闭，请刷新'));
    const ok = await useSessionStore.getState().connect(GAME.id, GAME.uri);

    expect(ok).toBe(false);
    expect(useDeviceStore.getState().activeId).toBe(MAIN.id);
    expect(useDeviceStore.getState().devices.find((device) => device.id === GAME.id)).toMatchObject({
      status: 'failed',
      error: '显示器已关闭，请刷新',
    });
    expect(useSessionStore.getState().error).toContain('请刷新');
  });

  it('连接等待时用户已切到第三屏：迟到的失败不能把他切回主屏', async () => {
    let rejectConnect!: (error: Error) => void;
    vi.mocked(connectDevice).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectConnect = reject;
      }),
    );
    const pending = useSessionStore.getState().connect(GAME.id, GAME.uri);
    useDeviceStore.getState().setActive(OTHER.id);
    rejectConnect(new Error('超时'));

    expect(await pending).toBe(false);
    expect(useDeviceStore.getState().activeId).toBe(OTHER.id);
  });

  it('连接等待时用户已切到别的屏：迟到的成功也不能抢回焦点', async () => {
    let finishConnect!: (result: ConnectResult) => void;
    vi.mocked(connectDevice).mockReturnValueOnce(new Promise((resolve) => (finishConnect = resolve)));
    const pending = useSessionStore.getState().connect(GAME.id, GAME.uri);
    useDeviceStore.getState().setActive(OTHER.id);
    finishConnect({
      deviceId: GAME.id,
      resolution: [900, 1600],
      channel: 'scrcpy',
      linkNote: 'display_id=4',
      graph: { version: 1, defaults: {}, recognizers: {}, nodes: [], edges: [] },
    });

    expect(await pending).toBe(true);
    expect(useDeviceStore.getState().activeId).toBe(OTHER.id);
    expect(useDeviceStore.getState().devices.find((device) => device.id === GAME.id)?.status).toBe(
      'connected',
    );
    expect(useSessionStore.getState().ready[GAME.id]).toBe(true);
  });
});
