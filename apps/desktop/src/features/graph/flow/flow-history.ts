/**
 * 流程图撤销 / 重做：快照步骤链 + 摆位，快捷键判定。
 * 删除会立刻 graph.save，没有这一层的话手滑就回不来。
 */
import type { NodePosition } from '@/lib/node-positions';
import type { FlowStep } from '@/types';

export const FLOW_HISTORY_LIMIT = 50;

export interface FlowHistoryEntry {
  readonly steps: readonly FlowStep[];
  readonly positions: Readonly<Record<string, NodePosition>>;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function captureFlowHistory(
  steps: readonly FlowStep[],
  positions: Readonly<Record<string, NodePosition>>,
): FlowHistoryEntry {
  return {
    steps: cloneJson(steps),
    positions: cloneJson(positions),
  };
}

export function flowStepsEqual(left: readonly FlowStep[], right: readonly FlowStep[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  return target.isContentEditable;
}

/** Ctrl/⌘Z 撤销；Ctrl/⌘Y 或 Ctrl/⌘⇧Z 重做。正在输入时让给输入框。 */
export function flowHistoryHotkey(event: KeyboardEvent): 'undo' | 'redo' | null {
  if (event.defaultPrevented || isTypingTarget(event.target)) {
    return null;
  }
  const mod = event.ctrlKey || event.metaKey;
  if (!mod || event.altKey) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key === 'z') {
    return event.shiftKey ? 'redo' : 'undo';
  }
  if (key === 'y' && !event.shiftKey) {
    return 'redo';
  }
  return null;
}
