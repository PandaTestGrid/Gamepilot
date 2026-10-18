/**
 * 画布连线的真源。
 *
 * 每条线都存在源步骤的 `params._out` 里（`'<出口>><目标 id>'`，例如 `'then>abc123'`），
 * 画布只画这里存在的线：连一条加一条，删一条就断，不再按数组顺序补线，也不搬节点。
 *
 * 引擎仍然只吃线性的 `flow.steps`，所以每次改完线都要把图重新线性化（`linearizeFlow`）：
 * 触发器 → 出边深度优先；条件块 `cond ... else ... condend`；循环块 `loop ... loopend`。
 * 从触发器走不到的模块会排到数组末尾并标 `_pendingLink`，引擎走到它就停（和其它未接入模块一致）。
 */
import { coerceStr } from '@/lib/coerce';

import { isHiddenFlowMark } from '@/features/graph/flow/flow-hidden';
import {
  hasFlowInLink,
  isFlowStepPendingLink,
  withFlowPendingLink,
} from '@/features/graph/flow/flow-pending-link';
import {
  condLoopRepeat,
  defaultSourceHandle,
  isBlockMark,
  parseBlocks,
  structureFail,
  structureOk,
  validateFlowSteps,
  type BlockSpan,
  type StructureResult,
} from '@/features/graph/flow/flow-structure-core';
import { isTriggerType, newStepId } from '@/features/graph/flow/flow-step-meta';
import {
  isBranchSourceHandle,
  normalizeTargetHandle,
  sourcePortsForStepType,
  type FlowSourceHandleId,
} from '@/features/graph/flow/flow-step-ports';
import type { FlowStep } from '@/types';

/** 画布上的一条线：从哪个步骤的哪个出口，到哪个步骤。 */
export interface FlowEdge {
  readonly source: string;
  readonly sourceHandle: FlowSourceHandleId;
  readonly target: string;
}

/** 连线的持久化参数名：不要改，老文件靠有没有它来判断是否已经迁到显式连线。 */
const FLOW_OUT_PARAM = '_out';

/** 写 `_out` 时固定按这个顺序，保证同一张图存出来的参数完全一样（幂等）。 */
const HANDLE_ORDER: readonly FlowSourceHandleId[] = ['out', 'then', 'else', 'body'];

export type { StructureResult } from '@/features/graph/flow/flow-structure-core';

function entriesOfStep(step: FlowStep): { handle: FlowSourceHandleId; target: string }[] {
  const raw = step.params?.[FLOW_OUT_PARAM];
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: { handle: FlowSourceHandleId; target: string }[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      continue;
    }
    const at = item.indexOf('>');
    if (at <= 0) {
      continue;
    }
    const handle = item.slice(0, at);
    const target = item.slice(at + 1).trim();
    if (!target || !isBranchSourceHandle(handle)) {
      continue;
    }
    entries.push({ handle, target });
  }
  return entries;
}

/** 这张图是不是已经用显式连线存过了（完全没有 `_out` = 老文件）。 */
export function hasExplicitFlowEdges(steps: readonly FlowStep[]): boolean {
  return steps.some((step) => Array.isArray(step.params?.[FLOW_OUT_PARAM]));
}

/**
 * 整理连线：丢掉失效的、重复的、接到块标记上的，一个出口只留第一条。
 * 读和写都过这一道，保证画布、存储、线性化看到的是同一份图。
 */
function sanitizeFlowEdges(steps: readonly FlowStep[], edges: readonly FlowEdge[]): FlowEdge[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const usedHandles = new Set<string>();
  const result: FlowEdge[] = [];
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || edge.source === edge.target) {
      continue;
    }
    if (isBlockMark(source.type) || isBlockMark(target.type)) {
      continue;
    }
    const handle = isBranchSourceHandle(edge.sourceHandle) ? edge.sourceHandle : 'out';
    if (!sourcePortsForStepType(source.type).some((port) => port.id === handle)) {
      continue;
    }
    const key = `${edge.source}|${handle}`;
    if (usedHandles.has(key)) {
      continue;
    }
    usedHandles.add(key);
    result.push({ source: edge.source, sourceHandle: handle, target: edge.target });
  }
  return result;
}

/** 读出全部连线：有 `_out` 就按 `_out`；老文件退回按数组推导（和以前画得一模一样）。 */
export function flowEdges(steps: readonly FlowStep[]): FlowEdge[] {
  if (!hasExplicitFlowEdges(steps)) {
    return sanitizeFlowEdges(steps, legacyFlowEdges(steps));
  }
  const raw: FlowEdge[] = [];
  for (const step of steps) {
    for (const entry of entriesOfStep(step)) {
      raw.push({ source: step.id, sourceHandle: entry.handle, target: entry.target });
    }
  }
  return sanitizeFlowEdges(steps, raw);
}

