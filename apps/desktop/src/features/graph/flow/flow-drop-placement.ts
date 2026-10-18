import { FLOW_NODE_GAP_X as X_GAP, FLOW_ORIGIN as ORIGIN } from '@/features/graph/flow/flow-spacing';

/** 新模块在画布上的初始位置：紧挨「插在谁后面」的那一格（仅 append 链尾时用） */
export function initialPositionForInsertedStep(
  steps: readonly { id: string }[],
  newStepId: string,
  afterStepId: string | null,
  stored: Readonly<Record<string, { x: number; y: number }>>,
): { x: number; y: number } {
  const indexOf = (id: string): number => steps.findIndex((step) => step.id === id);
  const defaultAt = (index: number): { x: number; y: number } => ({
    x: ORIGIN.x + index * X_GAP,
    y: ORIGIN.y,
  });

  if (afterStepId) {
    const afterIndex = indexOf(afterStepId);
    const afterPos = stored[afterStepId] ?? defaultAt(Math.max(0, afterIndex));
    const newIndex = indexOf(newStepId);
    const next = newIndex >= 0 && newIndex + 1 < steps.length ? steps[newIndex + 1] : undefined;
    const nextPos = next ? stored[next.id] : undefined;
    if (next && next.id !== newStepId && nextPos) {
      return { x: (afterPos.x + nextPos.x) / 2, y: afterPos.y };
    }
    return { x: afterPos.x + X_GAP, y: afterPos.y };
  }

  if (steps.length <= 1) {
    return defaultAt(1);
  }
  const prev = steps[steps.length - 2];
  const prevPos = prev ? (stored[prev.id] ?? defaultAt(steps.length - 2)) : ORIGIN;
  return { x: prevPos.x + X_GAP, y: prevPos.y };
}
