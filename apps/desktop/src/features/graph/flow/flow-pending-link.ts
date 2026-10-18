import type { FlowStep } from '@/types';

const FLOW_PENDING_LINK_PARAM = '_pendingLink';

/** 老画布记下的「用户亲手画的线」（`${源步骤}:${源出口}`）。现在只用于迁移老文件时冻结连线。 */
const FLOW_IN_LINKS_PARAM = '_in';

export function isFlowStepPendingLink(step: FlowStep | undefined): boolean {
  return step?.params?.[FLOW_PENDING_LINK_PARAM] === true;
}

export function withFlowPendingLink(step: FlowStep, pending = true): FlowStep {
  return {
    ...step,
    params: { ...step.params, [FLOW_PENDING_LINK_PARAM]: pending },
  };
}

function inLinkKey(sourceId: string, handle: string): string {
  return `${sourceId}:${handle}`;
}

export function flowStepInLinks(step: FlowStep | undefined): string[] {
  const raw = step?.params?.[FLOW_IN_LINKS_PARAM];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

/** 老文件里这条线是用户亲手画的吗（迁移老画布时判断该不该冻结这条续接线）。 */
export function hasFlowInLink(step: FlowStep | undefined, sourceId: string, handle: string): boolean {
  return flowStepInLinks(step).includes(inLinkKey(sourceId, handle));
}