/** 把连线写回 `_out`（每个步骤都写，没有出线就是空数组）：显式模式从此固定下来。 */
export function withFlowEdges(steps: readonly FlowStep[], edges: readonly FlowEdge[]): FlowStep[] {
  const bySource = new Map<string, Map<FlowSourceHandleId, string>>();
  for (const edge of sanitizeFlowEdges(steps, edges)) {
    let handles = bySource.get(edge.source);
    if (!handles) {
      handles = new Map();
      bySource.set(edge.source, handles);
    }
    handles.set(edge.sourceHandle, edge.target);
  }
  return steps.map((step) => {
    const handles = bySource.get(step.id);
    const entries = handles
      ? HANDLE_ORDER.filter((handle) => handles.has(handle)).map(
          (handle) => `${handle}>${handles.get(handle)!}`,
        )
      : [];
    const current = entriesOfStep(step);
    // 没写过 `_out` 的步骤一定要写上（哪怕是空数组）：否则"一条线都没有"时又会退回老推导，
    // 画布立刻自己补线回来。
    const unchanged =
      Object.prototype.hasOwnProperty.call(step.params ?? {}, FLOW_OUT_PARAM) &&
      current.length === entries.length &&
      current.every((entry, index) => `${entry.handle}>${entry.target}` === entries[index]);
    if (unchanged) {
      return step;
    }
    return { ...step, params: { ...step.params, [FLOW_OUT_PARAM]: entries } };
  });
}

// ---------------------------------------------------------------------------
// 老的推导（只在没有 `_out` 的老文件、以及迁移时用一次）
// ---------------------------------------------------------------------------

function lastContentInRange(steps: readonly FlowStep[], from: number, to: number): FlowStep | undefined {
  for (let i = to - 1; i >= from; i -= 1) {
    const step = steps[i];
    if (!step || isHiddenFlowMark(step.type) || step.type === 'loopbreak' || isFlowStepPendingLink(step)) {
      continue;
    }
    return step;
  }
  return undefined;
}

function loopHeadOf(steps: readonly FlowStep[], loopend: FlowStep): FlowStep | undefined {
  const back = coerceStr(loopend.params?.back);
  return steps.find((step) => step.id === back && step.type === 'loop');
}

/**
 * 块结束之后接到哪：可见下一步，或所在循环头（再循环）。
 *
 * 遇到 `else` 必须整段跳过「否则」支（跳到配对的 condend 之后），不能把它当透明标记继续往后扫：
 * 走到 `else` 说明这是外层条件「成立」支的末尾，再往后都是外层的「否则」支，
 * 它们不是这一支的后续。
 */
function continueAfter(
  steps: readonly FlowStep[],
  fromIndex: number,
): { target: FlowStep; backToLoop: boolean } | null {
  const elseEndById = new Map<number, number>();
  for (const block of parseBlocks(steps)) {
    if (block.kind === 'cond' && block.elseIndex !== null) {
      elseEndById.set(block.elseIndex, block.endIndex);
    }
  }
  for (let i = fromIndex; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.type === 'loopend') {
      const head = loopHeadOf(steps, step);
      return head ? { target: head, backToLoop: true } : null;
    }
    if (step.type === 'else') {
      const endIndex = elseEndById.get(i);
      if (endIndex === undefined) {
        continue;
      }
      // 整段「否则」支跳过：它是外层条件另一条支，不属于当前这一支的后续
      i = endIndex;
      continue;
    }
    if (step.type === 'condend') {
      continue;
    }
    if (isFlowStepPendingLink(step)) {
      return null;
    }
    return { target: step, backToLoop: false };
  }
  return null;
}

