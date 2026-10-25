import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FrameTimeline, takeDurationText } from '@/features/device/FrameTimeline';

const INDICES = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
function setup(overrides: Partial<Parameters<typeof FrameTimeline>[0]> = {}) {
  const onSeek = vi.fn();
  const utils = render(<FrameTimeline indices={INDICES} cursor={4} onSeek={onSeek} {...overrides} />);
  return { ...utils, onSeek };
}

describe('FrameTimeline', () => {
  it('短录制逐帧展示，刻度、胶片与滚动条独立分区', () => {
    setup();
    expect(screen.getAllByTestId('yolo-timeline-thumb')).toHaveLength(10);
    const track = screen.getByTestId('yolo-timeline-track');
    const scrollbar = screen.getByTestId('yolo-timeline-scrollbar');
    expect(track).toHaveClass('overflow-hidden');
    expect(scrollbar).toHaveClass('h-4', 'shrink-0', 'overflow-x-scroll');
    expect(track).not.toContainElement(scrollbar);
    expect(screen.getByTestId('yolo-timeline-filmstrip')).not.toContainElement(scrollbar);
    expect(screen.getByTestId('yolo-timeline-ruler')).toBeInTheDocument();
  });

  it('十万帧仅挂载视口附近格子，完整滚动宽度和所有帧位置均保留', () => {
    setup({ indices: Array.from({ length: 100_000 }, (_, index) => 200 + index), cursor: 0 });
    expect(screen.getAllByTestId('yolo-timeline-thumb').length).toBeLessThan(20);
    expect(screen.getByTestId('yolo-timeline-content').style.width).toBe(`${8 + 100_000 * 78 - 2}px`);
    fireEvent.scroll(screen.getByTestId('yolo-timeline-scrollbar'), { target: { scrollLeft: 99_990 * 78 } });
    const cells = screen.getAllByTestId('yolo-timeline-thumb');
    expect(cells.length).toBeLessThan(20);
    expect(cells.at(-1)).toHaveAttribute('title', '第 100199 帧');
    expect(screen.getByTestId('yolo-timeline-track').scrollLeft).toBe(99_990 * 78);
  });

  it('录制时新增帧、光标更新和fps波动都不滚到后面', () => {
    const indices = Array.from({ length: 240 }, (_, index) => 200 + index);
    const { rerender, onSeek } = setup({ indices, cursor: 0, recording: true });
    const track = screen.getByTestId('yolo-timeline-track');
    Object.defineProperty(track, 'clientWidth', { configurable: true, value: 156 });
    fireEvent.scroll(screen.getByTestId('yolo-timeline-scrollbar'), { target: { scrollLeft: 390 } });
    rerender(<FrameTimeline indices={[...indices, 440]} cursor={240} onSeek={onSeek} recording fps={30} />);
    expect(track.scrollLeft).toBe(390);
    expect(screen.getByTestId('yolo-timeline-scrollbar').scrollLeft).toBe(390);
  });

  it('非录制逐帧切换自动滚动，手动浏览不会被缩略图更新拉回', () => {
    const { rerender, onSeek } = setup({ cursor: 0 });
    const track = screen.getByTestId('yolo-timeline-track');
    Object.defineProperty(track, 'clientWidth', { configurable: true, value: 156 });
    rerender(<FrameTimeline indices={INDICES} cursor={9} onSeek={onSeek} />);
    expect(track.scrollLeft).toBe(630);
    fireEvent.scroll(screen.getByTestId('yolo-timeline-scrollbar'), { target: { scrollLeft: 0 } });
    rerender(<FrameTimeline indices={INDICES} cursor={9} onSeek={onSeek} thumbnails={new Map()} />);
    expect(track.scrollLeft).toBe(0);
  });

  it('没有帧时显示录制提示', () => {
    setup({ indices: [], cursor: 0 });
    expect(screen.getByTestId('yolo-frame-timeline')).toHaveTextContent('还没有录制');
  });

  it('每格只显示自己的图，不拿相邻帧冒充', () => {
    setup({
      thumbnails: new Map([
        ['buffer:100', 'data:image/jpeg;base64,AA'],
        ['buffer:104', 'data:image/jpeg;base64,BB'],
      ]),
    });
    const cells = screen.getAllByTestId('yolo-timeline-thumb');
    expect(cells.filter((cell) => cell.querySelector('span[aria-hidden="true"]'))).toHaveLength(2);
    expect(cells[1]?.querySelector('span')).toBeNull();
  });

  it('缩略图最多2路并发，快速滚动丢弃旧视口未开始任务', async () => {
    const resolvers: Array<() => void> = [];
    const onRequestThumbnail = vi.fn<(frame: number, id?: string) => Promise<void>>(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    setup({ indices: Array.from({ length: 1000 }, (_, index) => index), cursor: 0, onRequestThumbnail });
    await waitFor(() => expect(onRequestThumbnail).toHaveBeenCalledTimes(2));
    fireEvent.scroll(screen.getByTestId('yolo-timeline-scrollbar'), { target: { scrollLeft: 7800 } });
    expect(onRequestThumbnail).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolvers[0]?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(onRequestThumbnail).toHaveBeenCalledTimes(3));
    expect(onRequestThumbnail.mock.calls[2]?.[0]).toBe(98);
    expect(onRequestThumbnail.mock.calls.some(([frame]) => frame > 1 && frame < 98)).toBe(false);
  });

  it('图片被缓存淘汰后，滚回原视口可以重新请求', async () => {
    const indices = Array.from({ length: 240 }, (_, index) => 200 + index);
    const onRequestThumbnail = vi.fn<(frame: number, id?: string) => void>();
    const onSeek = vi.fn();
    const { rerender } = render(
      <FrameTimeline indices={indices} cursor={0} onSeek={onSeek} onRequestThumbnail={onRequestThumbnail} />,
    );
    await waitFor(() => expect(onRequestThumbnail).toHaveBeenCalledWith(200, undefined));
    const thumbnails = new Map([['buffer:200', 'data:image/jpeg;base64,AA']]);
    rerender(
      <FrameTimeline
        indices={indices}
        cursor={0}
        onSeek={onSeek}
        onRequestThumbnail={onRequestThumbnail}
        thumbnails={thumbnails}
      />,
    );
    fireEvent.scroll(screen.getByTestId('yolo-timeline-scrollbar'), { target: { scrollLeft: 7800 } });
    onRequestThumbnail.mockClear();
    rerender(
      <FrameTimeline
        indices={indices}
        cursor={0}
        onSeek={onSeek}
        onRequestThumbnail={onRequestThumbnail}
        thumbnails={new Map()}
      />,
    );
    fireEvent.scroll(screen.getByTestId('yolo-timeline-scrollbar'), { target: { scrollLeft: 0 } });
    await waitFor(() => expect(onRequestThumbnail).toHaveBeenCalledWith(200, undefined));
  });

  it('滚动后按真实格子位置选帧，同一格内拖动不重复取帧', () => {
    const { onSeek } = setup();
    fireEvent.scroll(screen.getByTestId('yolo-timeline-scrollbar'), { target: { scrollLeft: 390 } });
    const hit = screen.getByTestId('yolo-timeline-hit');
    fireEvent.pointerDown(hit, { clientX: 90, pointerId: 1, button: 0 });
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(6);
    fireEvent.pointerMove(hit, { clientX: 91, pointerId: 1 });
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it('键盘逐帧/首尾与原生range均可选帧，禁用不妨碍浏览', () => {
    const { onSeek, rerender } = setup();
    const track = screen.getByTestId('yolo-timeline-track');
    fireEvent.keyDown(track, { key: 'ArrowRight' });
    expect(onSeek).toHaveBeenLastCalledWith(5);
    fireEvent.keyDown(track, { key: 'Home' });
    expect(onSeek).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(track, { key: 'End' });
    expect(onSeek).toHaveBeenLastCalledWith(9);
    fireEvent.change(screen.getByTestId('yolo-frame-slider'), { target: { value: '2' } });
    expect(onSeek).toHaveBeenLastCalledWith(2);
    onSeek.mockClear();
    rerender(<FrameTimeline indices={INDICES} cursor={4} onSeek={onSeek} disabled />);
    fireEvent.keyDown(track, { key: 'ArrowLeft' });
    expect(onSeek).not.toHaveBeenCalled();
  });
});

describe('takeDurationText', () => {
  it('用录制时冻结的fps算时长，缺失fps或不足2帧时不显示', () => {
    expect(takeDurationText(INDICES, 10)).toBe('0.9s');
    expect(takeDurationText(INDICES, undefined)).toBeNull();
    expect(takeDurationText([100], 10)).toBeNull();
  });
});
