/**
 * 画布上不展示的步骤：块边界标记，以及曾经误插入的隐藏「跳出循环」。
 */
import type { FlowStep } from '@/types';

export function isImplicitLoopbreak(step: FlowStep | undefined): boolean {
  return step?.type === 'loopbreak' && step.params?._implicit === true;
}

export function isHiddenFlowMark(type: string): boolean {
  return type === 'else' || type === 'condend' || type === 'loopend';
}

export function isHiddenFlowStep(step: FlowStep): boolean {
  return isHiddenFlowMark(step.type) || isImplicitLoopbreak(step);
}
