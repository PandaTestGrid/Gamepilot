import { describe, expect, it } from 'vitest';

import { structureFromStepReorder } from '@/features/graph/flow/flow-mutations';
import type { FlowStep } from '@/types';

function s(id: string, type: string, params: Record<string, unknown> = {}): FlowStep {
  return { id, type, params };
}

describe('structureFromStepReorder', () => {
  it('before placement uses insertUnitBefore', () => {
    const steps = [s('t', 'manual'), s('a', 'delay'), s('b', 'delay')];
    const result = structureFromStepReorder(steps, 'b', {
      anchorStepId: 'a',
      placement: 'before',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps.map((step) => step.id)).toEqual(['t', 'b', 'a']);
    }
  });
});
