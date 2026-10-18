/**
 * 详情坞「控制台」Tab：左侧执行日志，右侧步骤使用（参考 DevTools：主区 + 侧栏）。
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import {
  collectStepUsage,
  consoleLevel,
  filterConsoleEvents,
  formatConsoleTime,
  type ConsoleFilter,
  type ConsoleLevel,
} from '@/features/graph/flow/flow-console';
import { flowStepTitle } from '@/features/graph/flow/flow-step-meta';
import { RunBusySpinner } from '@/features/graph/flow/RunBusySpinner';
import { useRunBusy } from '@/lib/useRunBusy';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { useGraphStore } from '@/stores/graph.store';
import type { FlowStep } from '@/types';

const FILTERS: ReadonlyArray<{ id: ConsoleFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'step', label: '本模块' },
  { id: 'failed', label: '失败' },
];

const LEVEL_CLASS: Record<ConsoleLevel, string> = {
  error: 'border-l-failed bg-failed/5 text-failed',
  warn: 'border-l-pending bg-pending/5 text-pending',
  ok: 'border-l-confirmed text-fg',
  info: 'border-l-transparent text-dim',
};

const EMPTY_EVENTS: never[] = [];

export function FlowStepConsole({
  steps,
  selectedStepId,
}: {
  steps: readonly FlowStep[];
  selectedStepId: string | null;
}): ReactNode {
  const activeId = useDeviceStore((state) => state.activeId);
  const events = useEventStore((state) => state.events[activeId] ?? EMPTY_EVENTS);
  const clearDevice = useEventStore((state) => state.clearDevice);
  const { switching, showRunning } = useRunBusy();
  const selectNode = useGraphStore((state) => state.selectNode);
  const [filter, setFilter] = useState<ConsoleFilter>('all');
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const titleOf = useMemo(() => {
    const map = new Map(steps.map((step) => [step.id, flowStepTitle(step)]));
    return (id: string | null): string => (id ? (map.get(id) ?? id) : '—');
  }, [steps]);

  const visible = useMemo(
    () => filterConsoleEvents(events, filter, selectedStepId),
    [events, filter, selectedStepId],
  );
  const usage = useMemo(() => collectStepUsage(events, steps), [events, steps]);
  const touched = usage.filter((item) => item.started + item.skipped + item.failed > 0);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visible.length]);

  return (
    <div className="flex h-full min-h-0 flex-row overflow-hidden bg-panel" data-testid="flow-console">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-6 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 text-badge whitespace-nowrap">
          <button
            type="button"
            title="清空日志"
            className="shrink-0 rounded-sm px-1 text-dim hover:bg-raised hover:text-fg"
            onClick={() => activeId && clearDevice(activeId)}
          >
            清空
          </button>
          <span className="h-3 w-px shrink-0 bg-line" />
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={cn(
                'shrink-0 rounded-sm px-1.5',
                filter === item.id ? 'bg-active text-brand' : 'text-dim hover:bg-raised hover:text-fg',
              )}
            >
              {item.label}
            </button>
          ))}
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 pl-2 text-faint">
            {switching && showRunning ? <RunBusySpinner /> : null}
            {showRunning ? '运行中' : '空闲'} · {visible.length} 条
          </span>
        </div>

        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-[18px]"
          onScroll={(event) => {
            const el = event.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {visible.length === 0 ? (
            <div className="px-2 py-2 font-sans text-badge text-faint">
              {activeId ? '还没有执行日志：连接设备后点「运行」' : '先连接一台设备，再运行工作流'}
            </div>
          ) : (
            visible.map((event) => {
              const level = consoleLevel(event);
              return (
                <div
                  key={`${event.seq}-${event.type}`}
                  className={cn(
                    'flex items-baseline gap-1.5 border-b border-line/40 border-l-2 px-2 py-0.5 hover:bg-raised/60',
                    LEVEL_CLASS[level],
                  )}
                >
                  <span className="shrink-0 text-faint">{formatConsoleTime(event.ts)}</span>
                  <span
                    className="hidden w-20 shrink-0 truncate text-faint sm:inline"
                    title={String(event.type)}
                  >
                    {event.type}
                  </span>
                  <button
                    type="button"
                    title={event.node ?? ''}
                    className="max-w-[7rem] shrink-0 truncate text-left text-brand/80 hover:underline"
                    onClick={() => event.node && selectNode(event.node)}
                  >
                    {titleOf(event.node)}
                  </button>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{event.message}</span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <aside className="flex w-44 shrink-0 flex-col border-l border-line sm:w-52">
        <div className="flex h-6 shrink-0 items-center truncate border-b border-line px-2 text-badge text-dim">
          步骤使用 · 最近一次运行
        </div>
        <div className="min-h-0 flex-1 overflow-auto text-[11px]">
          {touched.length === 0 ? (
            <div className="px-2 py-2 text-badge text-faint">运行后这里显示每个模块的次数 / 失败 / 耗时</div>
          ) : (
            touched.map((item) => {
              const selected = item.stepId === selectedStepId;
              return (
                <button
                  key={item.stepId}
                  type="button"
                  onClick={() => selectNode(item.stepId)}
                  className={cn(
                    'block w-full border-b border-line/40 px-2 py-1 text-left hover:bg-raised/60',
                    selected && 'bg-active',
                  )}
                >
                  <div className="truncate text-fg">{titleOf(item.stepId)}</div>
                  <div className="flex flex-wrap gap-x-2 text-faint">
                    <span>执行 {item.started}</span>
                    <span>完成 {item.finished}</span>
                    {item.failed > 0 ? <span className="text-failed">失败 {item.failed}</span> : null}
                    {item.skipped > 0 ? <span className="text-pending">跳过 {item.skipped}</span> : null}
                    {item.lastDurationMs !== null ? <span>{item.lastDurationMs}ms</span> : null}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}
