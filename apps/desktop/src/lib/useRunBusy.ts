import { useCurrentWorkflowRunning } from '@/lib/useLiveWorkflow';
import { useSessionStore } from '@/stores/session.store';

/**
 * 当前 Tab 的运行态。切到另一份正在跑的工作流时，交接期间仍按「运行中」画，
 * 避免图还没接上执行器时闪成已停止。
 */
export function useRunBusy(): {
  readonly running: boolean;
  readonly switching: boolean;
  readonly showRunning: boolean;
} {
  const running = useCurrentWorkflowRunning();
  const switching = useSessionStore((state) => state.switchingWorkflow);
  const held = useSessionStore((state) => state.holdRunningDuringSwitch);
  return {
    running,
    switching,
    showRunning: running || (switching && held),
  };
}
