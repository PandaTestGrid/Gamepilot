import { describe, expect, it } from 'vitest';

import {
  collectStepUsage,
  consoleLevel,
  filterConsoleEvents,
  isRunLogEvent,
  lastFailedStepId,
} from '@/features/graph/flow/flow-console';
import type { FlowStep, TraceEventType, TraceEventView } from '@/types';

function ev(seq: number, type: string, node: string | null, message = '', ts = seq): TraceEventView {
  return { seq, ts, type: type as TraceEventType, deviceId: 'd', node, edge: null, message };
}

const steps: FlowStep[] = [
  { id: 't', type: 'manual', params: {} },
  { id: 'a', type: 'delay', params: { ms: 1 } },
];

describe('flow-console', () => {
  it('只保留执行类事件', () => {
    expect(isRunLogEvent(ev(1, 'step_started', 'a'))).toBe(true);
    expect(isRunLogEvent(ev(2, 'device_reconnected', null))).toBe(false);
    expect(isRunLogEvent(ev(3, 'error', null))).toBe(true);
  });

  it('lastFailedStepId 只认最近一次运行里的失败步', () => {
    const firstRun = [
      ev(1, 'flow_started', 't'),
      ev(2, 'step_failed', 'a'),
      ev(3, 'flow_started', 't'),
      ev(4, 'step_started', 'a'),
    ];
    expect(lastFailedStepId(firstRun)).toBeNull();
    expect(lastFailedStepId([...firstRun, ev(5, 'step_failed', 'a')])).toBe('a');
  });

  it('过滤：本模块 / 失败', () => {
    const events = [ev(1, 'step_started', 'a'), ev(2, 'step_started', 't'), ev(3, 'step_failed', 'a')];
    expect(filterConsoleEvents(events, 'step', 'a').map((e) => e.seq)).toEqual([1, 3]);
    expect(filterConsoleEvents(events, 'failed', 'a').map((e) => e.seq)).toEqual([3]);
    expect(filterConsoleEvents(events, 'all', null)).toHaveLength(3);
  });

  it('步骤使用只统计最近一次运行，并算耗时', () => {
    const events = [
      ev(1, 'flow_started', 't', '', 1),
      ev(2, 'step_started', 'a', '', 2),
      ev(3, 'step_finished', 'a', '', 3),
      ev(4, 'flow_started', 't', '', 10),
      ev(5, 'step_started', 'a', '', 11),
      ev(6, 'step_finished', 'a', 'ok', 11.5),
      ev(7, 'step_skipped', 't', '', 12),
    ];
    const usage = collectStepUsage(events, steps);
    const a = usage.find((item) => item.stepId === 'a');
    expect(a?.started).toBe(1);
    expect(a?.finished).toBe(1);
    expect(a?.lastDurationMs).toBe(500);
    expect(usage.find((item) => item.stepId === 't')?.skipped).toBe(1);
  });

  it('级别：失败红、跳过黄、完成绿', () => {
    expect(consoleLevel(ev(1, 'step_failed', 'a'))).toBe('error');
    expect(consoleLevel(ev(2, 'step_skipped', 'a'))).toBe('warn');
    expect(consoleLevel(ev(3, 'step_finished', 'a'))).toBe('ok');
    expect(consoleLevel(ev(4, 'step_started', 'a'))).toBe('info');
  });
});
