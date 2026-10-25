/**
 * 从模块栏插入模块。
 *  - 单步模块：作为"未接入"的游离段追加到链尾（引擎不会执行，直到用线接进链里）；
 *  - 「条件」：**成对**生成（条件 + 条件结束），配对 id 一次写对，
 *    删除时也成对删（见 `removeStepsFromChain`）—— 不再让用户自己拖两个模块、再手动凑配对。
 *  - 拖到某模块身上 / 输出口 / 输入口：先追加再按落点接线，一步到位（见 `insertPaletteModuleAfter/Before`）。
 */
import { initialPositionForInsertedStep } from '@/features/graph/flow/flow-drop-placement';
import { withFlowPendingLink } from '@/features/graph/flow/flow-pending-link';
import { FLOW_NODE_GAP_X, FLOW_ORIGIN } from '@/features/graph/flow/flow-spacing';
import {
  connectSteps,
  defaultSourceHandle,
  insertUnitBefore,
  type StructureResult,
} from '@/features/graph/flow/flow-structure';
import type { FlowSourceHandleId } from '@/features/graph/flow/flow-step-ports';
import {
  defaultModuleStep,
  isKnownFlowStepType,
  isTriggerType,
  newStepId,
  type PaletteModule,
} from '@/features/graph/flow/flow-step-meta';
import type { FlowStep } from '@/types';

/** 与自动排版同一份格距：新模块插进来时，右边的节点要让出「一张卡片 + 间距」 */
const X_GAP = FLOW_NODE_GAP_X;
const PAIR_GAP = 2 * X_GAP;
/** 同一行里，落点附近这么近的节点算"挡路" */
const ROW_TOLERANCE_Y = 70;

export interface PaletteInsertResult {
  readonly steps: FlowStep[];
  readonly insertedIds: readonly string[];
  readonly primaryId: string;
}

export type PaletteInsertOutcome =
  ({ readonly ok: true } & PaletteInsertResult) | { readonly ok: false; readonly error: string };

/** 引擎要求链首必须是触发器；空链或脏数据时先补一块手动触发。 */
function ensureFlowTriggerHead(steps: readonly FlowStep[]): FlowStep[] {
  const head = steps[0];
  if (head && isTriggerType(head.type)) {
    return [...steps];
  }
  return [{ id: newStepId(), type: 'manual', params: {} }, ...steps];
}

function newStepsForModule(module: PaletteModule): FlowStep[] | null {
  if (
    !isKnownFlowStepType(module.type) ||
    module.type === 'condend' ||
    module.type === 'else' ||
    module.type === 'loopend' ||
    module.type === 'parallelbranch' ||
    module.type === 'parallelend'
  ) {
    return null;
  }
  const head = defaultModuleStep(module);
  if (module.type === 'cond') {
    return [head, { id: newStepId(), type: 'condend', params: { back: head.id } }];
  }
  if (module.type === 'loop') {
    return [head, { id: newStepId(), type: 'loopend', params: { back: head.id } }];
  }
  if (module.type === 'parallel') {
    const count = Math.min(4, Math.max(2, Number(head.params?.branches ?? 2)));
    return [
      head,
      ...Array.from({ length: count }, (_, n) => ({
        id: newStepId(),
        type: 'parallelbranch',
        params: { parallel: head.id, branch: n + 1 },
      })),
      { id: newStepId(), type: 'parallelend', params: { parallel: head.id } },
    ];
  }
  return [head];
}

/** 追加到链尾（未接入段；段首打 `_pendingLink`） */
export function appendPaletteModule(
  existing: readonly FlowStep[],
  module: PaletteModule,
): PaletteInsertResult | null {
  const inserted = newStepsForModule(module);
  if (!inserted) {
    return null;
  }
  const base = ensureFlowTriggerHead(existing);
  const tail = [withFlowPendingLink(inserted[0]!), ...inserted.slice(1)];
  return {
    steps: [...base, ...tail],
    insertedIds: tail.map((step) => step.id),
    primaryId: tail[0]!.id,
  };
}

/** 拖到某模块的输出口 / 模块身上：新模块接在该出口后面（立即接入链） */
export function insertPaletteModuleAfter(
  existing: readonly FlowStep[],
  afterStepId: string,
  module: PaletteModule,
  handle?: FlowSourceHandleId,
): PaletteInsertOutcome {
  const built = appendPaletteModule(existing, module);
  if (!built) {
    return { ok: false, error: `「${module.label}」不能单独添加` };
  }
  const anchor = built.steps.find((step) => step.id === afterStepId);
  if (!anchor) {
    return { ok: true, ...built };
  }
  const linked = connectSteps(
    built.steps,
    afterStepId,
    built.primaryId,
    handle ?? defaultSourceHandle(anchor.type),
    'in',
  );
  return fromStructure(linked, built);
}

