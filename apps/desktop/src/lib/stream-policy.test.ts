import { describe, expect, it } from 'vitest';

import { PREVIEW_FPS, streamFpsForDevice } from '@/lib/stream-policy';

const BASE = {
  deviceId: 'android:abc',
  activeId: 'android:abc',
  windowed: false,
  grid: false,
  gridFps: 6,
  windowHidden: false,
  pane: null as 'screen' | 'graph' | 'events' | null,
  paneDeviceId: null as string | null,
};

describe('独立窗口推流策略', () => {
  it('主窗口：当前设备按 PREVIEW_FPS 推，其他 0；隐藏主窗口则全停', () => {
    expect(PREVIEW_FPS).toBeGreaterThanOrEqual(24);
    expect(streamFpsForDevice(BASE)).toBe(PREVIEW_FPS);
    expect(streamFpsForDevice({ ...BASE, deviceId: 'android:other' })).toBe(0);
    expect(streamFpsForDevice({ ...BASE, windowHidden: true })).toBe(0);
  });

  it('主窗口隐藏时，已经弹到独立窗口的设备仍要推帧', () => {
    expect(streamFpsForDevice({ ...BASE, windowHidden: true, windowed: true })).toBe(PREVIEW_FPS);
    expect(
      streamFpsForDevice({ ...BASE, windowHidden: true, windowed: true, deviceId: 'android:other' }),
    ).toBe(PREVIEW_FPS);
  });

  it('多开网格仍按 gridFps 压着推（不能拿单画面帧率去打网格）', () => {
    expect(streamFpsForDevice({ ...BASE, grid: true })).toBe(6);
    expect(streamFpsForDevice({ ...BASE, grid: true, windowed: true })).toBe(6);
  });

  it('独立画面窗口只给自己那台要帧，绝不把别的设备掐成 0', () => {
    expect(
      streamFpsForDevice({
        ...BASE,
        pane: 'screen',
        paneDeviceId: 'android:abc',
      }),
    ).toBe(PREVIEW_FPS);
    expect(
      streamFpsForDevice({
        ...BASE,
        deviceId: 'android:other',
        pane: 'screen',
        paneDeviceId: 'android:abc',
      }),
    ).toBeNull();
  });
});
