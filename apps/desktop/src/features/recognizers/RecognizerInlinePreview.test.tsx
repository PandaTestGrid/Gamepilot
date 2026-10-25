/**
 * 内嵌预览的两种长相：
 * - 图像模板：没取到图时显示「…」占位（老行为）
 * - OCR：不摆模板卡片的架子，直接亮出"读哪段字" —— 以前它没有 template 字段，
 *   取图永远为空，卡片上只剩下一个「…」和内部标签，用户根本看不出它在认什么
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecognizerInlinePreview } from '@/features/recognizers/RecognizerInlinePreview';
import { YoloExampleGallery } from '@/features/recognizers/YoloExampleGallery';
import type * as Rpc from '@/lib/rpc';
import type { YoloExamplePayload, YoloRecognizerDetail } from '@/lib/rpc';

const { detailMock } = vi.hoisted(() => ({
  detailMock: vi.fn<(deviceId: string, label: string) => Promise<YoloRecognizerDetail>>(),
}));
vi.mock('@/lib/rpc', async (importOriginal) => ({
  ...await importOriginal<typeof Rpc>(),
  recognizerDetail: detailMock,
}));
afterEach(cleanup);

function yoloDetail(count: number): YoloRecognizerDetail {
  const examples: YoloExamplePayload[] = Array.from({ length: count }, (_, index) => ({
    image: `data:image/png;base64,inline${index}`,
    rect: [0.25, 0.25, 0.5, 0.25], width: 800, height: 600, label: '背包',
  }));
  return { label: 'ai_12', threshold: 0.3, search: 'region', imgsz: 640,
    tile: false, tileSize: 640, tileOverlap: 0.2, examples };
}

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));

describe('RecognizerInlinePreview', () => {
  it('AI 节点显示三张真实裁剪图和总数，与完整 gallery 共享一次请求', async () => {
    detailMock.mockReset().mockResolvedValue(yoloDetail(7));
    const props = { deviceId: 'inline-shared', label: 'ai_12', yoloClasses: ['ai_12', '背包', '背包'], yoloExamplesCount: 7, yoloRevision: 'workflow:1' };
    const view = render(<><RecognizerInlinePreview {...props} /><YoloExampleGallery deviceId={props.deviceId} label={props.label} examplesCount={7} revision="workflow:1" /></>);
    expect(await screen.findAllByRole('img')).toHaveLength(10);
    expect(screen.getByText('共 7 张标记图片')).toBeInTheDocument();
    expect(screen.getByText('类别：背包')).toBeInTheDocument();
    expect(screen.queryByText(/ai_12/)).not.toBeInTheDocument();
    expect(detailMock).toHaveBeenCalledTimes(1);
    act(() => {
      view.rerender(<RecognizerInlinePreview {...props} compact={false} maxHeight={200} yoloClasses={['背包', '背包']} />);
    });
    expect(screen.getByRole('list')).toHaveStyle({ maxHeight: '200px' });
    expect(screen.getAllByRole('img')).toHaveLength(7);
    expect(screen.queryByText('共 7 张标记图片')).not.toBeInTheDocument();
    expect(detailMock).toHaveBeenCalledTimes(1);
  });

  it('无示例的 AI 明示按类别名称识别，类别去重且不回退到模板', async () => {
    detailMock.mockReset().mockResolvedValue(yoloDetail(0));
    render(<RecognizerInlinePreview deviceId="inline-empty" label="ai_12" yoloClasses={[' 背包 ', '背包', '']} yoloExamplesCount={0} />);
    expect(await screen.findByText('暂无标记图片 · 按类别名称识别')).toBeInTheDocument();
    expect(screen.getByText('类别：背包')).toBeInTheDocument();
    expect(screen.queryByText('加载模板…')).not.toBeInTheDocument();
    expect(screen.queryByText('ai_12')).not.toBeInTheDocument();
  });

  it('AI 无设备时不请求，类别未配置时说明缺少类别', async () => {
    detailMock.mockReset().mockResolvedValue(yoloDetail(0));
    const view = render(<RecognizerInlinePreview label="ai_12" yoloClasses={[]} />);
    expect(screen.getByText('未连接设备 · 无法加载标记图片')).toBeInTheDocument();
    expect(detailMock).not.toHaveBeenCalled();
    view.rerender(<RecognizerInlinePreview deviceId="inline-unconfigured" label="ai_12" yoloClasses={[]} />);
    expect(await screen.findByText('暂无标记图片 · 尚未设置类别')).toBeInTheDocument();
  });

  it('OCR 识别器显示要读的字，而不是空白图片占位', async () => {
    render(<RecognizerInlinePreview label="region_7" ocrText="进入背包" />);

    expect(screen.getByText('「进入背包」')).toBeInTheDocument();
    expect(screen.getByText('文字识别')).toBeInTheDocument();
    expect(screen.getByText('读「进入背包」')).toBeInTheDocument();
    expect(screen.queryByText('…')).not.toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
  });

  it('OCR 没填文字时说明还缺什么，不留「…」', async () => {
    render(<RecognizerInlinePreview label="region_7" ocrText="" />);

    expect(screen.getByText('还没填要识别的文字')).toBeInTheDocument();
    expect(screen.queryByText('…')).not.toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
  });

  it('图像模板仍然是模板预览（没有图时是占位态）', async () => {
    render(<RecognizerInlinePreview label="start_btn" />);

    expect(screen.getByText('加载模板…')).toBeInTheDocument();
    expect(screen.queryByText('文字识别')).not.toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
  });
});