/** 老画布推导出来的全部连线（含按顺序补出来的线和循环回线）。只在迁移 / 老文件渲染时用。 */
export function legacyFlowEdges(steps: readonly FlowStep[]): FlowEdge[] {
  const edges = new Map<string, FlowEdge>();
  const add = (source: FlowStep, sourceHandle: FlowSourceHandleId, target: FlowStep): void => {
    edges.set(`${source.id}|${sourceHandle}|${target.id}`, {
      source: source.id,
      sourceHandle,
      target: target.id,
    });
  };

  const addLoopEdges = (block: BlockSpan): void => {
    const head = steps[block.headIndex]!;
    const end = steps[block.endIndex]!;
    const bodyFirst = block.headIndex + 1 < block.endIndex ? steps[block.headIndex + 1] : undefined;
    const bodyLast = block.headIndex + 1 < block.endIndex ? steps[block.endIndex - 1] : undefined;
    if (bodyFirst && !isFlowStepPendingLink(bodyFirst)) {
      add(head, 'body', bodyFirst);
    }
    if (
      bodyFirst &&
      bodyLast &&
      !isFlowStepPendingLink(bodyFirst) &&
      !isHiddenFlowMark(bodyLast.type) &&
      bodyLast.type !== 'loopbreak' &&
      bodyLast.type !== 'end' &&
      bodyLast.id !== end.id &&
      !isFlowStepPendingLink(bodyLast) &&
      !isFlowStepPendingLink(head)
    ) {
      add(bodyLast, 'out', head);
    }
    const afterLoop = continueAfter(steps, block.endIndex + 1);
    if (afterLoop && !afterLoop.backToLoop) {
      add(head, 'out', afterLoop.target);
    }
  };

  const addCondEdges = (block: BlockSpan): void => {
    const head = steps[block.headIndex]!;
    const afterBlock = continueAfter(steps, block.endIndex + 1);
    const thenRepeats = condLoopRepeat(head) !== 'else';
    const elseRepeats = condLoopRepeat(head) !== 'then';
    const thenStart = block.headIndex + 1;
    const thenStop = block.elseIndex ?? block.endIndex;
    const thenFirst = thenStart < thenStop ? steps[thenStart] : undefined;
    const thenLast = lastContentInRange(steps, thenStart, thenStop);
    /** 画布只画用户亲手画的那条汇合线：块后那一步要从某一支接上去过，才画那一条。 */
    const addContinue = (source: FlowStep, handle: FlowSourceHandleId, repeats: boolean): void => {
      if (!afterBlock || !repeats) {
        return;
      }
      if (!afterBlock.backToLoop && !hasFlowInLink(afterBlock.target, source.id, handle)) {
        return;
      }
      add(source, handle, afterBlock.target);
    };
    if (thenFirst && thenFirst.type !== 'loopbreak' && !isFlowStepPendingLink(thenFirst)) {
      add(head, 'then', thenFirst);
    } else if (!thenFirst) {
      addContinue(head, 'then', thenRepeats);
    }
    if (thenLast && thenLast.type !== 'end' && !isFlowStepPendingLink(thenLast)) {
      addContinue(thenLast, 'out', thenRepeats);
    }
    if (block.elseIndex !== null) {
      const elseFirst = block.elseIndex + 1 < block.endIndex ? steps[block.elseIndex + 1] : undefined;
      const elseLast = lastContentInRange(steps, block.elseIndex + 1, block.endIndex);
      if (elseFirst && elseFirst.type !== 'loopbreak' && !isFlowStepPendingLink(elseFirst)) {
        add(head, 'else', elseFirst);
      } else if (!elseFirst) {
        addContinue(head, 'else', elseRepeats);
      }
      if (elseLast && elseLast.type !== 'end' && !isFlowStepPendingLink(elseLast)) {
        addContinue(elseLast, 'out', elseRepeats && elseLast.type !== 'loopbreak');
      }
    } else if (elseRepeats && (thenFirst || afterBlock?.backToLoop)) {
      addContinue(head, 'else', true);
    }
  };

  for (const block of parseBlocks(steps)) {
    if (block.kind === 'loop') {
      addLoopEdges(block);
      continue;
    }
    addCondEdges(block);
  }

  const skipSequential = (from: FlowStep, to: FlowStep): boolean =>
    from.type === 'end' ||
    from.type === 'cond' ||
    from.type === 'loop' ||
    from.type === 'loopbreak' ||
    from.type === 'else' ||
    from.type === 'condend' ||
    from.type === 'loopend' ||
    to.type === 'else' ||
    to.type === 'condend' ||
    to.type === 'loopend';

  for (let i = 0; i < steps.length - 1; i += 1) {
    const from = steps[i]!;
    const to = steps[i + 1]!;
    if (isFlowStepPendingLink(to) || skipSequential(from, to)) {
      continue;
    }
    add(from, 'out', to);
  }

  return [...edges.values()];
}

// ---------------------------------------------------------------------------
// 线性化：图 → 引擎要的 steps 数组
// ---------------------------------------------------------------------------

class LinearizeError extends Error {}

interface BranchContext {
  readonly condId: string;
  readonly handle: 'then' | 'else';
}

interface EmitContext {
  readonly byId: ReadonlyMap<string, FlowStep>;
  readonly out: ReadonlyMap<string, ReadonlyMap<FlowSourceHandleId, string>>;
  readonly incoming: ReadonlyMap<string, readonly string[]>;
  readonly merges: ReadonlySet<string>;
  readonly blocks: readonly BlockSpan[];
  readonly emitted: Set<string>;
  readonly active: string[];
  readonly loopStack: string[];
  readonly repeats: Map<string, { handle: 'then' | 'else'; loopId: string }>;
  /** 原数组里块头后面那一步：只作为"块结束后接着谁"的线索。 */
  readonly stepsAfterBlock: ReadonlyMap<string, string>;
}

