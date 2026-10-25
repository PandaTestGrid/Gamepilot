/**
 * 流程结构操作：连线、断开、移动、删除。
 *
 * 连线本身存在 `params._out`（见 `flow-edge-model.ts`），这里只负责把"人做的事"翻译成
 * 新的连线集合，再线性化成引擎要的 `steps` 数组。数组顺序是执行顺序的结果，不再是连线本身。
 */
import { coerceStr } from '@/lib/coerce';

import {
  connectFlowSteps,
  disconnectFlowSteps,
  flowEdges,
  insertStepBeforeFlowStep,
  withFlowEdges,
  type FlowEdge,
} from '@/features/graph/flow/flow-edge-model';
import { isHiddenFlowStep, isImplicitLoopbreak } from '@/features/graph/flow/flow-hidden';
import { isFlowStepPendingLink, withFlowPendingLink } from '@/features/graph/flow/flow-pending-link';
import {
  condLoopRepeat,
  isBlockHead,
  isBlockMark,
  parseBlocks,
  structureFail,
  structureOk,
  validateFlowSteps,
  type BlockSpan,
  type StructureResult,
} from '@/features/graph/flow/flow-structure-core';
import { isBranchSourceHandle } from '@/features/graph/flow/flow-step-ports';
import type { FlowStep } from '@/types';

export {
  blockOfStep,
  condLoopRepeat,
  defaultSourceHandle,
  isBlockHead,
  isBlockMark,
  parseBlocks,
  structureFail,
  structureOk,
  validateFlowSteps,
  type BlockKind,
  type BlockSpan,
  type StructureResult,
} from '@/features/graph/flow/flow-structure-core';

const fail = structureFail;
const ok = structureOk;

function guard(before: readonly FlowStep[], after: FlowStep[]): StructureResult {
  if (validateFlowSteps(before) === null) {
    const problem = validateFlowSteps(after);
    if (problem) {
      return structureFail(`这样连会破坏条件结构：${problem}`);
    }
  }
  return structureOk(after);
}

interface StepUnit {
  readonly start: number;
  readonly end: number;
}

export function unitOfStep(steps: readonly FlowStep[], stepId: string): StepUnit | null {
  const index = steps.findIndex((step) => step.id === stepId);
  const step = steps[index];
  if (!step || index === 0 || isBlockMark(step.type)) {
    return null;
  }
  if (isBlockHead(step.type)) {
    const block = parseBlocks(steps).find((item) => item.headId === step.id);
    if (block) {
      return { start: index, end: block.endIndex + 1 };
    }
  }
  return { start: index, end: index + 1 };
}

function indexOfId(steps: readonly FlowStep[], id: string): number {
  return steps.findIndex((step) => step.id === id);
}

function loopEnclosesStep(steps: readonly FlowStep[], loopHeadId: string, stepId: string): boolean {
  const index = indexOfId(steps, stepId);
  return parseBlocks(steps).some(
    (block) =>
      block.kind === 'loop' &&
      block.headId === loopHeadId &&
      block.headIndex < index &&
      index < block.endIndex,
  );
}

function innermostLoopHeadId(steps: readonly FlowStep[], index: number): string | null {
  let loopHeadId: string | null = null;
  let loopHeadIndex = -1;
  for (const block of parseBlocks(steps)) {
    if (
      block.kind === 'loop' &&
      block.headIndex < index &&
      index < block.endIndex &&
      block.headIndex > loopHeadIndex
    ) {
      loopHeadId = block.headId;
      loopHeadIndex = block.headIndex;
    }
  }
  return loopHeadId;
}

/** 条件某一支的最后一步（不算块标记 / 跳出循环）。 */
function branchTailOf(
  steps: readonly FlowStep[],
  block: BlockSpan,
  handle: 'then' | 'else',
): FlowStep | null {
  const start =
    handle === 'else' ? (block.elseIndex === null ? -1 : block.elseIndex + 1) : block.headIndex + 1;
  const stop = handle === 'else' ? block.endIndex : (block.elseIndex ?? block.endIndex);
  if (start < 0) {
    return null;
  }
  for (let i = stop - 1; i >= start; i -= 1) {
    const step = steps[i];
    if (!step || isBlockMark(step.type) || step.type === 'loopbreak') {
      continue;
    }
    return step;
  }
  return null;
}

/**
 * 老文件里「这一支走完再循环一次」只记在 `_loopRepeat` 参数里（原来的画布不一定画了那条线）。
 * 迁移时补一条真实的回线，这样画布上的线和引擎行为一致；之后删掉这条线就真的不再循环。
 */
