import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exampleThumbnailStyle } from '@/features/device/yolo-example-thumbnail';
import { YoloExampleGallery } from '@/features/recognizers/YoloExampleGallery';
import { invalidateYoloExamples } from '@/features/recognizers/yolo-example-revision';
import type { YoloExamplePayload, YoloRecognizerDetail } from '@/lib/rpc';

const { detailMock } = vi.hoisted(() => ({
  detailMock: vi.fn<(deviceId: string, label: string) => Promise<YoloRecognizerDetail>>(),
}));
vi.mock('@/lib/rpc', () => ({ recognizerDetail: detailMock }));

function example(index = 0): YoloExamplePayload {
  return {
    image: `data:image/png;base64,example${index}`,
    rect: index % 2 ? [0.2, 0.1, 0.1, 0.5] : [0.25, 0.25, 0.5, 0.25],
    width: 800,
    height: 600,
    label: `目标${index + 1}`,
  };
}

function detail(examples: YoloExamplePayload[]): YoloRecognizerDetail {
  return {
    label: 'ai', threshold: 0.3, search: 'region', imgsz: 640,
    tile: false, tileSize: 640, tileOverlap: 0.2, examples,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let deviceId: string;
let sequence = 0;
beforeEach(() => {
  deviceId = `gallery-test-${++sequence}`;
  detailMock.mockReset();
});
afterEach(cleanup);

describe('YoloExampleGallery', () => {
  it('共享失效更新同标签所有预览，隔离晚到旧请求且不影响其他标签', async () => {
    const old = deferred<YoloRecognizerDetail>();
    detailMock.mockImplementation((_device, label) => label === 'shared-invalidate'
      ? old.promise : Promise.resolve(detail([example(0)])));
    const view = render(<><YoloExampleGallery deviceId={deviceId} label="shared-invalidate" compact /><YoloExampleGallery deviceId={deviceId} label="shared-invalidate" /><YoloExampleGallery deviceId={deviceId} label="untouched" /></>);
    await screen.findByRole('img');
    expect(detailMock).toHaveBeenCalledTimes(2);
    detailMock.mockResolvedValue(detail([example(1)]));
    act(() => { invalidateYoloExamples('shared-invalidate'); });
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(3));
    expect(detailMock).toHaveBeenCalledTimes(3);
    expect(screen.getAllByRole('img').filter((image) => image.getAttribute('aria-label')?.includes('目标2'))).toHaveLength(2);
    await act(async () => { old.resolve(detail([example(0)])); await old.promise; });
    expect(screen.getAllByRole('img').filter((image) => image.getAttribute('aria-label')?.includes('目标2'))).toHaveLength(2);
    view.unmount();
    await act(async () => { render(<YoloExampleGallery deviceId={deviceId} label="shared-invalidate" />); await Promise.resolve(); });
    expect(screen.getByRole('img')).toHaveAccessibleName('目标2 · 标记图片 1');
    expect(detailMock).toHaveBeenCalledTimes(3);
    act(() => { invalidateYoloExamples(); });
    await waitFor(() => expect(detailMock).toHaveBeenCalledTimes(4));
    await screen.findByRole('img');
  });

  it('compact 最多三张并显示真实总数，切换完整模式不重拉', async () => {
    detailMock.mockResolvedValue(detail(Array.from({ length: 8 }, (_, index) => example(index))));
    const view = render(<YoloExampleGallery deviceId={deviceId} label="compact" compact />);
    expect(await screen.findAllByRole('img')).toHaveLength(3);
    expect(screen.getByText('共 8 张标记图片')).toBeInTheDocument();
    view.rerender(<YoloExampleGallery deviceId={deviceId} label="compact" compact={false} />);
    expect(screen.getAllByRole('img')).toHaveLength(8);
    expect(screen.queryByText('共 8 张标记图片')).not.toBeInTheDocument();
    expect(detailMock).toHaveBeenCalledTimes(1);
  });

  it('展示全部示例并复用标记范围裁剪，不截断为少数图片或显示完整帧', async () => {
    const examples = Array.from({ length: 12 }, (_, index) => example(index));
    detailMock.mockResolvedValue(detail(examples));
    render(<YoloExampleGallery deviceId={deviceId} label="ai" examplesCount={12} />);

    expect(screen.getByRole('status')).toHaveTextContent('加载标记图片');
    const images = await screen.findAllByRole('img');
    expect(images).toHaveLength(12);
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getByRole('list')).toHaveClass('flex-wrap');
    expect(detailMock).toHaveBeenCalledWith(deviceId, 'ai');
    examples.forEach((item, index) => {
      const style = exampleThumbnailStyle(item.image, item.rect, item.width, item.height);
      expect(images[index]).toHaveStyle({
        backgroundImage: style.backgroundImage,
        backgroundSize: style.backgroundSize,
        backgroundPosition: style.backgroundPosition,
        clipPath: style.clipPath,
      });
      expect(images[index]).toHaveAccessibleName(`${item.label} · 标记图片 ${index + 1}`);
    });
  });

  it('零示例显示明确空态，也复用空结果缓存', async () => {
    detailMock.mockResolvedValue(detail([]));
    const view = render(<YoloExampleGallery deviceId={deviceId} label="empty" examplesCount={0} />);
    expect(await screen.findByText('暂无标记图片')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    view.unmount();
    await act(async () => {
      render(<YoloExampleGallery deviceId={deviceId} label="empty" examplesCount={0} />);
      await Promise.resolve();
    });
    expect(screen.getByText('暂无标记图片')).toBeInTheDocument();
    expect(detailMock).toHaveBeenCalledTimes(1);
  });

  it('加载失败后允许重试，重试期间显示加载态', async () => {
    const retry = deferred<YoloRecognizerDetail>();
    detailMock.mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(retry.promise);
    render(<YoloExampleGallery deviceId={deviceId} label="retry" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('标记图片加载失败');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(screen.getByRole('status')).toHaveTextContent('加载标记图片');
    await act(async () => {
      retry.resolve(detail([example()]));
      await retry.promise;
    });
    expect(await screen.findByRole('img')).toBeInTheDocument();
    expect(detailMock).toHaveBeenCalledTimes(2);
  });

  it('父组件实时 score 更新/新对象 rerender 不会重拉，相同 props 卸载重开复用缓存', async () => {
    detailMock.mockResolvedValue(detail([example()]));
    function ScoreRow({ score }: { score: number }) {
      const recognizer = { label: 'score-ai', examplesCount: 1, score };
      return <><span>分数 {recognizer.score}</span><YoloExampleGallery deviceId={deviceId} label={recognizer.label} examplesCount={recognizer.examplesCount} revision={0} /></>;
    }
    const view = render(<ScoreRow score={0.1} />);
    await screen.findByRole('img');
    view.rerender(<ScoreRow score={0.9} />);
    view.rerender(<ScoreRow score={0.8} />);
    expect(screen.getByText('分数 0.8')).toBeInTheDocument();
    expect(detailMock).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      render(<ScoreRow score={0.7} />);
      await Promise.resolve();
    });
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(detailMock).toHaveBeenCalledTimes(1);
  });

  it('并发挂载与加载中折叠重开共享 inflight 请求', async () => {
    const pending = deferred<YoloRecognizerDetail>();
    detailMock.mockReturnValue(pending.promise);
    const first = render(<YoloExampleGallery deviceId={deviceId} label="pending" />);
    const second = render(<YoloExampleGallery deviceId={deviceId} label="pending" />);
    first.unmount();
    render(<YoloExampleGallery deviceId={deviceId} label="pending" />);
    expect(detailMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(detail([example()]));
      await pending.promise;
    });
    expect(await screen.findAllByRole('img')).toHaveLength(2);
    second.unmount();
  });

  it('device、label、examplesCount 和 revision 都参与缓存 key；版本递增刷新同数量图片', async () => {
    detailMock.mockResolvedValue(detail([example()]));
    const initial = { deviceId, label: 'key-ai', examplesCount: 1, revision: 0 };
    const view = render(<YoloExampleGallery {...initial} />);
    await screen.findByRole('img');
    const changes = [
      { ...initial, revision: 1 },
      { ...initial, revision: 1, examplesCount: 2 },
      { ...initial, revision: 1, examplesCount: 2, label: 'other-ai' },
      { ...initial, revision: 1, examplesCount: 2, label: 'other-ai', deviceId: `${deviceId}-other` },
    ];
    for (const [index, props] of changes.entries()) {
      view.rerender(<YoloExampleGallery {...props} />);
      await waitFor(() => expect(detailMock).toHaveBeenCalledTimes(index + 2));
      await screen.findByRole('img');
    }
    await act(async () => {
      view.rerender(<YoloExampleGallery {...initial} />);
      await Promise.resolve();
    });
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(detailMock).toHaveBeenCalledTimes(5);
  });

  it('切换 props 立即隐藏旧图片，晚到的旧成功结果不能覆盖新行', async () => {
    const old = deferred<YoloRecognizerDetail>();
    const next = deferred<YoloRecognizerDetail>();
    detailMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const view = render(<YoloExampleGallery deviceId={deviceId} label="old" />);
    view.rerender(<YoloExampleGallery deviceId={deviceId} label="new" />);
    await act(async () => {
      next.resolve(detail([example(1)]));
      await next.promise;
    });
    expect(screen.getByRole('img')).toHaveAccessibleName('目标2 · 标记图片 1');
    await act(async () => {
      old.resolve(detail([example(0)]));
      await old.promise;
    });
    expect(screen.getByRole('img')).toHaveAccessibleName('目标2 · 标记图片 1');
    detailMock.mockRejectedValueOnce(new Error('third unavailable'));
    view.rerender(<YoloExampleGallery deviceId={deviceId} label="third" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    await screen.findByRole('alert');
  });

  it('复合 revision 隔离同设备同标签的不同工作流', async () => {
    detailMock.mockResolvedValueOnce(detail([example(0)])).mockResolvedValueOnce(detail([example(1)]));
    const view = render(<YoloExampleGallery deviceId={deviceId} label="shared-ai" revision="workflow-a:0" />);
    expect(await screen.findByRole('img')).toHaveAccessibleName('目标1 · 标记图片 1');
    view.rerender(<YoloExampleGallery deviceId={deviceId} label="shared-ai" revision="workflow-b:0" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(await screen.findByRole('img')).toHaveAccessibleName('目标2 · 标记图片 1');
    expect(detailMock).toHaveBeenCalledTimes(2);
  });

  it('晚到的旧失败不污染新 props 的成功状态', async () => {
    const old = deferred<YoloRecognizerDetail>();
    detailMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(detail([example(1)]));
    const view = render(<YoloExampleGallery deviceId={deviceId} label="old-error" />);
    view.rerender(<YoloExampleGallery deviceId={deviceId} label="new-success" />);
    await screen.findByRole('img');
    await act(async () => {
      old.reject(new Error('old failure'));
      await old.promise.catch(() => undefined);
    });
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
