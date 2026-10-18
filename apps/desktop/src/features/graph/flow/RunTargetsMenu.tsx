/**
 * 一份脚本正在哪些设备上跑：点设备名跳转，右侧可直接停。
 */
import { ChevronDown } from 'lucide-react';
import { type ReactNode } from 'react';

import type { FlowRunRunner } from '@/lib/flow-run-attribution';
import { jumpToDeviceAndWorkflow } from '@/lib/jump-to-run';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session.store';

export function RunTargetList({
  workflowRoot,
  runners,
}: {
  workflowRoot: string;
  runners: readonly FlowRunRunner[];
}): ReactNode {
  const stopRun = useSessionStore((state) => state.stopRun);
  return (
    <div data-testid="run-target-list">
      {runners.map((runner) => (
        <div
          key={runner.id}
          data-testid={`run-target-${runner.id}`}
          className="flex h-[26px] min-w-0 items-center gap-1 px-2 text-badge hover:bg-raised"
        >
          <button
            type="button"
            title={`跳转到 ${runner.name}`}
            className="min-w-0 flex-1 truncate text-left text-fg"
            onClick={() => jumpToDeviceAndWorkflow(runner.id, workflowRoot)}
          >
            {runner.name}
          </button>
          <button
            type="button"
            data-testid={`run-target-stop-${runner.id}`}
            className="shrink-0 rounded-sm px-1.5 py-0.5 text-failed hover:bg-panel"
            onClick={() => void stopRun(runner.id, workflowRoot)}
          >
            停止
          </button>
        </div>
      ))}
    </div>
  );
}

export function runTargetsTriggerLabel(runners: readonly FlowRunRunner[]): string {
  if (runners.length === 1) {
    return runners[0]?.name ?? '运行中';
  }
  if (runners.length > 1) {
    return `${runners.length} 台在跑`;
  }
  return '运行中';
}

/** 工作区列表右侧：点开把正在跑的设备折下来。 */
export function RunTargetsTrigger({
  runners,
  open,
  onToggle,
}: {
  runners: readonly FlowRunRunner[];
  open: boolean;
  onToggle: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      data-testid="workflow-run-toggle"
      title={open ? '收起正在跑的设备' : '展开：点设备跳转或直接停止'}
      className="inline-flex max-w-[6.5rem] shrink-0 items-center gap-0.5 text-brand"
      onClick={onToggle}
    >
      <span className="truncate">{runTargetsTriggerLabel(runners)}</span>
      <ChevronDown className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')} />
    </button>
  );
}