function withRepeatEdges(steps: readonly FlowStep[], edges: readonly FlowEdge[]): FlowEdge[] {
  const extra: FlowEdge[] = [];
  for (const block of parseBlocks(steps)) {
    if (block.kind !== 'cond') {
      continue;
    }
    const cond = steps[block.headIndex]!;
    const repeat = condLoopRepeat(cond);
    if (!repeat) {
      continue;
    }
    const target =
      coerceStr(cond.params?._loopRepeatLoop).trim() || innermostLoopHeadId(steps, block.headIndex);
    if (!target) {
      continue;
    }
    const tail = branchTailOf(steps, block, repeat);
    if (!tail) {
      continue;
    }
    extra.push({ source: tail.id, sourceHandle: 'out', target });
  }
  return [...edges, ...extra];
}

/** 清掉老画布用的临时参数：连线之后 `_in` 不再需要（`_out` 才是真源）。 */
function withoutInLinks(step: FlowStep): FlowStep {
  if (!('_in' in (step.params ?? {}))) {
    return step;
  }
  const params = { ...step.params };
  delete params._in;
  return { ...step, params };
}

/**
 * 迁移：清掉误插的隐藏「跳出循环」，把「哪一支再循环」记在条件上，
 * 并把连线冻结进 `_out`（老文件按老的推导冻结一次，之后画布只认 `_out`）。
 */
export function migrateFlowSteps(steps: readonly FlowStep[]): FlowStep[] {
  // 旧版本/并行批量插入可能留下重复 id；先修复，否则连线按 id 建 Map 会指向错误模块。
  const seenIds = new Set<string>();
  const uniqueSteps = steps.map((step, index) => {
    let id = coerceStr(step.id).trim();
    if (!id || seenIds.has(id)) {
      const suffix = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 12) ?? `${Date.now().toString(36)}_${index}`;
      id = `s_${suffix}`;
    }
    seenIds.add(id);
    return id === step.id ? step : { ...step, id };
  });
  steps = uniqueSteps;
  const condRepeat = new Map<string, 'then' | 'else'>();
  for (const block of parseBlocks(steps)) {
    if (block.kind !== 'cond') {
      continue;
    }
    for (let i = block.headIndex + 1; i < block.endIndex; i += 1) {
      const step = steps[i];
      if (!isImplicitLoopbreak(step)) {
        continue;
      }
      const handle: 'then' | 'else' = block.elseIndex !== null && i > block.elseIndex ? 'else' : 'then';
      condRepeat.set(block.headId, handle === 'then' ? 'else' : 'then');
    }
  }
  const cleaned = steps
    .filter((step) => !isImplicitLoopbreak(step))
    .map((step) => {
      const repeating = condRepeat.get(step.id);
      if (step.type !== 'cond' || !repeating) {
        return step;
      }
      const existing = coerceStr(step.params?._loopRepeatLoop);
      const loopHeadId =
        existing && loopEnclosesStep(steps, existing, step.id)
          ? existing
          : innermostLoopHeadId(steps, indexOfId(steps, step.id));
      if (
        condLoopRepeat(step) === repeating &&
        (!loopHeadId || step.params?._loopRepeatLoop === loopHeadId)
      ) {
        return step;
      }
      return {
        ...step,
        params: {
          ...step.params,
          _loopRepeat: repeating,
          ...(loopHeadId ? { _loopRepeatLoop: loopHeadId } : {}),
        },
      };
    });
  // 老文件（完全没有 _out）按老的推导把「现在画在屏幕上的线」原样冻结；
  // 已经有 _out 的文件只做一次规范化（去掉失效目标、一个出口只留一条）。
  const legacy = !steps.some((step) => Array.isArray(step.params?._out));
  const edges = flowEdges(cleaned);
  const frozen = withFlowEdges(cleaned, legacy ? withRepeatEdges(cleaned, edges) : edges);
  return frozen.map(withoutInLinks);
}

// --- 连线 ---

export function connectSteps(
  steps: readonly FlowStep[],
  sourceId: string,
  targetId: string,
  sourceHandle: string | null | undefined,
  targetHandle?: string | null,
): StructureResult {
  const result = connectFlowSteps(steps, sourceId, targetId, sourceHandle, targetHandle);
  if (!result.ok) {
    return result;
  }
  return guard(steps, result.steps);
}