function targetOf(ctx: EmitContext, stepId: string, handle: FlowSourceHandleId): string | null {
  return ctx.out.get(stepId)?.get(handle) ?? null;
}

/** 清掉"接线用的临时参数"：显式连线之后 `_pendingLink` / `_in` 由图重新决定。 */
function cleanStep(step: FlowStep): FlowStep {
  const params = { ...step.params };
  delete params._pendingLink;
  delete params._in;
  delete params._loopRepeat;
  delete params._loopRepeatLoop;
  return { ...step, params };
}

function stepLabel(step: FlowStep): string {
  return step.type;
}

function commitMark(ctx: EmitContext, step: FlowStep): FlowStep {
  ctx.emitted.add(step.id);
  return cleanStep(step);
}

/** 块标记（否则 / 条件结束 / 循环结束）：优先复用数组里原来那个 id，避免无谓地换 id。 */
function takeMark(
  ctx: EmitContext,
  head: FlowStep,
  kind: 'else' | 'condend' | 'loopend',
  block: BlockSpan | undefined,
): FlowStep {
  const existingId = kind === 'else' ? block?.elseId : block?.endId;
  const existing = existingId ? ctx.byId.get(existingId) : undefined;
  if (existing && existing.type === kind) {
    return commitMark(ctx, existing);
  }
  const fresh: FlowStep = {
    id: newStepId(),
    type: kind,
    ...(kind === 'else' ? {} : { params: { back: head.id } }),
  };
  ctx.emitted.add(fresh.id);
  return fresh;
}

/** 原数组里这个块后面的那一步：只作为"块结束后接着谁"的线索，不画线。 */
function afterStepOfBlock(ctx: EmitContext, block: BlockSpan | undefined): string | null {
  return block ? (ctx.stepsAfterBlock.get(block.headId) ?? null) : null;
}

function emitChain(
  ctx: EmitContext,
  startId: string,
  stopIds: ReadonlySet<string>,
  branch: BranchContext | null,
): { steps: FlowStep[]; stopId: string | null } {
  const produced: FlowStep[] = [];
  let current: string | null = startId;
  while (current) {
    const id = current;
    if (ctx.loopStack.includes(id)) {
      if (branch) {
        // 条件某一支的末尾接回循环头 = 这一支走完再循环一次（引擎用 _loopRepeat 表达）
        ctx.repeats.set(branch.condId, { handle: branch.handle, loopId: id });
        return { steps: produced, stopId: null };
      }
      if (id !== ctx.loopStack.at(-1)) {
        throw new LinearizeError('内层循环体不能直接接回外层循环');
      }
      // 循环体末尾接回自己的循环头 = 循环正常的回线
      return { steps: produced, stopId: id };
    }
    if (stopIds.has(id)) {
      return { steps: produced, stopId: id };
    }
    const step = ctx.byId.get(id);
    if (!step) {
      return { steps: produced, stopId: null };
    }
    if (ctx.active.includes(id)) {
      throw new LinearizeError(`模块连成了环（${stepLabel(step)}）`);
    }
    if (ctx.emitted.has(id)) {
      throw new LinearizeError('一个模块被两条线同时接上：只有「条件 / 循环」结束后的下一步可以两路汇合');
    }
    const piece = emitStep(ctx, step);
    produced.push(...piece.steps);
    current = piece.afterId;
  }
  return { steps: produced, stopId: null };
}

function emitStep(ctx: EmitContext, step: FlowStep): { steps: FlowStep[]; afterId: string | null } {
  ctx.active.push(step.id);
  ctx.emitted.add(step.id);
  try {
    if (step.type === 'cond') {
      return emitCond(ctx, step);
    }
    if (step.type === 'loop') {
      return emitLoop(ctx, step);
    }
    const afterId = step.type === 'end' || step.type === 'loopbreak' ? null : targetOf(ctx, step.id, 'out');
    return { steps: [cleanStep(step)], afterId };
  } finally {
    ctx.active.pop();
  }
}

/** 两条（或多条）支流停在不同地方 = 画布表达的先后顺序不唯一，不支持。 */
function pickAfter(id: string | null, other: string | null): string | null {
  if (id && other && id !== other) {
    throw new LinearizeError('两条分支接到了不同的下一步：先让它们接到同一个步骤上');
  }
  return id ?? other;
}

