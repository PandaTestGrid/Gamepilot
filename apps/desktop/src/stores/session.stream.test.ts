/**
 * 推流策略的回归：引擎重启 / 重连后必须重新下发 `device.stream`。
 *
 * 引擎重启后须清掉 streamPolicy 缓存，否则不会重新下发 device.stream。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type FrameState, useSessionStore } from '@/stores/session.store';

const invoke = vi.fn((_cmd: string, _args?: Record<string, unknown>): Promise<unknown> =>
  Promise.resolve({}),
);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>): Promise<unknown> => invoke(cmd, args),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const DEVICE_ID = 'android:emulator-5554:42';

/** 只数 `device.stream`（setStreamFps）下发了几次、每次 fps 是多少 */
function streamFpsCalls(): number[] {
  return invoke.mock.calls
    .filter((call) => call[1]?.method === 'device.stream')
    .map((call) => Number((call[1]?.params as { fps?: number } | undefined)?.fps));
}

function frameRequests(): number {
  return invoke.mock.calls.filter((call) => call[0] === 'engine_frame').length;
}

function frameState(index: number): FrameState {
  return {
    imageUrl: 'blob:gamepilot/frame',
    index,
    resolution: [1280, 720],
    node: null,
    pending: null,
    tick: index,
    fps: 10,
    captureMs: 0.5,
    detections: [],
    ts: 0,
  };
}

/** pullFrame 是异步的：等几轮微任务把它走完 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** jsdom 没实现 blob URL；补上以免"拉帧失败的噪声"干扰断言 */
function stubObjectUrl(): void {
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      value: () => 'blob:gamepilot/frame',
      configurable: true,
      writable: true,
    });
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: () => undefined,
      configurable: true,
      writable: true,
    });
  }
}

describe('推流策略：引擎重启后旧缓存不能挡住新的 device.stream', () => {
  beforeEach(() => {
    invoke.mockClear();
    stubObjectUrl();
    useSessionStore.getState().resetForEngineRestart();
  });

  afterEach(() => {
    useSessionStore.getState().resetForEngineRestart();
    vi.useRealTimers();
  });

  it('同一 fps 不重复下发；重启清缓存后，重连会再发一次', async () => {
    useSessionStore.setState({ ready: { [DEVICE_ID]: true } });

    useSessionStore.getState().setStreamPolicy(DEVICE_ID, 10);
    await flush();
    expect(streamFpsCalls()).toEqual([10]);

    // 相同 fps：缓存命中，不重复打扰引擎
    useSessionStore.getState().setStreamPolicy(DEVICE_ID, 10);
    await flush();
    expect(streamFpsCalls()).toEqual([10]);

    // 引擎重启：连接态与推流缓存一起复位
    useSessionStore.getState().resetForEngineRestart();
    expect(useSessionStore.getState().ready).toEqual({});

    // 新进程里的会话连上后，同样的 fps 必须再下发一次（否则引擎不推帧 = 黑屏）
    useSessionStore.setState({ ready: { [DEVICE_ID]: true } });
    useSessionStore.getState().setStreamPolicy(DEVICE_ID, 10);
    await flush();
    expect(streamFpsCalls()).toEqual([10, 10]);
  });

  it('重启后旧的拉帧定时器被清掉：不再为已消失的会话抓帧', async () => {
    vi.useFakeTimers();
    useSessionStore.setState({ ready: { [DEVICE_ID]: true }, frames: { [DEVICE_ID]: frameState(1) } });
    useSessionStore.getState().setStreamPolicy(DEVICE_ID, 10);

    await vi.advanceTimersByTimeAsync(300);
    const before = frameRequests();
    expect(before).toBeGreaterThan(0);

    useSessionStore.getState().resetForEngineRestart();

    // 旧会话又报了一个"新帧号"：定时器若还在，就会继续去抓一个已经不存在的会话
    useSessionStore.setState({ frames: { [DEVICE_ID]: frameState(2) } });
    await vi.advanceTimersByTimeAsync(300);
    expect(frameRequests()).toBe(before);
  });

  it('pollFps=0 时连事件主路也不拉帧（画面已弹到独立窗口）', async () => {
    vi.useFakeTimers();
    useSessionStore.setState({ ready: { [DEVICE_ID]: true } });

    // 引擎照推（独立窗口在看），但本窗口不拉：只给引擎 fps，拉帧节奏给 0
    useSessionStore.getState().setStreamPolicy(DEVICE_ID, 10, 0);
    await flush();
    expect(streamFpsCalls()).toEqual([10]);

    // 事件到了（engine.frame 会调用 pullFrame）—— 本窗口必须一个字节都不拉
    useSessionStore.setState({ frames: { [DEVICE_ID]: frameState(1) } });
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(frameRequests()).toBe(0);
  });
});

