import { flowEdges, linearizeFlow, withFlowEdges } from './flow-edge-model';
import { isHiddenFlowStep } from './flow-hidden';
import { parseBlocks, structureFail, type StructureResult } from './flow-structure-core';
import type { FlowStep } from '@/types';

/** 改分支数保留原有线；有内容分支不能直接删，避免静默变成未接入模块。 */
export function resizeParallelBranches(
  steps: readonly FlowStep[],
  parallelId: string,
  newBranches: number,
): StructureResult {
  if (!Number.isInteger(newBranches) || newBranches < 2 || newBranches > 4)
    return structureFail('并行分支数必须为 2–4');
  const block = parseBlocks(steps).find((item) => item.kind === 'parallel' && item.headId === parallelId);
  if (!block) return structureFail('找不到完整的并行模块');
  const discarded = (block.branches ?? []).filter((branch) => branch.branch > newBranches);
  for (const branch of discarded) {
    if (steps.slice(branch.markerIndex + 1, branch.endIndex).some((step) => !isHiddenFlowStep(step)))
      return structureFail(`分支 ${branch.branch} 还有模块，请先移走或删除内容再减少分支`);
  }
  const ids = new Set(discarded.map((branch) => branch.markerId));
  const next = steps
    .filter((step) => !ids.has(step.id))
    .map((step) =>
      step.id === parallelId ? { ...step, params: { ...step.params, branches: newBranches } } : step,
    );
  const edges = flowEdges(steps).filter(
    (edge) =>
      !(
        edge.source === parallelId &&
        edge.sourceHandle.startsWith('branch') &&
        Number(edge.sourceHandle.slice(6)) > newBranches
      ),
  );
  return linearizeFlow(withFlowEdges(next, edges), edges);
}
