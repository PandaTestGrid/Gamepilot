/**
 * 画布上「一张卡片到底多高」——自动排版要靠它算纵向间距。
 *
 * 卡片高度是内容撑开的（`FlowStepNode` 里条件卡片有几行条件就有多高：一行约 218、
 * 两行约 345），写死一个 Y_GAP 必然会压住下面那一行。所以：
 *  - 自动排版时优先用**真实尺寸**（`measureFlowNodesFromDom()`，`offsetHeight` 不吃 zoom）；
 *  - 量不到时（首次渲染、刚插入还没上屏的节点）用 `estimateFlowNodeSize()` 估个偏大的值。
 */
import { condGroupsFromParams } from '@/features/graph/flow/flow-cond-params';
import { parallelBranchCount } from '@/features/graph/flow/flow-step-ports';
import type { FlowStep } from '@/types';

export interface FlowNodeSize {
  readonly w: number;
  readonly h: number;
}

/** 估一个偏保守的尺寸：宁可多留白，也不让分支被头节点压住 */
export function estimateFlowNodeSize(step: FlowStep): FlowNodeSize {
  if (step.type === 'cond') {
    const rows = Math.max(1, condGroupsFromParams(step.params ?? {}).length);
    // 实测：1 行 218，2 行 345 → 90 + 行数 × 130
    return { w: 228, h: 90 + rows * 130 };
  }
  if (step.type === 'parallel') {
    // Include the join output and preserve enough separation between 2–4 branch handles.
    return { w: 300, h: Math.max(240, 100 + parallelBranchCount(step) * 40) };
  }  if (step.type === 'loop') {
    return { w: 260, h: 130 };
  }
  return { w: 300, h: 240 };
}

/**
 * 从画布上量当前所有卡片的真实尺寸（`offsetWidth/offsetHeight` 是布局尺寸，
 * 不受画布缩放影响）。拿不到 DOM（测试 / 还没渲染）时返回空表。
 */
export function measureFlowNodesFromDom(): Map<string, FlowNodeSize> {
  const sizes = new Map<string, FlowNodeSize>();
  if (typeof document === 'undefined') {
    return sizes;
  }
  for (const element of document.querySelectorAll<HTMLElement>('[data-flow-step-id]')) {
    const id = element.dataset.flowStepId;
    if (id && element.offsetWidth > 0 && element.offsetHeight > 0) {
      sizes.set(id, { w: element.offsetWidth, h: element.offsetHeight });
    }
  }
  return sizes;
}

/** 量到的尺寸优先，量不到就估 */
export function flowNodeSizeLookup(
  sizes: ReadonlyMap<string, FlowNodeSize>,
): (step: FlowStep) => FlowNodeSize {
  return (step) => sizes.get(step.id) ?? estimateFlowNodeSize(step);
}
