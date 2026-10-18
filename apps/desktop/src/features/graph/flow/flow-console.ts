/**
 * 工作流「控制台」：执行日志过滤 + 步骤使用统计（纯函数，便于单测）。
 * 事件来自引擎 `engine.event`（`node` = 当时的步骤 id）。
 */
import type { FlowStep, TraceEventView } from '@/types';

export type ConsoleFilter = 'all' | 'step' | 'failed';

const RUN_PREFIXES = ['step_', 'flow_', 'cond_', 'loop_', 'action_', 'breakpoint'] as const;

/** 属于「执行日志」的事件（设备连接、录制识别器等不进控制台） */
export function isRunLogEvent(event: TraceEventView): boolean {
  const type = String(event.type);
  if (type === 'error') {
    return true;
  }
  return RUN_PREFIXES.some((prefix) => type.startsWith(prefix));
}

export function isFailedEvent(event: TraceEventView): boolean {
  const type = String(event.type);
  return type.includes('failed') || type === 'error';
}

export function filterConsoleEvents(
  events: readonly TraceEventView[],
  filter: ConsoleFilter,
  stepId: string | null,
): TraceEventView[] {
  const runEvents = events.filter(isRunLogEvent);
  if (filter === 'failed') {
    return runEvents.filter(isFailedEvent);
  }
  if (filter === 'step') {
    return stepId ? runEvents.filter((event) => event.node === stepId) : runEvents;
  }
  return runEvents;
}

export interface StepUsage {
  readonly stepId: string;
  readonly started: number;
  readonly finished: number;
  readonly failed: number;
  readonly skipped: number;
  /** 最近一次「开始→完成」耗时（毫秒），没有则 null */
  readonly lastDurationMs: number | null;
  readonly lastMessage: string;
  readonly lastTs: number | null;
}

function emptyUsage(stepId: string): StepUsage {
  return {
    stepId,
    started: 0,
    finished: 0,
    failed: 0,
    skipped: 0,
    lastDurationMs: null,
    lastMessage: '',
    lastTs: null,
  };
}

/** 最近一次运行里最后一个 step_failed 对应的步骤 id（供画布红框）。 */
export function lastFailedStepId(events: readonly TraceEventView[]): string | null {
  const slice = events.slice(lastRunStartIndex(events));
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    const event = slice[i];
    if (event?.type === 'step_failed' && event.node) {
      return event.node;
    }
  }
  return null;
}

/** 最近一次运行从哪个 event 开始（没有 flow_started 就从头） */
export function lastRunStartIndex(events: readonly TraceEventView[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'flow_started') {
      return i;
    }
  }
  return 0;
}

/** 按步骤汇总「本次运行」的使用情况（顺序 = flow.steps 顺序） */
export function collectStepUsage(events: readonly TraceEventView[], steps: readonly FlowStep[]): StepUsage[] {
  const slice = events.slice(lastRunStartIndex(events));
  const map = new Map<string, StepUsage>(steps.map((step) => [step.id, emptyUsage(step.id)]));
  const startedAt = new Map<string, number>();

  for (const event of slice) {
    const stepId = event.node;
    if (!stepId || !map.has(stepId)) {
      continue;
    }
    const usage = map.get(stepId)!;
    const type = event.type;
    let next = { ...usage, lastMessage: event.message, lastTs: event.ts };
    if (type === 'step_started') {
      next = { ...next, started: usage.started + 1 };
      startedAt.set(stepId, event.ts);
    } else if (type === 'step_finished') {
      const began = startedAt.get(stepId);
      // 引擎上报的耗时优先：事件 ts 是"收到事件的时间"，跨帧的等待会把误差放大
      const reported = event.extra?.['durationMs'];
      const duration =
        typeof reported === 'number'
          ? Math.max(0, Math.round(reported))
          : began !== undefined
            ? Math.max(0, Math.round((event.ts - began) * 1000))
            : null;
      next = {
        ...next,
        finished: usage.finished + 1,
        lastDurationMs: duration ?? usage.lastDurationMs,
      };
      startedAt.delete(stepId);
    } else if (type === 'step_failed') {
      next = { ...next, failed: usage.failed + 1 };
    } else if (type === 'step_skipped') {
      next = { ...next, skipped: usage.skipped + 1 };
    }
    map.set(stepId, next);
  }
  return steps.map((step) => map.get(step.id) ?? emptyUsage(step.id));
}

export function formatConsoleTime(ts: number): string {
  const date = new Date(ts * 1000);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export type ConsoleLevel = 'error' | 'warn' | 'info' | 'ok';

export function consoleLevel(event: TraceEventView): ConsoleLevel {
  const type = String(event.type);
  if (isFailedEvent(event)) {
    return 'error';
  }
  if (
    type === 'step_skipped' ||
    type === 'step_retry' ||
    type === 'breakpoint_hit' ||
    type.startsWith('step_error')
  ) {
    return 'warn';
  }
  if (type === 'step_finished' || type === 'flow_finished' || type === 'action_executed') {
    return 'ok';
  }
  return 'info';
}
