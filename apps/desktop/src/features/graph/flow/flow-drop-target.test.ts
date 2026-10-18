import { describe, expect, it, vi } from 'vitest';

import { initialPositionForInsertedStep } from '@/features/graph/flow/flow-drop-placement';
import { resolveInsertAfterStepId, resolveModuleDropTarget } from '@/features/graph/flow/flow-drop-target';

describe('resolveModuleDropTarget', () => {
  it('returns onCanvas with step id when stack includes a step node', () => {
    const canvas = document.createElement('div');
    canvas.dataset.testid = 'flow-canvas';
    const step = document.createElement('div');
    step.className = 'react-flow__node';
    step.dataset.id = 'step_a';

    document.elementsFromPoint = vi.fn().mockReturnValue([step, canvas]);

    expect(resolveModuleDropTarget(50, 30)).toEqual({
      onCanvas: true,
      anchorStepId: 'step_a',
      placement: 'after',
      onOutputHandle: false,
      onInputHandle: false,
    });
  });

  it('returns onCanvas without step when only canvas in stack', () => {
    const canvas = document.createElement('div');
    canvas.dataset.testid = 'flow-canvas';
    document.elementsFromPoint = vi.fn().mockReturnValue([canvas]);

    expect(resolveModuleDropTarget(40, 40)).toEqual({
      onCanvas: true,
      anchorStepId: null,
      placement: 'append',
      onOutputHandle: false,
      onInputHandle: false,
    });
  });

  it('resolveInsertAfterStepId：输入口 = 插在前一步之后', () => {
    const steps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(
      resolveInsertAfterStepId(steps, {
        onCanvas: true,
        anchorStepId: 'b',
        placement: 'before',
        onOutputHandle: false,
        onInputHandle: true,
      }),
    ).toBe('a');
  });

  it('returns off canvas when outside', () => {
    const aside = document.createElement('aside');
    document.elementsFromPoint = vi.fn().mockReturnValue([aside]);

    expect(resolveModuleDropTarget(1, 1)).toEqual({
      onCanvas: false,
      anchorStepId: null,
      placement: 'append',
      onOutputHandle: false,
      onInputHandle: false,
    });
  });
});

describe('initialPositionForInsertedStep', () => {
  it('places new step to the right of anchor', () => {
    const steps = [{ id: 'a' }, { id: 'n' }];
    const pos = initialPositionForInsertedStep(steps, 'n', 'a', { a: { x: 100, y: 50 } });
    expect(pos).toEqual({ x: 460, y: 50 });
  });
});
