import {
  CLICK_BY_REGION,
  normalizeClickRegionRect,
  screenAspectFromResolution,
  type NormRect,
} from '@/features/graph/flow/flow-click-region';
import { useEventStore } from '@/stores/event.store';
import { WORKFLOW_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

/** 画面栏框选完成后写入点击步骤的随机范围 */
export async function commitClickRegionPick(
  deviceId: string,
  stepId: string,
  rawRect: readonly [number, number, number, number],
): Promise<void> {
  const rect: NormRect = normalizeClickRegionRect(rawRect);
  const frame = useSessionStore.getState().frames[deviceId];
  const screenAspect = screenAspectFromResolution(frame?.resolution);
  const steps = useGraphStore.getState().graphs[WORKFLOW_SCOPE]?.flow?.steps ?? [];
  const targetStep = steps.find((step) => step.id === stepId);
  if (!targetStep) {
    useUiStore.getState().clearPendingFlowClickRegionStep();
    return;
  }
  const nextParams: Record<string, unknown> = {
    ...(targetStep.params ?? {}),
    by: CLICK_BY_REGION,
    rec: '',
    rect: [...rect],
    screenAspect,
  };
  delete nextParams.preview;
  delete nextParams.x;
  delete nextParams.y;
  await useGraphStore.getState().updateFlowStep(stepId, { params: nextParams });
  useGraphStore.getState().selectNode(stepId);
  useUiStore.getState().clearPendingFlowClickRegionStep();
  useUiStore.getState().setRecordMode('off');
  useEventStore.getState().append(deviceId, 'action_executed', {
    message: `已设置随机点击范围 ${rect[2].toFixed(2)}×${rect[3].toFixed(2)}`,
  });
}
