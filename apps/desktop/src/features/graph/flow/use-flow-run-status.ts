import { useMemo } from 'react';

import { flowStepTitle } from '@/features/graph/flow/flow-step-meta';
import { useRunBusy } from '@/lib/useRunBusy';
import { activeDevice, useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { graphForDevice, useGraphStore } from '@/stores/graph.store';

const RUN_TYPES = new Set([
  'flow_started',
  'step_started',
  'step_finished',
  'step_skipped',
  'step_failed',
  'flow_finished',
  'breakpoint_hit',
]);

export function useFlowRunStatus(): {
  readonly connected: boolean;
  readonly running: boolean;
  readonly switching: boolean;
  readonly showRunning: boolean;
  readonly statusLabel: string;
  readonly stepLabel: string | null;
  readonly eventLine: string;
} {
  const activeId = useDeviceStore((state) => state.activeId);
  const devices = useDeviceStore((state) => state.devices);
  const { running, switching, showRunning } = useRunBusy();
  const graph = useGraphStore((state) => graphForDevice(state, activeId));
  const liveNode = useGraphStore((state) => state.liveByDevice[activeId]?.node ?? null);
  const events = useEventStore((state) => state.events[activeId]);

  const lastRunEvent = useMemo(() => {
    const list = events ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i];
      if (item && RUN_TYPES.has(item.type)) {
        return item;
      }
    }
    return null;
  }, [events]);

  const device = activeDevice(devices, activeId);
  const connected = Boolean(activeId && device?.status === 'connected');
  const steps = graph?.flow?.steps ?? [];
  const currentStep = steps.find((step) => step.id === liveNode) ?? null;
  const stepLabel = currentStep ? flowStepTitle(currentStep) : liveNode ? liveNode : null;

  return {
    connected,
    running,
    switching,
    showRunning,
    statusLabel: showRunning ? (device?.name ? `${device.name} · 运行中` : '运行中') : '已停止',
    stepLabel,
    eventLine: lastRunEvent?.message ?? '',
  };
}
