/**
 * 步骤链 → 画布连线。
 *
 * 画布只画 `flowEdges` 里真实存在的线：连一条加一条，删一条就断，
 * 不再按数组顺序补线，也不因为连线搬动节点。
 */
import { MarkerType, type Edge } from '@xyflow/react';

import { flowEdges } from '@/features/graph/flow/flow-edge-model';
import { isHiddenFlowStep } from '@/features/graph/flow/flow-hidden';
import { parseBlocks } from '@/features/graph/flow/flow-structure-core';
import { sourcePortsForStepType, type FlowSourceHandleId } from '@/features/graph/flow/flow-step-ports';
import { lineStyleForStep } from '@/features/graph/flow/flow-step-settings';
import type { FlowStep } from '@/types';

function branchEdge(
  source: FlowStep,
  target: FlowStep,
  sourceHandle: FlowSourceHandleId,
  label?: string,
  segment: 'next' | 'back' = 'next',
  targetHandle: string = 'in',
): Edge {
  const visual = lineStyleForStep(source, segment);
  const orthogonal = segment === 'back' || sourceHandle === 'body' || targetHandle === 'back';
  return {
    id: `flow_${source.id}_${sourceHandle}_${target.id}`,
    source: source.id,
    target: target.id,
    sourceHandle,
    targetHandle,
    type: orthogonal ? 'step' : 'default',
    animated: visual.animated,
    label: label ?? visual.label,
    style: {
      stroke: visual.stroke,
      strokeWidth: visual.strokeWidth,
      ...(visual.strokeDasharray ? { strokeDasharray: visual.strokeDasharray } : {}),
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: visual.stroke,
      width: orthogonal ? 14 : 16,
      height: orthogonal ? 14 : 16,
    },
  };
}

function labelOf(handle: FlowSourceHandleId): string | undefined {
  if (handle === 'then') {
    return '成立';
  }
  if (handle === 'else') {
    return '不成立';
  }
  return undefined;
}

/** 块内最后一个「画得出来」的内容步骤（跳过隐藏标记/循环跳出/未接线模块）。 */
function lastContentStep(steps: readonly FlowStep[], start: number, end: number): FlowStep | undefined {
  for (let index = end - 1; index > start; index -= 1) {
    const step = steps[index];
    if (!step || isHiddenFlowStep(step) || step.type === 'loopbreak' || step.params?._pendingLink) {
      continue;
    }
    return step;
  }
  return undefined;
}

/** 由 `_out` 连线渲染画布上的全部连线。 */
export function buildBranchFlowEdges(steps: readonly FlowStep[]): Edge[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const indexById = new Map(steps.map((step, index) => [step.id, index]));
  const blocks = parseBlocks(steps);
  const edges: Edge[] = [];
  for (const edge of flowEdges(steps)) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      continue;
    }
    const loopBlock =
      target.type === 'loop'
        ? blocks.find((item) => item.kind === 'loop' && item.headId === target.id)
        : undefined;
    const sourceIndex = indexById.get(source.id) ?? -1;
    const back = Boolean(loopBlock && sourceIndex > loopBlock.headIndex && sourceIndex < loopBlock.endIndex);
    const line = branchEdge(
      source,
      target,
      edge.sourceHandle,
      labelOf(edge.sourceHandle),
      back ? 'back' : 'next',
      back ? 'back' : 'in',
    );
    // 回到循环开头的线和进入循环体的线用流动虚线，和普通"往后走"的线区分开
    edges.push(
      back || edge.sourceHandle === 'body'
        ? { ...line, animated: true, style: { ...line.style, strokeDasharray: '6 4' } }
        : line,
    );
  }
  for (const block of blocks) {
    if (block.kind !== 'loop') {
      continue;
    }
    const loop = byId.get(block.headId);
    const tail = lastContentStep(steps, block.headIndex, block.endIndex);
    if (!loop || !tail) {
      continue;
    }
    const tailIndex = indexById.get(tail.id) ?? -1;
    // 循环体结尾是嵌套的条件/循环块：重复与否由那个块决定，别补一条假的回线
    const nested = blocks.some(
      (item) => item.headId !== block.headId && item.headIndex < tailIndex && tailIndex < item.endIndex,
    );
    // 尾巴自己都接不到下一步（条件/结束/循环），或者已经画了回线：不用补
    const hasOut = sourcePortsForStepType(tail.type).some((port) => port.id === 'out');
    if (nested || !hasOut || edges.some((edge) => edge.source === tail.id)) {
      continue;
    }
    const line = branchEdge(tail, loop, 'out', undefined, 'back', 'back');
    // 循环天然会回到开头：这条线是结构推导出来的，用户删不掉（要断循环请删「循环」本身）
    edges.push({
      ...line,
      id: `flow_loopback_${tail.id}_${loop.id}`,
      animated: true,
      deletable: false,
      selectable: false,
      style: { ...line.style, strokeDasharray: '6 4' },
    });
  }
  return edges;
}
