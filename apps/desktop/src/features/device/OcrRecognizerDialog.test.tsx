/**
 * 文字识别（OCR）识别器表单。
 *
 * OCR 和图像模板是同一层的识别器，但表单是**两张**：模板认图，OCR 认字。
 * 这里钉住拆分后的行为：
 * 1. 图像草稿仍走模板浮层，OCR 草稿才出现「要识别的文字」；
 * 2. OCR 默认置信度 0.6（文字分数整体偏低），没填字不能保存；
 * 3. 画面栏 OCR 扫描后点文字框，草稿直接带着读到的字进 OCR 表单。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DraftForm } from '@/features/device/DraftForm';
import { OcrRecognizerDialog } from '@/features/device/OcrRecognizerDialog';
import { useUiStore } from '@/stores/ui.store';
import type { RecordDraft } from '@/types';

const DRAFT: RecordDraft = {
  deviceId: 'android:test',
  mode: 'marquee',
  rect: [0.1, 0.1, 0.2, 0.1],
  label: 'main_region_1',
  threshold: 0.6,
  score: 0.9,
  asEnter: true,
  asActionTarget: true,
  search: 'region',
  kind: 'ocr',
  text: '金币',
  ocrMode: 'contains',
  targetMode: 'new',
  targetNodeId: null,
  newNodeName: '新界面',
  newNodeId: 'node_1',
};

function renderOcr(draft: RecordDraft = DRAFT): void {
  useUiStore.setState({ draft: { ...draft } });
  render(<OcrRecognizerDialog deviceId="android:test" />);
}

afterEach(() => {
  useUiStore.setState({ draft: null, recordKind: 'template', recordMode: 'off' });
});

describe('OcrRecognizerDialog 文字识别', () => {
  it('打开就是 OCR 表单：预填要认的字，阈值 0.60，可以保存', () => {
    renderOcr();

    expect(screen.getByTestId('ocr-recognizer-dialog')).toBeInTheDocument();
    expect(screen.getByTestId<HTMLInputElement>('draft-ocr-text')).toHaveValue('金币');
    expect(screen.getByText(/置信度阈值/).textContent).toContain('0.60');
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  });

  it('文字清空后保存不可用，填回来又可用', () => {
    renderOcr();

    fireEvent.change(screen.getByTestId('draft-ocr-text'), { target: { value: '   ' } });
    expect(useUiStore.getState().draft?.text).toBe('   ');
    expect(screen.getByText('填了要识别的文字才能保存')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();

    fireEvent.change(screen.getByTestId('draft-ocr-text'), { target: { value: '领取奖励' } });
    expect(useUiStore.getState().draft?.text).toBe('领取奖励');
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  });

  it('匹配方式可以选「相等」', () => {
    renderOcr();

    const select = screen.getByTestId<HTMLSelectElement>('draft-ocr-mode');
    expect(select.value).toBe('contains');

    fireEvent.change(select, { target: { value: 'equals' } });
    expect(useUiStore.getState().draft?.ocrMode).toBe('equals');
  });

  it('没有搜索范围选项：只在步骤里配', () => {
    renderOcr();
    expect(screen.queryByTestId('draft-search-control')).toBeNull();
    expect(screen.queryByText('搜索范围')).toBeNull();
  });

  it('取消：草稿直接丢掉，不落盘', () => {
    renderOcr();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(useUiStore.getState().draft).toBeNull();
  });

  it('同一个位置按 kind 分派：模板浮层 / OCR 浮层只出现一个', () => {
    useUiStore.setState({ draft: { ...DRAFT, kind: 'template', text: undefined, ocrMode: undefined } });
    const first = render(<DraftForm deviceId="android:test" />);
    expect(screen.getByTestId('record-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('ocr-recognizer-dialog')).toBeNull();
    first.unmount();

    useUiStore.setState({ draft: { ...DRAFT } });
    render(<DraftForm deviceId="android:test" />);
    expect(screen.getByTestId('ocr-recognizer-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('record-overlay')).toBeNull();
  });

  it('画面栏 OCR 扫描后点文字框：草稿直接是 OCR，并带着读到的字', () => {
    useUiStore.setState({ draft: null, recordKind: 'template' });

    useUiStore.getState().beginDraft({
      rect: [0.1, 0.1, 0.12, 0.05],
      score: 0.9,
      mode: 'pick',
      kind: 'ocr',
      text: '开始挑战',
      label: '开始挑战',
    });

    const draft = useUiStore.getState().draft;
    expect(draft?.kind).toBe('ocr');
    expect(draft?.text).toBe('开始挑战');
    expect(draft?.label).toBe('开始挑战');
    expect(draft?.threshold).toBeCloseTo(0.6);
    expect(draft?.ocrMode).toBe('contains');
  });
});
