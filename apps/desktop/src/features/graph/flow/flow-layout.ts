/**
 * `flow.steps` ↔ React Flow 节点/边（线性步骤 + 分支多出口边）。
 */
import { type Edge, type Node } from '@xyflow/react';

import { buildBranchFlowEdges } from '@/features/graph/flow/flow-branch-layout';
import { flowEdges } from '@/features/graph/flow/flow-edge-model';
import { isHiddenFlowMark, isHiddenFlowStep } from '@/features/graph/flow/flow-hidden';
import { isFlowStepPendingLink } from '@/features/graph/flow/flow-pending-link';
import {
  FLOW_BRANCH_GAP_Y as BRANCH_GAP,
  FLOW_NODE_GAP_X as X_GAP,
  FLOW_ORIGIN as ORIGIN,
} from '@/features/graph/flow/flow-spacing';
import { estimateFlowNodeSize, type FlowNodeSize } from '@/features/graph/flow/flow-node-size';
import { parseBlocks, type BlockSpan } from '@/features/graph/flow/flow-structure';
import { flowStepTitle, isFlowHeadTriggerStep } from '@/features/graph/flow/flow-step-meta';
import type { FlowStep } from '@/types';

/** 量到 / 估到的一张卡片尺寸 */
export type FlowSizeLookup = (step: FlowStep) => FlowNodeSize;

function hasVisibleStep(steps: readonly FlowStep[], from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) {
    const step = steps[i];
    if (step && !isHiddenFlowStep(step)) {
      return true;
    }
  }
  return false;
}

/**
 * 按块结构排版：主链从左到右；循环体 / 条件分支放在头节点**底边**下面
 * （头节点多高就往下让多少，所以条件卡片再高也不会压住下面的分支）；
 * 循环后、条件后的下一步仍在头节点右侧同一行。
 *
 * 返回完整子树包围盒：下一条 lane 避开所有嵌套分支，后续步骤避开最长分支。
 */
function layoutSequence(
  steps: readonly FlowStep[],
  from: number,
  to: number,
  originX: number,
  originY: number,
  result: Record<string, { x: number; y: number }>,
  blockByHead: ReadonlyMap<number, BlockSpan>,
  sizeOf: FlowSizeLookup,
): { bottom: number; right: number } {
  let x = originX;
  let bottom = originY;
  let right = originX;
  const place = (step: FlowStep, y: number): void => {
    result[step.id] = { x, y };
    bottom = Math.max(bottom, y + sizeOf(step).h);
    right = Math.max(right, x + sizeOf(step).w);
  };
  const layoutBranch = (start: number, end: number, y: number): number => {
    const bounds = layoutSequence(steps, start, end, x, y, result, blockByHead, sizeOf);
    bottom = Math.max(bottom, bounds.bottom);
    right = Math.max(right, bounds.right);
    return bounds.bottom;
  };
  // Retain the established grid for ordinary cards, but honor measured wider cards.
  const nextColumn = (edge: number): number => Math.max(x + X_GAP, edge + X_GAP - 300);
  let i = from;
  while (i < to) {
    const step = steps[i];
    if (!step) {
      break;
    }
    if (isHiddenFlowStep(step)) {
      result[step.id] ??= { x, y: originY };
      i += 1;
      continue;
    }
    const height = sizeOf(step).h;
    const block = blockByHead.get(i);
    if (block?.kind === 'parallel') {
      place(step, originY);
      let laneBottom = originY + height;
      for (const branch of block.branches ?? []) {
        const laneY = laneBottom + BRANCH_GAP;
        result[branch.markerId] = { x, y: laneY };
        const start = branch.markerIndex + 1;
        if (hasVisibleStep(steps, start, branch.endIndex)) {
          laneBottom = layoutBranch(start, branch.endIndex, laneY);
        } else {
          // Empty lanes still reserve a card-sized drop target for a later connection.
          layoutBranch(start, branch.endIndex, laneY);
          laneBottom = laneY + height;
        }
      }
      bottom = Math.max(bottom, laneBottom);
      x = nextColumn(right);
      result[block.endId] = { x, y: originY };
      i = block.endIndex + 1;
      continue;
    }
    if (block?.kind === 'loop') {
      place(step, originY);
      result[block.endId] = { x, y: originY };
      const bodyY = originY + height + BRANCH_GAP;
      if (hasVisibleStep(steps, i + 1, block.endIndex)) {
        layoutBranch(i + 1, block.endIndex, bodyY);
      } else {
        layoutSequence(steps, i + 1, block.endIndex, x, originY, result, blockByHead, sizeOf);
      }
      x = nextColumn(right);
      i = block.endIndex + 1;
      continue;
    }
    if (block?.kind === 'cond') {
      place(step, originY);
      result[block.endId] = { x, y: originY };
      if (block.elseId) {
        result[block.elseId] = { x, y: originY };
      }
      const thenEnd = block.elseIndex ?? block.endIndex;
      const elseStart = block.elseIndex !== null ? block.elseIndex + 1 : block.endIndex;
      let branchBottom = originY + height;
      if (hasVisibleStep(steps, i + 1, thenEnd)) {
        branchBottom = Math.max(
          branchBottom,
          layoutBranch(i + 1, thenEnd, branchBottom + BRANCH_GAP),
        );
      } else {
        layoutSequence(steps, i + 1, thenEnd, x, originY, result, blockByHead, sizeOf);
      }
      bottom = Math.max(bottom, branchBottom);
      if (hasVisibleStep(steps, elseStart, block.endIndex)) {
        bottom = Math.max(
          bottom,
          layoutBranch(elseStart, block.endIndex, branchBottom + BRANCH_GAP),
        );
      } else {
        layoutSequence(steps, elseStart, block.endIndex, x, originY, result, blockByHead, sizeOf);
      }
      x = nextColumn(right);
      i = block.endIndex + 1;
      continue;
    }
    place(step, originY);
    x = nextColumn(x + sizeOf(step).w);
    i += 1;
  }
  return { bottom, right };
}

