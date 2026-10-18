/**
 * 框选 / 点选 / 录操作：点到画面外或 Esc 就关掉。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useDismissCaptureOnBlur } from '@/lib/use-dismiss-capture';
import { useOcrStore } from '@/stores/ocr.store';
import { useUiStore } from '@/stores/ui.store';

function Probe(): null {
  useDismissCaptureOnBlur();
  return null;
}

describe('useDismissCaptureOnBlur', () => {
  beforeEach(() => {
    useUiStore.setState({
      recordMode: 'off',
      recordActionMode: false,
      draft: null,
      pendingFlowRecStepId: null,
      pendingFlowClickRegionStepId: null,
      pendingFlowClickCoordStepId: null,
      pendingFlowSwipeStepId: null,
    });
    useOcrStore.setState({ pickBoxes: {} });
  });

  it('点在画面 / 工具栏上：模式还开着', () => {
    useUiStore.setState({ recordMode: 'pick' });
    render(
      <div>
        <Probe />
        <div data-capture-keep data-testid="keep">
          画面
        </div>
      </div>,
    );

    fireEvent.pointerDown(screen.getByTestId('keep'));
    expect(useUiStore.getState().recordMode).toBe('pick');
  });

  it('点到外面或按 Esc：框选、录操作、OCR 标记一起关', () => {
    useUiStore.setState({ recordMode: 'marquee', recordActionMode: false });
    useOcrStore.setState({ pickBoxes: { 'mock:1': [{ text: '开始', score: 0.9, rect: [0, 0, 0.1, 0.1] }] } });
    render(
      <div>
        <Probe />
        <button type="button" data-testid="outside">
          外面
        </button>
      </div>,
    );

    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(useUiStore.getState().recordMode).toBe('off');
    expect(useOcrStore.getState().pickBoxes).toEqual({});

    act(() => {
      useUiStore.setState({ recordActionMode: true });
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().recordActionMode).toBe(false);
  });
});