function startBranchChain(
  ctx: EmitContext,
  startId: string | null,
  stopIds: ReadonlySet<string>,
  branch: BranchContext,
): { steps: FlowStep[]; stopId: string | null } {
  if (!startId) {
    return { steps: [], stopId: null };
  }
  // 这一支直接接回循环头 = 这条支走完再循环一次（支是空的也算）
  if (ctx.loopStack.includes(startId)) {
    if (startId !== ctx.loopStack.at(-1)) {
      throw new LinearizeError('内层循环体不能直接接回外层循环');
    }
    ctx.repeats.set(branch.condId, { handle: branch.handle, loopId: startId });
    return { steps: [], stopId: null };
  }
  // 一上来就是汇合点 / 块后那一步：这一支是空的，只是画了一条通向块后的线
  if (stopIds.has(startId) || ctx.merges.has(startId)) {
    return { steps: [], stopId: startId };
  }
  return emitChain(ctx, startId, stopIds, branch);
}

function emitCond(ctx: EmitContext, cond: FlowStep): { steps: FlowStep[]; afterId: string | null } {
  const block = ctx.blocks.find((item) => item.kind === 'cond' && item.headId === cond.id);
  // 数组里紧跟在块后的那一步只是"顺序残留"，不是结构；它要是正好是某一支的入口，
  // 就更不能当成汇合点，否则两支会被判成"接到了不同的下一步"。
  const guess = afterStepOfBlock(ctx, block);
  const hint =
    guess === targetOf(ctx, cond.id, 'then') || guess === targetOf(ctx, cond.id, 'else') ? null : guess;
  const stopIds = new Set<string>(ctx.merges);
  if (hint) {
    stopIds.add(hint);
  }
  const thenChain = startBranchChain(ctx, targetOf(ctx, cond.id, 'then'), stopIds, {
    condId: cond.id,
    handle: 'then',
  });
  const elseChain = startBranchChain(ctx, targetOf(ctx, cond.id, 'else'), stopIds, {
    condId: cond.id,
    handle: 'else',
  });
  const afterInBranch = pickAfter(thenChain.stopId, elseChain.stopId);
  // 只认图上真实存在的回线：删掉回线就真的不再循环（参数不自己作主）
  const repeat = ctx.repeats.get(cond.id) ?? null;
  const repeatHandle = repeat?.handle ?? null;
  const repeatLoopId = repeat?.loopId ?? null;
  const condStep: FlowStep = (() => {
    const base = cleanStep(cond);
    if (!repeatHandle) {
      return base;
    }
    return {
      ...base,
      params: {
        ...base.params,
        _loopRepeat: repeatHandle,
        ...(repeatLoopId ? { _loopRepeatLoop: repeatLoopId } : {}),
      },
    };
  })();
  const needElseMark = elseChain.steps.length > 0 || Boolean(block?.elseId);
  const steps: FlowStep[] = [condStep, ...thenChain.steps];
  if (needElseMark) {
    steps.push(takeMark(ctx, cond, 'else', block));
  }
  steps.push(...elseChain.steps, takeMark(ctx, cond, 'condend', block));
  // 显式连线模型：块后面接谁只看真实出线，不靠"数组里它正好排在后面"
  return { steps, afterId: afterInBranch };
}

function emitLoop(ctx: EmitContext, loop: FlowStep): { steps: FlowStep[]; afterId: string | null } {
  const block = ctx.blocks.find((item) => item.kind === 'loop' && item.headId === loop.id);
  const bodyStart = targetOf(ctx, loop.id, 'body');
  const afterStart = targetOf(ctx, loop.id, 'out');
  const guess = afterStepOfBlock(ctx, block);
  const hint = guess === bodyStart || guess === afterStart ? null : guess;
  const bodyStops = new Set<string>(ctx.merges);
  if (afterStart) {
    bodyStops.add(afterStart);
  }
  ctx.loopStack.push(loop.id);
  let body: { steps: FlowStep[]; stopId: string | null };
  try {
    body = bodyStart ? emitChain(ctx, bodyStart, bodyStops, null) : { steps: [], stopId: null };
  } finally {
    ctx.loopStack.pop();
  }
  if (body.stopId && body.stopId !== loop.id && body.stopId !== afterStart && body.stopId !== hint) {
    throw new LinearizeError('循环体不能接进别处的汇合点');
  }
  const steps: FlowStep[] = [cleanStep(loop), ...body.steps, takeMark(ctx, loop, 'loopend', block)];
  return { steps, afterId: afterStart };
}

function buildOutMap(
  steps: readonly FlowStep[],
  edges: readonly FlowEdge[],
): Map<string, Map<FlowSourceHandleId, string>> {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const out = new Map<string, Map<FlowSourceHandleId, string>>();
  for (const edge of sanitizeFlowEdges(steps, edges)) {
    if (!byId.has(edge.source)) {
      continue;
    }
    let handles = out.get(edge.source);
    if (!handles) {
      handles = new Map();
      out.set(edge.source, handles);
    }
    handles.set(edge.sourceHandle, edge.target);
  }
  return out;
}

