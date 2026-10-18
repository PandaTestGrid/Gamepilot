/**
 * 内嵌预览的两种长相：
 * - 图像模板：没取到图时显示「…」占位（老行为）
 * - OCR：不摆模板卡片的架子，直接亮出"读哪段字" —— 以前它没有 template 字段，
 *   取图永远为空，卡片上只剩下一个「…」和内部标签，用户根本看不出它在认什么
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RecognizerInlinePreview } from '@/features/recognizers/RecognizerInlinePreview';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));

describe('RecognizerInlinePreview', () => {
  it('OCR 识别器显示要读的字，而不是空白图片占位', () => {
    render(<RecognizerInlinePreview label="region_7" ocrText="进入背包" />);

    expect(screen.getByText('「进入背包」')).toBeInTheDocument();
    expect(screen.getByText('文字识别')).toBeInTheDocument();
    expect(screen.getByText('读「进入背包」')).toBeInTheDocument();
    expect(screen.queryByText('…')).not.toBeInTheDocument();
  });

  it('OCR 没填文字时说明还缺什么，不留「…」', () => {
    render(<RecognizerInlinePreview label="region_7" ocrText="" />);

    expect(screen.getByText('还没填要识别的文字')).toBeInTheDocument();
    expect(screen.queryByText('…')).not.toBeInTheDocument();
  });

  it('图像模板仍然是模板预览（没有图时是占位态）', () => {
    render(<RecognizerInlinePreview label="start_btn" />);

    expect(screen.getByText('加载模板…')).toBeInTheDocument();
    expect(screen.queryByText('文字识别')).not.toBeInTheDocument();
  });
});
