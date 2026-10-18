/**
 * 线性步骤链的最底层结构原语：块解析、结构校验。
 *
 * 单独成文件是为了让 `flow-edge-model`（画布连线的真源）也能用，
 * 又不至于和 `flow-structure`（连线 / 删除等操作）互相 import 成环。
 * 对外仍然从 `flow-structure` 再导出，老的引用路径不用改。
 */
import { coerceStr } from '@/lib/coerce';

import { isHiddenFlowMark } from '@/features/graph/flow/flow-hidden';
import { isFlowStepPendingLink } from '@/features/graph/flow/flow-pending-link';
import { isKnownFlowStepType, isTriggerType } from '@/features/graph/flow/flow-step-meta';
import type { FlowSourceHandleId } from '@/features/graph/flow/flow-step-ports';
import type { FlowStep } from '@/types';

export type BlockKind = 'cond' | 'loop';

export function isBlockHead(type: string): boolean {
  return type === 'cond' || type === 'loop';
}

export function isBlockMark(type: string): boolean {
  return isHiddenFlowMark(type);
}

export interface BlockSpan {
  readonly kind: BlockKind;
  readonly headId: string;
  readonly headIndex: number;
  readonly endIndex: number;
  readonly endId: string;
  readonly elseIndex: number | null;
  readonly elseId: string | null;
}

export function parseBlocks(steps: readonly FlowStep[]): BlockSpan[] {
  const blocks: BlockSpan[] = [];
  const open: { kind: BlockKind; index: number; elseIndex: number | null }[] = [];
  steps.forEach((step, index) => {
    if (step.type === 'cond' || step.type === 'loop') {
      open.push({ kind: step.type, index, elseIndex: null });
      return;
    }
    if (step.type === 'else') {
      const top = open.at(-1);
      if (top?.kind === 'cond' && top.elseIndex === null) {
        top.elseIndex = index;
      }
      return;
    }
    if (step.type === 'condend' || step.type === 'loopend') {
      const back = coerceStr(step.params?.back).trim();
      const top = open.at(-1);
      if (!top || steps[top.index]!.id !== back) {
        return;
      }
      open.pop();
      blocks.push({
        kind: top.kind,
        headId: steps[top.index]!.id,
        headIndex: top.index,
        endIndex: index,
        endId: step.id,
        elseIndex: top.kind === 'cond' ? top.elseIndex : null,
        elseId: top.elseIndex !== null ? steps[top.elseIndex]!.id : null,
      });
    }
  });
  return blocks;
}

export function blockOfStep(steps: readonly FlowStep[], stepId: string): BlockSpan | null {
  return (
    parseBlocks(steps).find(
      (block) => block.headId === stepId || block.endId === stepId || block.elseId === stepId,
    ) ?? null
  );
}

export type StructureResult =
  { readonly ok: true; readonly steps: FlowStep[] } | { readonly ok: false; readonly error: string };

export function structureFail(error: string): StructureResult {
  return { ok: false, error };
}

export function structureOk(steps: FlowStep[]): StructureResult {
  return { ok: true, steps };
}

export function validateFlowSteps(steps: readonly FlowStep[]): string | null {
  const seen = new Set<string>();
  const frames: { kind: BlockKind; id: string }[] = [];
  const condHasElse = new Set<string>();
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    if (!step.id) {
      return `第 ${index + 1} 步缺少 id`;
    }
    if (seen.has(step.id)) {
      return `步骤 id 重复: ${step.id}`;
    }
    seen.add(step.id);
    if (index === 0 && !isTriggerType(step.type)) {
      return '第一步必须是触发器（手动 / 定时 / 每隔一段）';
    }
    if (step.disabled && isBlockMark(step.type)) {
      return `第 ${index + 1} 步是块的标记，不能停用`;
    }
    if (!isKnownFlowStepType(step.type)) {
      return `第 ${index + 1} 步的类型不认识: ${step.type}`;
    }
    const back = coerceStr(step.params?.back).trim();
    if (step.type === 'cond' || step.type === 'loop') {
      frames.push({ kind: step.type, id: step.id });
    } else if (step.type === 'else') {
      const top = frames.at(-1);
      if (top?.kind !== 'cond') {
        return '「否则」只能放在「条件」块里';
      }
      if (condHasElse.has(top.id)) {
        return '这个「条件」已经有「否则」了';
      }
      condHasElse.add(top.id);
    } else if (step.type === 'condend') {
      const top = frames.at(-1);
      if (!top || top.kind !== 'cond' || top.id !== back) {
        return '「条件结束」只能关掉最近那个还没结束的「条件」';
      }
      frames.pop();
    } else if (step.type === 'loopend') {
      const top = frames.at(-1);
      if (!top || top.kind !== 'loop' || top.id !== back) {
        return '「循环结束」只能关掉最近那个还没结束的「循环」';
      }
      frames.pop();
    } else if (step.type === 'loopbreak' && !isFlowStepPendingLink(step)) {
      if (!frames.some((frame) => frame.kind === 'loop')) {
        return '「跳出循环」必须写在「循环」和「循环结束」之间';
      }
      if (back && !frames.some((frame) => frame.kind === 'loop' && frame.id === back)) {
        return '「跳出循环」的 back 必须指向当前仍打开的某个「循环」';
      }
    }
  }
  if (frames.length > 0) {
    const top = frames.at(-1)!;
    return top.kind === 'cond' ? '有「条件」没有对应的「条件结束」' : '有「循环」没有对应的「循环结束」';
  }
  return null;
}

export function condLoopRepeat(step: FlowStep | undefined): 'then' | 'else' | null {
  const value = step?.params?._loopRepeat;
  return value === 'then' || value === 'else' ? value : null;
}

/** 步骤默认从哪个出口接下一步：条件接「成立」支，循环接「循环体」。 */
export function defaultSourceHandle(type: string): FlowSourceHandleId {
  if (type === 'cond') {
    return 'then';
  }
  if (type === 'loop') {
    return 'body';
  }
  return 'out';
}
