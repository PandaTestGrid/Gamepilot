/** 画布端口：与引擎线性结构一致，分支用多 source handle 表达 */

export type FlowSourceHandleId = 'out' | 'then' | 'else' | 'body';

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
  return PORTS_BY_TYPE[type] ?? DEFAULT_SOURCES;
}

export function isBranchSourceHandle(handle: string | null | undefined): handle is FlowSourceHandleId {
  return handle === 'out' || handle === 'then' || handle === 'else' || handle === 'body';
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