export function connectionRejectReason(
  steps: readonly FlowStep[],
  sourceId: string,
  targetId: string,
  sourceHandle?: string | null,
  targetHandle?: string | null,
): string | null {
  if (!sourceId || !targetId) {
    return null;
  }
  const handle = isBranchSourceHandle(sourceHandle) ? sourceHandle : 'out';
  const result = connectSteps(steps, sourceId, targetId, handle, targetHandle);
  return result.ok ? null : result.error;
}

/** 断线：只是不连了，下游变「未接入」，不会自动接上别的模块。 */
export function disconnectSteps(
  steps: readonly FlowStep[],
  edge: {
    readonly sourceId: string;
    readonly targetId?: string | null;
    readonly sourceHandle?: string | null;
  },
): StructureResult {
  return disconnectFlowSteps(steps, edge);
}

export function insertUnitBefore(
  steps: readonly FlowStep[],
  stepId: string,
  anchorId: string,
): StructureResult {
  const result = insertStepBeforeFlowStep(steps, stepId, anchorId);
  if (!result.ok) {
    return result;
  }
  return guard(steps, result.steps);
}

// --- 删除 ---

export function removeStepsFromChain(
  steps: readonly FlowStep[],
  ids: readonly string[],
): { steps: FlowStep[]; removed: ReadonlySet<string> } {
  const headId = steps[0]?.id ?? null;
  const removed = new Set(ids.filter((id) => id !== headId));
  const blocks = parseBlocks(steps);
  for (const id of [...removed]) {
    const step = steps.find((item) => item.id === id);
    if (!step || !(isBlockHead(step.type) || isBlockMark(step.type))) {
      continue;
    }
    const block = blocks.find((item) => item.headId === id || item.endId === id || item.elseId === id);
    if (block) {
      removed.add(block.headId);
      removed.add(block.endId);
      for (const branch of block.branches ?? []) removed.add(branch.markerId);
      if (block.elseId) {
        removed.add(block.elseId);
      }
    }
  }
  if (removed.size === 0) {
    return { steps: [...steps], removed };
  }

  const next: FlowStep[] = [];
  let carryPending = false;
  for (const step of steps) {
    if (removed.has(step.id)) {
      if (isFlowStepPendingLink(step)) {
        carryPending = true;
      }
      continue;
    }
    let kept = step;
    if (carryPending && !isFlowStepPendingLink(step)) {
      kept = { ...step, params: { ...step.params, _pendingLink: true } };
    }
    carryPending = false;
    next.push(kept);
  }
  // 删掉的模块身上的线一起消失（留到反正也会被规范化掉）
  const edges = flowEdges(steps).filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));
  return { steps: withFlowEdges(next, edges), removed };
}

/**
 * 删掉一个模块，但**保留它原来的缺口**：删除位置后面的第一个可见模块就地变成「未接入」，
 * 不会因为前后相邻而自动接上。条件 / 循环块请用普通删除（整块拆掉）。
 */
export function removeStepKeepingGap(steps: readonly FlowStep[], stepId: string): StructureResult {
  const index = indexOfId(steps, stepId);
  if (index < 0) {
    return fail('找不到要删除的模块');
  }
  if (index === 0) {
    return fail('不能删除触发器');
  }
  const step = steps[index]!;
  if (isBlockHead(step.type) || isBlockMark(step.type)) {
    return fail('条件 / 循环块请用普通删除');
  }
  // 只在本块 / 本分支范围内找下游：分支末尾删掉后缺口留在分支尾，
  // 不能把「否则」支或块外的模块标成未接入（否则会跳到另一条分支上）
  const block = parseBlocks(steps).find((item) => index > item.headIndex && index < item.endIndex);
  const branchLimit = block && block.elseIndex !== null && index < block.elseIndex ? block.elseIndex : null;
  const limit = branchLimit ?? (block ? block.endIndex : steps.length);
  const { steps: next, removed } = removeStepsFromChain(steps, [stepId]);
  let gapHeadId: string | null = null;
  for (let cursor = index + 1; cursor < limit; cursor += 1) {
    const candidate = steps[cursor]!;
    if (removed.has(candidate.id) || isHiddenFlowStep(candidate)) {
      continue;
    }
    gapHeadId = candidate.id;
    break;
  }
  if (gapHeadId === null) {
    return ok(next);
  }
  // 下游段头变成「未接入」：引擎到这里就结束，画布上也不会再画出上游→它的线
  return ok(next.map((item) => (item.id === gapHeadId ? withFlowPendingLink(item, true) : item)));
}