/** 按循环 / 条件结构自动排版（隐藏的 else / condend / loopend 不占格）。 */
export function gridPositionsForSteps(
  steps: readonly FlowStep[],
  sizeOf: FlowSizeLookup = estimateFlowNodeSize,
): Record<string, { x: number; y: number }> {
  const result: Record<string, { x: number; y: number }> = {};
  const blockByHead = new Map(parseBlocks(steps).map((block) => [block.headIndex, block]));
  layoutSequence(steps, 0, steps.length, ORIGIN.x, ORIGIN.y, result, blockByHead, sizeOf);
  for (const step of steps) {
    result[step.id] ??= { x: ORIGIN.x, y: ORIGIN.y };
  }
  return result;
}

export interface FlowStepNodeData extends Record<string, unknown> {
  step: FlowStep;
  title: string;
  isTrigger: boolean;
  expanded: boolean;
  running: boolean;
  /** 最近一次运行在该步失败（已停跑时画布红框） */
  failed: boolean;
  /** 还没接进链里（引擎不会执行） */
  pending: boolean;
  /** 画布上没有一条线指向它（触发器等入口除外） */
  unconnected: boolean;
}

export type FlowStepNodeType = Node<FlowStepNodeData, 'flowStep'>;

/** 画布上没有任何线指向它的模块（触发器是入口，不算）。运行前用它提示"哪个没接"。 */
export function unconnectedFlowSteps(steps: readonly FlowStep[]): FlowStep[] {
  const reached = new Set(flowEdges(steps).map((edge) => edge.target));
  return steps.filter(
    (step, index) => !isHiddenFlowStep(step) && !isFlowHeadTriggerStep(step, index) && !reached.has(step.id),
  );
}

/** 循环体一步都没有的循环：跑起来只是按次数空转，开跑前拦下来。 */
export function emptyLoopFlowSteps(steps: readonly FlowStep[]): FlowStep[] {
  const loops: FlowStep[] = [];
  for (const block of parseBlocks(steps)) {
    if (block.kind !== 'loop') {
      continue;
    }
    if (hasVisibleStep(steps, block.headIndex + 1, block.endIndex)) {
      continue;
    }
    // 「跳出循环」也算循环体：空转之前先跳出去是允许的
    const hasBreak = steps
      .slice(block.headIndex + 1, block.endIndex)
      .some((step) => step.type === 'loopbreak');
    const head = steps[block.headIndex];
    if (!hasBreak && head) {
      loops.push(head);
    }
  }
  return loops;
}

/**
 * 整条流程开跑前的检查：有模块没接进流程就先拦下来，并说清楚是哪一个。
 * 单模块调试（`stepId` 有值）不受这条限制 —— 没接线的模块本来就该能单独跑一下看看。
 */
export function unconnectedFlowRunError(
  steps: readonly FlowStep[],
  stepId: string | undefined,
  titleOf: (step: FlowStep) => string,
): string | null {
  if (stepId) {
    return null;
  }
  const orphanSteps = unconnectedFlowSteps(steps);
  if (orphanSteps.length > 0) {
    return `这些模块没接进流程：${orphanSteps
      .map((step) => `「${titleOf(step)}」`)
      .join(
        '、',
      )}。从上一模块右侧的圆点拖线到它左侧的圆点接上，或把它删掉；只想试这一个模块就点它右上角的运行按钮。`;
  }
  const emptyLoops = emptyLoopFlowSteps(steps);
  if (emptyLoops.length > 0) {
    return `这些循环的循环体是空的：${emptyLoops
      .map((step) => `「${titleOf(step)}」`)
      .join('、')}。把要重复的步骤接到循环底部的「进入」圆点上，或把这个循环删掉。`;
  }
  return null;
}

export function stepsToFlowCanvas(
  steps: readonly FlowStep[],
  positions: Readonly<Record<string, { x: number; y: number }>>,
  selectedId: string | null,
  runningStepId: string | null = null,
): { nodes: FlowStepNodeType[]; edges: Edge[] } {
  const edges = buildBranchFlowEdges(steps);
  const reached = new Set(flowEdges(steps).map((edge) => edge.target));
  const fallbackGrid = gridPositionsForSteps(steps);
  const nodes: FlowStepNodeType[] = steps
    .map((step, index) => {
      const pos = positions[step.id] ?? fallbackGrid[step.id] ?? { x: ORIGIN.x + index * X_GAP, y: ORIGIN.y };
      const isTrigger = isFlowHeadTriggerStep(step, index);
      const isPending = isFlowStepPendingLink(step);
      return {
        id: step.id,
        type: 'flowStep' as const,
        position: pos,
        deletable: !isTrigger && !isHiddenFlowMark(step.type),
        hidden: isHiddenFlowStep(step),
        data: {
          step,
          title: flowStepTitle(step),
          isTrigger,
          expanded: selectedId === step.id,
          running: runningStepId === step.id,
          failed: false,
          pending: isPending,
          unconnected: !isTrigger && !reached.has(step.id),
        },
      };
    })
    .filter((node) => !node.hidden);

  return { nodes, edges };
}
