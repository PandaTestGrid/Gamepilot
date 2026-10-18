/**
 * 画布左下：空闲时显示连线说明；运行中显示当前步与事件。
 */
import { type ReactNode } from 'react';

import { RunBusySpinner } from '@/features/graph/flow/RunBusySpinner';
import { useFlowRunStatus } from '@/features/graph/flow/use-flow-run-status';

const CONNECT_HINT =
  '连线：拖出口到入口 · 点出口再点入口 · 选中连线 Delete 断开 · 选中模块 Delete 删除 · Shift 框选 · Ctrl+Z 撤销';

export function FlowRunStrip({ readOnly = false }: { readOnly?: boolean }): ReactNode {
  const { connected, switching, showRunning, statusLabel, stepLabel, eventLine } = useFlowRunStatus();
  const showRun = !readOnly && connected && showRunning;

  return (
    <div
      data-testid="flow-run-strip"
      className="pointer-events-none absolute bottom-2 left-2 max-w-[80%] px-1 text-badge"
    >
      {readOnly ? (
        <span className="text-faint">只读快照 · 点上方标题切换到此工作流</span>
      ) : showRun ? (
        <span className="inline-flex min-w-0 items-center gap-1 truncate">
          {switching ? <RunBusySpinner className="text-brand" /> : null}
          <span className="text-brand">{statusLabel}</span>
          {stepLabel ? <span className="text-dim"> · 当前步 · {stepLabel}</span> : null}
          {eventLine ? <span className="text-faint"> · {eventLine}</span> : null}
        </span>
      ) : (
        <span className="text-faint">{CONNECT_HINT}</span>
      )}
    </div>
  );
}