/** 拖到某模块的输入口：新模块插在该模块之前 */
export function insertPaletteModuleBefore(
  existing: readonly FlowStep[],
  beforeStepId: string,
  module: PaletteModule,
): PaletteInsertOutcome {
  const built = appendPaletteModule(existing, module);
  if (!built) {
    return { ok: false, error: `「${module.label}」不能单独添加` };
  }
  return fromStructure(insertUnitBefore(built.steps, built.primaryId, beforeStepId), built);
}

function fromStructure(result: StructureResult, built: PaletteInsertResult): PaletteInsertOutcome {
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, steps: result.steps, insertedIds: built.insertedIds, primaryId: built.primaryId };
}

interface Pos {
  readonly x: number;
  readonly y: number;
}

function effectivePositions(
  steps: readonly { id: string }[],
  stored: Readonly<Record<string, Pos>>,
): Map<string, Pos> {
  const map = new Map<string, Pos>();
  steps.forEach((step, index) => {
    map.set(step.id, stored[step.id] ?? { x: FLOW_ORIGIN.x + index * X_GAP, y: FLOW_ORIGIN.y });
  });
  return map;
}

/**
 * 给新插入的模块定位，并**给它让位**：
 * 落点右边同一行的、链上排在它后面的节点整体右移，避免新模块压在别人身上
 * （连续插入时避免节点叠在一起）。
 * 传了 `dropPosition`（拖到画布空白处）就用落点，不让位。
 */
export function storePositionsForInsertedSteps(
  allSteps: readonly { id: string }[],
  insertedIds: readonly string[],
  afterStepId: string | null,
  stored: Readonly<Record<string, { x: number; y: number }>>,
  dropPosition?: { x: number; y: number },
  options?: { before?: boolean; appended?: boolean },
): Record<string, { x: number; y: number }> {
  if (insertedIds.length === 0) {
    return { ...stored };
  }
  const primaryId = insertedIds[0]!;
  const next: Record<string, Pos> = { ...stored };
  const place = (anchorPos: Pos): void => {
    next[primaryId] = anchorPos;
    for (let i = 1; i < insertedIds.length; i += 1) {
      next[insertedIds[i]!] = { x: anchorPos.x + i * PAIR_GAP, y: anchorPos.y };
    }
  };

  if (dropPosition) {
    place(dropPosition);
    return next;
  }

  const effective = effectivePositions(allSteps, stored);
  const insertedSet = new Set(insertedIds);

  if (options?.before && afterStepId) {
    // 「插在 anchor 之前」：新模块占 anchor 的位置，anchor 及同一行右边的整体右移
    const anchorPos = effective.get(afterStepId) ?? { x: FLOW_ORIGIN.x, y: FLOW_ORIGIN.y };
    const width = insertedIds.length > 1 ? PAIR_GAP + X_GAP : X_GAP;
    shiftRow(allSteps, next, effective, insertedSet, anchorPos, width);
    place(anchorPos);
    return next;
  }

  if (afterStepId) {
    const anchorPos = effective.get(afterStepId) ?? { x: FLOW_ORIGIN.x, y: FLOW_ORIGIN.y };
    const target = { x: anchorPos.x + X_GAP, y: anchorPos.y };
    const width = insertedIds.length > 1 ? PAIR_GAP + X_GAP : X_GAP;
    if (!options?.appended) {
      shiftRow(allSteps, next, effective, insertedSet, target, width);
    }
    place(target);
    return next;
  }

  const fallback = initialPositionForInsertedStep(allSteps, primaryId, null, stored);
  place(fallback);
  return next;
}

/** 把"落点右边、同一行"的非新增节点整体右移 `width` */
function shiftRow(
  allSteps: readonly { id: string }[],
  next: Record<string, Pos>,
  effective: Map<string, Pos>,
  insertedSet: ReadonlySet<string>,
  from: Pos,
  width: number,
): void {
  allSteps.forEach((step) => {
    if (insertedSet.has(step.id)) {
      return;
    }
    const pos = effective.get(step.id);
    if (!pos) {
      return;
    }
    if (Math.abs(pos.y - from.y) <= ROW_TOLERANCE_Y && pos.x >= from.x - X_GAP / 2) {
      next[step.id] = { x: pos.x + width, y: pos.y };
    }
  });
}