/** 图 → 线性 steps。接不了就返回中文原因（调用方原样提示，steps 保持不变）。 */
export function linearizeFlow(steps: readonly FlowStep[], edges: readonly FlowEdge[]): StructureResult {
  if (steps.length === 0) {
    return structureOk([]);
  }
  const trigger = steps[0]!;
  if (!isTriggerType(trigger.type)) {
    return structureFail('第一步必须是触发器（手动 / 定时 / 每隔一段）');
  }
  try {
    const out = buildOutMap(steps, edges);
    // 「接回循环开头」的线：从循环体里的模块连回循环头 = 循环自己的回线，不是环
    const loopReturn = new Set<string>();
    for (const step of steps) {
      if (step.type !== 'loop') {
        continue;
      }
      const body = out.get(step.id)?.get('body');
      if (!body) {
        continue;
      }
      const inBody = new Set<string>();
      const stack = [body];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (id === step.id || inBody.has(id)) {
          continue;
        }
        inBody.add(id);
        for (const next of out.get(id)?.values() ?? []) {
          stack.push(next);
        }
      }
      for (const [source, handles] of out) {
        for (const target of handles.values()) {
          if (target === step.id && inBody.has(source)) {
            loopReturn.add(`${source}>${step.id}`);
          }
        }
      }
    }
    const isLoopReturn = (source: string, target: string): boolean => loopReturn.has(`${source}>${target}`);
    const incoming = new Map<string, string[]>();
    for (const [source, handles] of out) {
      for (const target of handles.values()) {
        // 回线不算"另一条入线"，否则循环头会被当成汇合点
        if (isLoopReturn(source, target)) {
          continue;
        }
        const list = incoming.get(target) ?? [];
        list.push(source);
        incoming.set(target, list);
      }
    }
    // 环：除了接回循环头的回线，任何"往回连"都会形成死循环
    const state = new Map<string, 'in' | 'done'>();
    const byId = new Map(steps.map((step) => [step.id, step]));
    const walk = (id: string): string | null => {
      const mark = state.get(id);
      if (mark === 'in') {
        return `模块连成了环（${byId.get(id)?.type ?? '模块'}）：把线接回前面的模块会形成死循环`;
      }
      if (mark === 'done') {
        return null;
      }
      state.set(id, 'in');
      for (const target of out.get(id)?.values() ?? []) {
        if (isLoopReturn(id, target)) {
          continue;
        }
        const problem = walk(target);
        if (problem) {
          return problem;
        }
      }
      state.set(id, 'done');
      return null;
    };
    for (const step of steps) {
      const problem = walk(step.id);
      if (problem) {
        return structureFail(problem);
      }
    }
    const merges = new Set<string>();
    for (const [target, sources] of incoming) {
      if (new Set(sources).size >= 2) {
        merges.add(target);
      }
    }
    const afterByHead = new Map<string, string>();
    const blocks = parseBlocks(steps);
    for (const block of blocks) {
      const next = steps[block.endIndex + 1];
      if (next && !isBlockMark(next.type)) {
        afterByHead.set(block.headId, next.id);
      }
    }
    const ctx: EmitContext = {
      byId: new Map(steps.map((step) => [step.id, step])),
      out,
      incoming,
      merges,
      blocks,
      emitted: new Set<string>(),
      active: [],
      loopStack: [],
      repeats: new Map(),
      stepsAfterBlock: afterByHead,
    };
    const main = emitChain(ctx, trigger.id, new Set<string>(), null);
    // 块标记即便没被复用也要算"已经排掉"，不能当成失联模块堆到末尾
    for (const block of blocks) {
      if (ctx.emitted.has(block.headId)) {
        if (block.elseId) {
          ctx.emitted.add(block.elseId);
        }
        ctx.emitted.add(block.endId);
      }
    }
    const ordered = [...main.steps];
    // 没接进主链的模块堆到末尾。块头（条件 / 循环）要按块展开，否则「循环体」会散在
    // 循环结束标记后面：画布上看着没接进去，接回循环头的线也会被判定成「不在循环体里」。
    let firstTail = true;
    const appendTail = (piece: readonly FlowStep[]): void => {
      if (piece.length === 0) {
        return;
      }
      const [head, ...rest] = piece as [FlowStep, ...FlowStep[]];
      ordered.push(firstTail ? withFlowPendingLink(head) : head, ...rest);
      firstTail = false;
    };
    for (const step of steps) {
      if (ctx.emitted.has(step.id)) {
        continue;
      }
      if (step.type === 'cond' || step.type === 'loop') {
        try {
          appendTail(emitStep(ctx, step).steps);
          continue;
        } catch {
          // 展开不了（比如循环体还被别处占着）就按普通模块堆到末尾
        }
      }
      if (ctx.emitted.has(step.id)) {
        continue;
      }
      appendTail([cleanStep(step)]);
    }
    const problem = validateFlowSteps(ordered);
    if (problem) {
      return structureFail(problem);
    }
    return structureOk(withFlowEdges(ordered, edges));
  } catch (error) {
    if (error instanceof LinearizeError) {
      return structureFail(error.message);
    }
    throw error;
  }
}

