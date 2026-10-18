/**
 * 套循环：把链上连续选中的一段包进 loop / loopend（M2）。
 */
import { flowEdges, linearizeFlow, type FlowEdge } from '@/features/graph/flow/flow-edge-model';
import { isFlowHeadTriggerStep, newStepId } from '@/features/graph/flow/flow-step-meta';
import {
  blockOfStep,
  isBlockHead,
  structureFail,
  structureOk,
  validateFlowSteps,
  type StructureResult,
} from '@/features/graph/flow/flow-structure';
import type { FlowStep } from '@/types';

const BLOCK_END_MARKS = new Set(['else', 'condend', 'loopend']);

function sortedContiguousIndices(
  steps: readonly FlowStep[],
  selectedIds: readonly string[],
): number[] | null {
  const indices = selectedIds
    .map((id) => steps.findIndex((step) => step.id === id))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  if (indices.length === 0 || indices.length !== selectedIds.length) {
    return null;
  }
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i] !== indices[i - 1]! + 1) {
      return null;
    }
  }
  return indices;
}

/** 能否套循环；null = 可以 */
export function wrapSelectionInLoopReason(
  steps: readonly FlowStep[],
  selectedIds: readonly string[],
): string | null {
  if (selectedIds.length === 0) {
    return '请先选中至少一个模块';
  }
  const indices = sortedContiguousIndices(steps, selectedIds);
  if (!indices) {
    return '套循环只能选链上连续的一段（Shift 多选相邻模块）';
  }
  const start = indices[0]!;
  const end = indices[indices.length - 1]!;
  const selected = new Set(selectedIds);
  if (isFlowHeadTriggerStep(steps[start]!, start)) {
    return '不能把触发器套进循环';
  }
  if (BLOCK_END_MARKS.has(steps[start]!.type)) {
    return '选区起点不能是「否则 / 条件结束 / 循环结束」';
  }
  if (BLOCK_END_MARKS.has(steps[end]!.type)) {
    // 整块一起选中时，终点正好是它的「条件结束 / 循环结束」是正常的
    const block = blockOfStep(steps, steps[end]!.id);
    const headSelected =
      block !== null && block.headIndex >= start && selected.has(steps[block.headIndex]!.id);
    if (!headSelected || steps[end]!.type === 'else') {
      return '选区终点不能是块的结束标记';
    }
  }
  for (const id of selectedIds) {
    const step = steps.find((item) => item.id === id);
    if (!step || !isBlockHead(step.type)) {
      continue;
    }
    const block = blockOfStep(steps, id);
    if (!block) {
      continue;
    }
    for (let index = block.headIndex; index <= block.endIndex; index += 1) {
      if (!selected.has(steps[index]!.id)) {
        return '选中「条件 / 循环」开头时，须把整块一起选中';
      }
    }
  }
  return null;
}

export function wrapSelectionInLoop(
  steps: readonly FlowStep[],
  selectedIds: readonly string[],
  count = 2,
): StructureResult {
  const reason = wrapSelectionInLoopReason(steps, selectedIds);
  if (reason) {
    return structureFail(reason);
  }
  const indices = sortedContiguousIndices(steps, selectedIds)!;
  const start = indices[0]!;
  const end = indices[indices.length - 1]!;
  const loopId = newStepId();
  const loopHead: FlowStep = { id: loopId, type: 'loop', params: { count: Math.max(1, Math.floor(count)) } };
  const loopEnd: FlowStep = { id: newStepId(), type: 'loopend', params: { back: loopId } };
  const range = steps.slice(start, end + 1);
  const next: FlowStep[] = [...steps.slice(0, start), loopHead, ...range, loopEnd, ...steps.slice(end + 1)];
  // 连线跟着搬：进这一段的线改接循环头，出这一段的线改从循环的「下一步」出发，
  // 循环自己的「进入」口指向这一段的第一步。
  const inside = new Set(range.map((step) => step.id));
  const edges: FlowEdge[] = [];
  for (const edge of flowEdges(steps)) {
    if (!inside.has(edge.source) && inside.has(edge.target)) {
      edges.push({ ...edge, target: loopId });
    } else if (inside.has(edge.source) && !inside.has(edge.target)) {
      edges.push({ source: loopId, sourceHandle: 'out', target: edge.target });
    } else {
      edges.push(edge);
    }
  }
  edges.push({ source: loopId, sourceHandle: 'body', target: range[0]!.id });
  const result = linearizeFlow(next, edges);
  if (!result.ok) {
    return structureFail(`套循环后结构不合法：${result.error}`);
  }
  const problem = validateFlowSteps(result.steps);
  if (problem) {
    return structureFail(`套循环后结构不合法：${problem}`);
  }
  return structureOk(result.steps);
}
