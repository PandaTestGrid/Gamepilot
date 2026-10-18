import { CLICK_BY_COORD } from '@/features/graph/flow/flow-click-params';
import { screenAspectFromResolution } from '@/features/graph/flow/flow-click-region';
import { clampUnitCoord } from '@/features/graph/flow/flow-coord-utils';
import { useEventStore } from '@/stores/event.store';
import { WORKFLOW_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

/** 画面栏点选完成后写入点击步骤的归一化坐标 */
export async function commitClickCoordPick(
  deviceId: string,
  stepId: string,
  rawX: number,
  rawY: number,
): Promise<void> {
  const x = clampUnitCoord(rawX);
  const y = clampUnitCoord(rawY);
  const frame = useSessionStore.getState().frames[deviceId];
  const screenAspect = screenAspectFromResolution(frame?.resolution);
  const steps = useGraphStore.getState().graphs[WORKFLOW_SCOPE]?.flow?.steps ?? [];
  const targetStep = steps.find((step) => step.id === stepId);
  if (!targetStep) {
    useUiStore.getState().clearPendingFlowClickCoordStep();
    return;
  }
  const nextParams: Record<string, unknown> = {
    ...(targetStep.params ?? {}),
    by: CLICK_BY_COORD,
    rec: '',
    x,
    y,
    screenAspect,
  };
  delete nextParams.rect;
  delete nextParams.preview;
  await useGraphStore.getState().updateFlowStep(stepId, { params: nextParams });
  useGraphStore.getState().selectNode(stepId);
  useUiStore.getState().clearPendingFlowClickCoordStep();
  useUiStore.getState().setRecordMode('off');
  useEventStore.getState().append(deviceId, 'action_executed', {
    message: `已设置点击坐标 ${x.toFixed(2)}, ${y.toFixed(2)}`,
  });
}
