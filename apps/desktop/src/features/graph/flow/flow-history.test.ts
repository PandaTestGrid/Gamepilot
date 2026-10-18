import { describe, expect, it } from 'vitest';

import {
  captureFlowHistory,
  flowHistoryHotkey,
  flowStepsEqual,
  isTypingTarget,
} from '@/features/graph/flow/flow-history';

describe('flowHistoryHotkey', () => {
  it('Ctrl+Z 撤销，Ctrl+Y / Ctrl+Shift+Z 重做', () => {
    expect(flowHistoryHotkey(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))).toBe('undo');
    expect(flowHistoryHotkey(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }))).toBe('redo');
    expect(flowHistoryHotkey(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true }))).toBe(
      'redo',
    );
    expect(flowHistoryHotkey(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))).toBe('undo');
  });

  it('输入框里不抢快捷键', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true });
    Object.defineProperty(event, 'target', { value: input });
    expect(isTypingTarget(input)).toBe(true);
    expect(flowHistoryHotkey(event)).toBeNull();
    input.remove();
  });
});

describe('captureFlowHistory', () => {
  it('快照是拷贝，改原数组不影响历史', () => {
    const steps = [{ id: 'a', type: 'delay', params: { ms: 1 } }];
    const snapshot = captureFlowHistory(steps, { a: { x: 1, y: 2 } });
    steps[0]!.params.ms = 99;
    expect(snapshot.steps[0]?.params).toEqual({ ms: 1 });
    expect(flowStepsEqual(snapshot.steps, [{ id: 'a', type: 'delay', params: { ms: 1 } }])).toBe(true);
  });
});
