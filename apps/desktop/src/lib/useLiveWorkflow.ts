import { useMemo } from 'react';

import type { FlowRunRunner } from '@/lib/flow-run-attribution';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import { workflowRootInList, workflowRootKey } from '@/stores/ui.store';

/** 这份工作流目录是否有设备正在跑（切走 Tab 之后也算）。 */
export function useLiveWorkflow(root: string): boolean {
  const key = workflowRootKey(root);
  return useSessionStore((state) =>
    Object.values(state.runningWorkflowRoots).some((roots) =>
      roots.some((item) => workflowRootKey(item) === key),
    ),
  );
}

/** 当前打开的这份工作流是否有任意设备在跑（改图会冲掉执行指针）。 */
export function useCurrentWorkflowLive(): boolean {
  const root = useSessionStore((state) => state.currentWorkflow?.root ?? '');
  return useLiveWorkflow(root);
}

/** 当前设备上，当前这份工作流是否在跑。 */
export function useCurrentWorkflowRunning(): boolean {
  const activeId = useDeviceStore((state) => state.activeId);
  return useSessionStore((state) =>
    workflowRootInList(state.runningWorkflowRoots[activeId], state.currentWorkflow?.root ?? ''),
  );
}

/** 正在执行这份工作流的设备（名字用来标头部 / 标签，切走活动设备之后也要看得见）。 */
export function useRunningDevicesForWorkflow(root: string): readonly FlowRunRunner[] {
  const key = workflowRootKey(root);
  const devices = useDeviceStore((state) => state.devices);
  const runningWorkflowRoots = useSessionStore((state) => state.runningWorkflowRoots);
  return useMemo(() => {
    if (!key) {
      return [];
    }
    return devices
      .filter((device) =>
        (runningWorkflowRoots[device.id] ?? []).some((item) => workflowRootKey(item) === key),
      )
      .map((device) => ({ id: device.id, name: device.name }));
  }, [devices, key, runningWorkflowRoots]);
}
