/**
 * 断开画布上的一条线：从源步骤的 `_out` 里删掉它，再把图线性化回 `steps`。
 *
 * 断开只是"不连了"：下游变成「未接入」（引擎走到它就停），位置不动，
 * 也不会因为前后相邻而自动接上别的模块。
 */
import { disconnectFlowSteps } from '@/features/graph/flow/flow-edge-model';
import type { StructureResult } from '@/features/graph/flow/flow-structure-core';
import type { FlowStep } from '@/types';

export interface FlowEdgeRef {
  readonly sourceId: string;
  readonly targetId: string;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
}

export function disconnectSteps(steps: readonly FlowStep[], edge: FlowEdgeRef): StructureResult {
  return disconnectFlowSteps(steps, edge);
}
