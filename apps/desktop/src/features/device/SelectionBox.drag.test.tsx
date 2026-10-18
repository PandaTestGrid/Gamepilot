import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { DraftSelectionBox } from './SelectionBox';
import { useUiStore } from '@/stores/ui.store';

const IMAGE_BOX = { left: 0, top: 0, width: 600, height: 1200 };

function seedPick(): void {
  useUiStore.setState({ draft: null, pickSize: 120 });
  useUiStore.getState().beginDraft({
    rect: [0.1, 0.1, 0.2, 0.1],
    resolution: [600, 1200],
    mode: 'pick',
    pickCenter: [0.2, 0.15],
    label: 'wifi',
    score: 0.92,
  });
}

function renderBox(): HTMLElement {
  const { container } = render(
    <div data-screen-viewport>
      <DraftSelectionBox imageBox={IMAGE_BOX} draft={useUiStore.getState().draft!} />
    </div>,
  );
  const viewport = container.querySelector('[data-screen-viewport]') as HTMLElement;
  viewport.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: IMAGE_BOX.width,
      height: IMAGE_BOX.height,
      right: IMAGE_BOX.width,
      bottom: IMAGE_BOX.height,
      x: 0,
      y: 0,
    }) as DOMRect;
  return container;
}

describe('DraftSelectionBox 交互', () => {
  beforeEach(() => {
    seedPick();
  });

  it('拖动框体移动位置，并同步点选中心', () => {
    const container = renderBox();
    const body = container.querySelector('[data-drag="move"]') as HTMLElement;
    fireEvent.pointerDown(body, { clientX: 60, clientY: 120, pointerId: 1, button: 0 });
    fireEvent.pointerMove(body, { clientX: 120, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(body, { clientX: 120, clientY: 180, pointerId: 1 });

    const draft = useUiStore.getState().draft!;
    expect(draft.rect[0]).toBeCloseTo(0.2);
    expect(draft.rect[1]).toBeCloseTo(0.15);
    expect(draft.rect[2]).toBeCloseTo(0.2);
    expect(draft.rect[3]).toBeCloseTo(0.1);
    expect(draft.pickCenter?.[0]).toBeCloseTo(0.3);
    expect(draft.pickCenter?.[1]).toBeCloseTo(0.2);
  });

  it('拖右下角缩放，仍是设备像素正方形', () => {
    const container = renderBox();
    const corner = container.querySelector('[data-corner="se"]') as HTMLElement;
    fireEvent.pointerDown(corner, { clientX: 180, clientY: 240, pointerId: 1, button: 0 });
    fireEvent.pointerMove(corner, { clientX: 360, clientY: 600, pointerId: 1 });
    fireEvent.pointerUp(corner, { clientX: 360, clientY: 600, pointerId: 1 });

    const draft = useUiStore.getState().draft!;
    expect(draft.rect[2] * 600).toBeCloseTo(draft.rect[3] * 1200);
    expect(useUiStore.getState().pickSize).toBe(Math.round(draft.rect[2] * 600));
  });
});
