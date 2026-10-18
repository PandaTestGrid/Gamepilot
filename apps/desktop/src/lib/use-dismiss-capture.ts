/**
 * 框选 / 点选 / 录操作是临时工具：点到画面和工具栏以外，或按 Esc，就关掉。
 * 画面上继续拖框/落点、草稿表单里填名字，都还算「没离开」。
 */
import { useEffect } from 'react';

import { useOcrStore } from '@/stores/ocr.store';
import { useUiStore } from '@/stores/ui.store';

function isCaptureKeepTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-capture-keep]'));
}

export function useDismissCaptureOnBlur(): void {
  const capturing = useUiStore(
    (state) =>
      state.recordMode !== 'off' ||
      state.recordActionMode ||
      Boolean(state.draft) ||
      Boolean(state.pendingFlowSwipeStepId),
  );
  const hasOcrMarks = useOcrStore((state) => Object.keys(state.pickBoxes).length > 0);

  useEffect(() => {
    if (!capturing && !hasOcrMarks) {
      return;
    }

    const dismiss = (): void => {
      useUiStore.getState().cancelCaptureTools();
      useOcrStore.getState().clearPickBoxes();
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (isCaptureKeepTarget(event.target)) {
        return;
      }
      dismiss();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        dismiss();
      }
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [capturing, hasOcrMarks]);
}