/** 线性化 + 结构校验：连线的写操作统一走这里。 */
function applyEdges(steps: readonly FlowStep[], edges: readonly FlowEdge[]): StructureResult {
  return linearizeFlow(steps, edges);
}

// ---------------------------------------------------------------------------
// 写操作：连线 / 断线 / 插到某个模块前面
// ---------------------------------------------------------------------------

function rejectConnect(
  steps: readonly FlowStep[],
  sourceId: string,
  targetId: string,
  sourceHandle: FlowSourceHandleId,
): string | null {
  if (sourceId === targetId) {
    return '不能把模块连到它自己';
  }
  const byId = new Map(steps.map((step) => [step.id, step]));
  const source = byId.get(sourceId);
  const target = byId.get(targetId);
  if (!source || !target) {
    return '找不到要连接的模块';
  }
  if (isTriggerType(target.type)) {
    return '触发器是链的起点，不能作为连线终点';
  }
  if (source.type === 'end') {
    return '「结束」没有出口：它到此为止，后面不用也不能再接步骤';
  }
  if (source.type === 'loopbreak') {
    return '「跳出循环」没有出口：它会直接跳到循环后面';
  }
  if (isBlockMark(source.type) || isBlockMark(target.type)) {
    return '这是「条件 / 循环」的结构标记，不能直接连线';
  }
  if (!sourcePortsForStepType(source.type).some((port) => port.id === sourceHandle)) {
    return '这个出口不属于该模块';
  }
  return null;
}

/** 接回循环头：只有"循环体里某个条件的某一支末尾"能这么连（= 这一支走完再来一遍）。 */
/**
 * 「接回循环开头」的线：从条件某一支的最后一步拉回去 = 这一支走完再循环一次
 * （引擎用 `_loopRepeat` 表达）。不是条件分支的情况返回 null，按普通连线处理
 * （循环体末尾 → 循环头 = 循环正常的回线）。
 */
function connectLoopRepeat(
  initialSteps: readonly FlowStep[],
  sourceId: string,
  sourceHandle: FlowSourceHandleId,
  loopId: string,
  initialEdges: readonly FlowEdge[],
): StructureResult | null {
  // 先按现有连线把结构摆正：还没接进主链的循环，它的循环体可能还原样堆在循环后面，
  // 这时按数组下标判断会误判成「不在循环体里」。摆正之后再判断。
  let steps = initialSteps;
  let edges = initialEdges;
  const normalized = linearizeFlow(initialSteps, initialEdges);
  if (normalized.ok) {
    steps = normalized.steps;
    edges = flowEdges(normalized.steps);
  }
  const byId = new Map(steps.map((step) => [step.id, step]));
  const loop = byId.get(loopId);
  if (!loop || loop.type !== 'loop') {
    return structureFail('只能接回外层的循环');
  }
  const sourceIndex = steps.findIndex((step) => step.id === sourceId);
  const blocks = parseBlocks(steps);
  const loopBlock = blocks.find((block) => block.kind === 'loop' && block.headId === loopId);
  if (!loopBlock || sourceIndex <= loopBlock.headIndex || sourceIndex >= loopBlock.endIndex) {
    return structureFail(
      '接回循环头要从循环体里的最后一步拉线：先把循环的「进入」口连到循环体的第一步，再把这支的末尾接回循环头',
    );
  }
  const condBlock = blocks.find(
    (block) =>
      block.kind === 'cond' &&
      block.headIndex > loopBlock.headIndex &&
      block.endIndex < loopBlock.endIndex &&
      sourceIndex >= block.headIndex &&
      sourceIndex < block.endIndex,
  );
  if (!condBlock) {
    return null;
  }
  // 从条件自己身上拉线时，看拉的是哪个出口；从分支里的模块拉线时看它在哪一支
  const inElse =
    sourceId === condBlock.headId
      ? sourceHandle === 'else'
      : condBlock.elseIndex !== null && sourceIndex > condBlock.elseIndex;
  const branchEnd = inElse ? condBlock.endIndex : (condBlock.elseIndex ?? condBlock.endIndex);
  const branchStart = inElse ? (condBlock.elseIndex ?? condBlock.endIndex) + 1 : condBlock.headIndex + 1;
  const branchTail = lastContentInRange(steps, branchStart, branchEnd);
  if (branchTail && branchTail.id !== sourceId) {
    return structureFail('接回循环的线要从这一支的最后一步拉出来');
  }
  if (!branchTail && sourceId !== condBlock.headId) {
    return structureFail('只有「条件」的某一支能接回循环开头');
  }
  // 一个条件只能有一支再循环：先把这一支/那一支原有的回线清掉
  const drop = new Set<string>();
  for (let i = condBlock.headIndex; i <= condBlock.endIndex; i += 1) {
    const step = steps[i];
    if (!step) {
      continue;
    }
    const nested = blocks.some(
      (block) =>
        block.headIndex > condBlock.headIndex &&
        block.endIndex < condBlock.endIndex &&
        i > block.headIndex &&
        i < block.endIndex,
    );
    if (!nested) {
      drop.add(step.id);
    }
  }
  const next: FlowEdge[] = [
    ...edges.filter(
      (edge) =>
        !(edge.target === loopId && drop.has(edge.source)) &&
        !(edge.source === sourceId && edge.sourceHandle === sourceHandle),
    ),
    { source: sourceId, sourceHandle, target: loopId },
  ];
  return applyEdges(steps, next);
}

