/**
 * store 推导的节点 ↔ React Flow 本地状态（拖动中坐标与已测量尺寸不能被覆盖）。
 *
 * 注意：@xyflow/react v12 依赖 `node.measured`（ResizeObserver 测量出的宽高）决定节点是否可见；
 * 一旦合并派生节点时丢掉 `existing.measured`，节点会被设成 `visibility: hidden`，
 * 在乐观更新 + 落盘回包的连续两次更新中会导致 ResizeObserver 不再重触发、画布节点全部消失。
 */
import type { FlowStepNodeType } from '@/features/graph/flow/flow-layout';

function preservedDimensions(
  existing: FlowStepNodeType | undefined,
): Pick<FlowStepNodeType, 'measured' | 'width' | 'height'> {
  if (!existing) {
    return {};
  }
  return {
    ...(existing.measured ? { measured: existing.measured } : {}),
    ...(existing.width !== undefined ? { width: existing.width } : {}),
    ...(existing.height !== undefined ? { height: existing.height } : {}),
  };
}

export function mergeDerivedFlowNodes(
  current: FlowStepNodeType[],
  derived: FlowStepNodeType[],
  options?: {
    resetPositions?: boolean;
    selectedIds?: ReadonlySet<string>;
    /** 这些节点的落盘坐标刚被改过（插入模块时给后面的让位）：采用推导出的新坐标 */
    forcePositionIds?: ReadonlySet<string>;
  },
): FlowStepNodeType[] {
  const byId = new Map(current.map((node) => [node.id, node]));
  if (options?.resetPositions) {
    return derived.map((node) => {
      const existing = byId.get(node.id);
      const selected =
        options?.selectedIds !== undefined ? options.selectedIds.has(node.id) : Boolean(existing?.selected);
      return {
        ...preservedDimensions(existing),
        ...node,
        ...(selected ? { selected } : {}),
      };
    });
  }
  return derived.map((node) => {
    const existing = byId.get(node.id);
    // 选中态以 store 为准；勿与 existing.selected 做 OR，否则会残留框选导致多节点一起拖
    const selected =
      options?.selectedIds !== undefined ? options.selectedIds.has(node.id) : Boolean(existing?.selected);
    const dims = preservedDimensions(existing);
    if (existing?.dragging) {
      return { ...dims, ...node, position: existing.position, dragging: true, selected };
    }
    if (existing) {
      return {
        ...dims,
        ...node,
        position: options?.forcePositionIds?.has(node.id) ? node.position : existing.position,
        selected,
      };
    }
    return selected ? { ...node, selected } : node;
  });
}
