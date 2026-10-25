/** 画布端口：与引擎线性结构一致，分支用多 source handle 表达 */

import type { FlowStep } from '@/types';

export type FlowSourceHandleId =
  'out' | 'then' | 'else' | 'body' | 'branch1' | 'branch2' | 'branch3' | 'branch4';

export function parallelBranchCount(step: Pick<FlowStep, 'params'>): number {
  return Math.min(4, Math.max(2, Math.floor(Number(step.params?.branches) || 2)));
}

export type FlowTargetHandleId = 'in' | 'back';

export interface FlowSourcePort {
  readonly id: FlowSourceHandleId;
  readonly label: string;
  /** 右侧多出口时的垂直位置（%） */
  readonly topPercent: number;
  /** 默认在右侧；循环的「进入」在底部 */
  readonly side?: 'right' | 'bottom';
  /** 默认：右侧且有多个出口时显示标签 */
  readonly showLabel?: boolean;
}

const DEFAULT_SOURCES: readonly FlowSourcePort[] = [{ id: 'out', label: '下一步', topPercent: 50 }];

const PORTS_BY_TYPE: Readonly<Record<string, readonly FlowSourcePort[]>> = {
  cond: [
    { id: 'then', label: '成立', topPercent: 32 },
    { id: 'else', label: '不成立', topPercent: 68 },
  ],
  loop: [
    { id: 'out', label: '循环结束后的下一步', topPercent: 50, showLabel: false },
    { id: 'body', label: '进入循环体', topPercent: 50, side: 'bottom', showLabel: false },
  ],
  loopbreak: [],
  // 「结束」= 这一支直接结束：没有出口，画布上不画任何下行线
  end: [],
};

export function sourcePortsForStepType(type: string): readonly FlowSourcePort[] {
  return sourcePortsForStep({ type });
}

export function sourcePortsForStep(step: Pick<FlowStep, 'type' | 'params'>): readonly FlowSourcePort[] {
  if (step.type === 'parallel') {
    const count = parallelBranchCount(step);
    return [
      { id: 'out', label: '汇合后下一步', topPercent: 12 },
      ...Array.from({ length: count }, (_, i) => ({
        id: `branch${i + 1}` as FlowSourceHandleId,
        label: `分支 ${i + 1}`,
        topPercent: 30 + (i * 60) / Math.max(1, count - 1),
      })),
    ];
  }
  return PORTS_BY_TYPE[step.type] ?? DEFAULT_SOURCES;
}

export function isBranchSourceHandle(handle: string | null | undefined): handle is FlowSourceHandleId {
  return (
    handle === 'out' ||
    handle === 'then' ||
    handle === 'else' ||
    handle === 'body' ||
    /^branch[1-4]$/.test(handle ?? '')
  );
}

export function normalizeTargetHandle(
  targetType: string,
  handle: string | null | undefined,
): FlowTargetHandleId {
  if (targetType === 'loop' && handle === 'back') {
    return 'back';
  }
  return 'in';
}