export function connectFlowSteps(
  steps: readonly FlowStep[],
  sourceId: string,
  targetId: string,
  sourceHandle: string | null | undefined,
  targetHandle?: string | null,
): StructureResult {
  const handle: FlowSourceHandleId = isBranchSourceHandle(sourceHandle) ? sourceHandle : 'out';
  const reject = rejectConnect(steps, sourceId, targetId, handle);
  if (reject) {
    return structureFail(reject);
  }
  const target = steps.find((step) => step.id === targetId)!;
  const edges = flowEdges(steps);
  const toBack = normalizeTargetHandle(target.type, targetHandle) === 'back';
  // 入口可以合流（多条线接同一个模块），但同一个模块不能用自己的两个出口接同一步：
  // 新线落下时，把"同一个来源、同一个目标"的旧线换掉（例如循环的「下一步」换成「进入」）。
  const base = edges.filter(
    (edge) => !(edge.source === sourceId && (edge.sourceHandle === handle || edge.target === targetId)),
  );
  if (toBack) {
    const repeat = connectLoopRepeat(steps, sourceId, handle, targetId, base);
    if (repeat) {
      return repeat;
    }
  }
  const added: FlowEdge[] = [...base, { source: sourceId, sourceHandle: handle, target: targetId }];
  return applyEdges(steps, added);
}

/** 断开一条线：只是不连了，下游变成「未接入」，绝不自动接上别的。 */
export function disconnectFlowSteps(
  steps: readonly FlowStep[],
  edge: {
    readonly sourceId: string;
    readonly targetId?: string | null;
    readonly sourceHandle?: string | null;
  },
): StructureResult {
  const handle: FlowSourceHandleId = isBranchSourceHandle(edge.sourceHandle) ? edge.sourceHandle : 'out';
  const edges = flowEdges(steps);
  const remaining = edges.filter(
    (item) =>
      !(
        item.source === edge.sourceId &&
        item.sourceHandle === handle &&
        (!edge.targetId || item.target === edge.targetId)
      ),
  );
  if (remaining.length === edges.length) {
    return structureOk([...steps]);
  }
  return applyEdges(steps, remaining);
}

/** 把已有模块插到某个模块前面：原来接向它的线改接新模块，新模块再接到它。 */
export function insertStepBeforeFlowStep(
  steps: readonly FlowStep[],
  stepId: string,
  anchorId: string,
): StructureResult {
  if (stepId === anchorId) {
    return structureFail('不能把模块连到它自己');
  }
  const byId = new Map(steps.map((step) => [step.id, step]));
  const step = byId.get(stepId);
  const anchor = byId.get(anchorId);
  if (!step || !anchor) {
    return structureFail('找不到要连接的模块');
  }
  if (isTriggerType(anchor.type)) {
    return structureFail('触发器之前不能再插入模块');
  }
  if (isBlockMark(step.type) || isBlockMark(anchor.type)) {
    return structureFail('这是「条件 / 循环」的结构标记，不能直接连线');
  }
  const handle = defaultSourceHandle(step.type);
  const edges = flowEdges(steps)
    .filter((edge) => edge.target !== stepId)
    .map((edge) => (edge.target === anchorId ? { ...edge, target: stepId } : edge));
  const next: FlowEdge[] = [
    ...edges.filter((edge) => !(edge.source === stepId && edge.sourceHandle === handle)),
    { source: stepId, sourceHandle: handle, target: anchorId },
  ];
  return applyEdges(steps, next);
}

/** 当前接到某个步骤上的入线（画布/测试用来判断"未连线"）。 */
export function flowIncomingEdges(steps: readonly FlowStep[]): Map<string, FlowEdge[]> {
  const result = new Map<string, FlowEdge[]>();
  for (const edge of flowEdges(steps)) {
    const list = result.get(edge.target) ?? [];
    list.push(edge);
    result.set(edge.target, list);
  }
  return result;
}
