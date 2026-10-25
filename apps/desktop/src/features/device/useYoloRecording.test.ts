import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useYoloRecording } from '@/features/device/useYoloRecording';

const { meta, start, stop, remove } = vi.hoisted(() => ({
  meta: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@/lib/rpc', () => ({
  recordingMeta: meta,
  recordingStart: start,
  recordingStop: stop,
  recordingDelete: remove,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function options() {
  return {
    deviceId: 'dev',
    frameFps: 24,
    getFrame: vi.fn(() => Promise.resolve(null)),
    setSnapshot: vi.fn(),
    lastIndexRef: { current: null },
    cursorRef: { current: 0 },
    setFrameNote: vi.fn(),
    setCursorAt: vi.fn(),
    setFollowing: vi.fn(),
    setPlaying: vi.fn(),
    setPreview: vi.fn(),
    showFrame: vi.fn(() => Promise.resolve()),
    takingRef: { current: null },
  };
}

describe('useYoloRecording 性能和浏览位置', () => {
  it('fps变化不重启轮询或从头读取，新增帧不把浏览光标推尾，fps在开始时冻结', async () => {
    vi.useFakeTimers();
    start.mockResolvedValue({ recordingId: 'rec' });
    meta
      .mockResolvedValueOnce({ indices: [100, 101], hasMore: false })
      .mockResolvedValueOnce({ indices: [102, 103], hasMore: false });
    const config = options();
    const { result, rerender } = renderHook((props) => useYoloRecording(props), { initialProps: config });
    await act(async () => {
      await result.current.toggleRecording();
    });
    expect(meta).toHaveBeenCalledExactlyOnceWith('dev', 'rec', undefined);
    expect(result.current.liveTake?.fps).toBe(24);
    expect(config.setCursorAt).not.toHaveBeenCalled();
    expect(config.setFollowing).not.toHaveBeenCalled();
    expect(config.setPlaying).not.toHaveBeenCalled();
    rerender({ ...config, frameFps: 29.97 });
    expect(meta).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(meta).toHaveBeenLastCalledWith('dev', 'rec', 101);
    expect(result.current.liveTake?.indices).toEqual([100, 101, 102, 103]);
    expect(result.current.liveTake?.fps).toBe(24);
    expect(config.setCursorAt).not.toHaveBeenCalled();
  });

  it('停止录制只保存素材，不冻结/替换画面，不停止回放或清除检测结果', async () => {
    vi.useFakeTimers();
    start.mockResolvedValue({ recordingId: 'rec' });
    stop.mockResolvedValue({ active: false });
    meta.mockResolvedValue({ indices: [100, 101], hasMore: false });
    const config = options();
    const { result } = renderHook(() => useYoloRecording(config));
    await act(async () => {
      await result.current.toggleRecording();
    });
    await act(async () => {
      await result.current.toggleRecording();
    });
    expect(result.current.takes).toHaveLength(1);
    expect(config.setFollowing).not.toHaveBeenCalled();
    expect(config.setPlaying).not.toHaveBeenCalled();
    expect(config.setPreview).not.toHaveBeenCalled();
    expect(config.setSnapshot).not.toHaveBeenCalled();
    expect(config.getFrame).not.toHaveBeenCalled();
    expect(config.setCursorAt).not.toHaveBeenCalled();
  });

  it('慢轮询不重叠，等待上一轮完成才允许下一轮', async () => {
    vi.useFakeTimers();
    start.mockResolvedValue({ recordingId: 'rec' });
    let finish: ((value: { indices: number[]; hasMore: boolean }) => void) | undefined;
    meta.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const config = options();
    const { result } = renderHook(() => useYoloRecording(config));
    await act(async () => {
      await result.current.toggleRecording();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    expect(meta).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish?.({ indices: [100], hasMore: false });
      await Promise.resolve();
    });
    meta.mockResolvedValue({ indices: [101], hasMore: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(meta).toHaveBeenCalledTimes(2);
    expect(meta).toHaveBeenLastCalledWith('dev', 'rec', 100);
  });
});
