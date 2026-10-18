import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import { workflowRootKey } from '@/stores/ui.store';

/** 切到这台设备（已经是当前设备时不动）。 */
export function jumpToDevice(deviceId: string): void {
  if (!deviceId || useDeviceStore.getState().activeId === deviceId) {
    return;
  }
  useDeviceStore.getState().setActive(deviceId);
}

/**
 * 跳到「这台设备 + 这份脚本」：多开时从工作区 / 标签点运行中的那一行用。
 */
export function jumpToDeviceAndWorkflow(deviceId: string, workflowRoot: string): void {
  jumpToDevice(deviceId);
  const current = useSessionStore.getState().currentWorkflow?.root ?? '';
  if (!workflowRoot || workflowRootKey(current) === workflowRootKey(workflowRoot)) {
    return;
  }
  void useSessionStore.getState().switchWorkflow(workflowRoot);
}
