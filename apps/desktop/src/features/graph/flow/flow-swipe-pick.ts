import { type SwipeTrack } from '@/features/device/touch-gesture';
import { clampUnitCoord } from '@/features/graph/flow/flow-coord-utils';
import { useEventStore } from '@/stores/event.store';
import { WORKFLOW_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useUiStore } from '@/stores/ui.store';

/**
 * 画面栏拖出滑动后写入滑动步骤的起止坐标、时长、（可选）轨迹与末端按住。
 *
 * 重录成一条直线时必须**清掉**旧的 `path`：否则回放还在走上一把的弧线。
 */
export async function commitSwipePick(
  deviceId: string,
  stepId: string,
  rawX: number,
  rawY: number,
  rawToX: number,
  rawToY: number,
  durationMs: number,
  track?: SwipeTrack,
): Promise<void> {
  const x = clampUnitCoord(rawX);
  const y = clampUnitCoord(rawY);
  const to_x = clampUnitCoord(rawToX);
  const to_y = clampUnitCoord(rawToY);
  const duration_ms = Math.min(1500, Math.max(50, Math.round(durationMs)));
  const path =
    track && track.path.length >= 3
      ? track.path.map(([px, py]): [number, number] => [
          Number(clampUnitCoord(px).toFixed(4)),
          Number(clampUnitCoord(py).toFixed(4)),
        ])
      : undefined;
  const hold_ms = track && track.holdMs > 0 ? Math.min(5000, Math.round(track.holdMs)) : undefined;

  const steps = useGraphStore.getState().graphs[WORKFLOW_SCOPE]?.flow?.steps ?? [];
  const targetStep = steps.find((step) => step.id === stepId);
  if (!targetStep || targetStep.type !== 'swipe') {
    useUiStore.getState().clearPendingFlowSwipeStep();
    return;
  }
  const nextParams: Record<string, unknown> = {
    ...(targetStep.params ?? {}),
    x,
    y,
    to_x,
    to_y,
    duration_ms,
    path,
    hold_ms,
  };
  await useGraphStore.getState().updateFlowStep(stepId, { params: nextParams });
  useGraphStore.getState().selectNode(stepId);
  useUiStore.getState().clearPendingFlowSwipeStep();
  const shape = path ? ` · 连续 ${path.length} 点` : '';
  const hold = hold_ms ? ` · 按住 ${hold_ms}ms` : '';
  useEventStore.getState().append(deviceId, 'action_executed', {
    message: `已设置滑动 (${x.toFixed(2)}, ${y.toFixed(2)}) → (${to_x.toFixed(2)}, ${to_y.toFixed(2)}) ${duration_ms}ms${shape}${hold}`,
  });
}
