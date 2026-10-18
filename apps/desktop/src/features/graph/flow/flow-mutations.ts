/**
 * 所有会改 `flow.steps` 顺序的 UI 操作，统一映射到 `flow-structure` 的纯函数。
 * 画布连线、（间接）模块插入后的接线，都应走这里。
 */
import { isBranchSourceHandle, type FlowSourceHandleId } from '@/features/graph/flow/flow-step-ports';
import {
  connectSteps,
  connectionRejectReason,
  insertUnitBefore,
  type StructureResult,
} from '@/features/graph/flow/flow-structure';
import type { ModuleDropTarget } from '@/features/graph/flow/flow-drop-target';
import type { PaletteModule } from '@/features/graph/flow/flow-step-meta';
import { devLog } from '@/lib/rpc';
import type { FlowStep } from '@/types';

export interface ModuleDropDeps {
  readonly appendFlowModule: (
    item: PaletteModule,
    options?: { position?: { x: number; y: number } },
  ) => Promise<string | null>;
  readonly insertFlowModuleAfter: (
    afterStepId: string,
    item: PaletteModule,
    options?: { handle?: FlowSourceHandleId },
  ) => Promise<string | null>;
  readonly insertFlowModuleBefore: (beforeStepId: string, item: PaletteModule) => Promise<string | null>;
}

export async function applyModuleDrop(
  target: ModuleDropTarget,
  module: PaletteModule,
  dropFlowPosition: { x: number; y: number } | null,
  deps: ModuleDropDeps,
): Promise<string | null> {
  devLog(
    `模块拖入: ${module.label} target=${target.anchorStepId ?? '-'} placement=${target.placement}` +
      ` handle=${target.handleId ?? '-'} in=${target.onInputHandle ? 1 : 0} out=${target.onOutputHandle ? 1 : 0}`,
  );
  if (!target.onCanvas) {
    return null;
  }
  if (target.anchorStepId) {
    if (target.onInputHandle) {
      return deps.insertFlowModuleBefore(target.anchorStepId, module);
    }
    return deps.insertFlowModuleAfter(
      target.anchorStepId,
      module,
      target.handleId ? { handle: target.handleId } : undefined,
    );
  }
  return deps.appendFlowModule(module, dropFlowPosition ? { position: dropFlowPosition } : undefined);
}

export function normalizeSourceHandle(sourceHandle?: string | null): FlowSourceHandleId {
  return isBranchSourceHandle(sourceHandle) ? sourceHandle : 'out';
}

/** 画布拖线预览 / 松手提示：与 `structureFromCanvasLink` 同一套规则 */
export function flowConnectionRejectReason(
  steps: readonly FlowStep[],
  sourceId: string,
  targetId: string,
  sourceHandle?: string | null,
  targetHandle?: string | null,
): string | null {
  return connectionRejectReason(steps, sourceId, targetId, sourceHandle, targetHandle);
}

export function isFlowConnectionAllowed(
  steps: readonly FlowStep[],
  sourceId: string,
  targetId: string,
  sourceHandle?: string | null,
  targetHandle?: string | null,
): boolean {
  return flowConnectionRejectReason(steps, sourceId, targetId, sourceHandle, targetHandle) === null;
}

/** 画布：出口 → 入口 */
export function structureFromCanvasLink(
  steps: readonly FlowStep[],
  sourceId: string,
  targetId: string,
  sourceHandle?: string | null,
  targetHandle?: string | null,
): StructureResult {
  return connectSteps(steps, sourceId, targetId, normalizeSourceHandle(sourceHandle), targetHandle);
}

export type StepReorderPlacement = 'before' | 'after';

export interface StepReorderTarget {
  readonly anchorStepId: string;
  readonly placement: StepReorderPlacement;
  readonly handleId?: FlowSourceHandleId;
}

/** 程序化重排步骤（store API；无序列 UI） */
export function structureFromStepReorder(
  steps: readonly FlowStep[],
  draggedStepId: string,
  target: StepReorderTarget,
): StructureResult {
  if (target.handleId) {
    return connectSteps(steps, target.anchorStepId, draggedStepId, target.handleId);
  }
  if (target.placement === 'before') {
    return insertUnitBefore(steps, draggedStepId, target.anchorStepId);
  }
  return connectSteps(steps, target.anchorStepId, draggedStepId, 'out');
}
