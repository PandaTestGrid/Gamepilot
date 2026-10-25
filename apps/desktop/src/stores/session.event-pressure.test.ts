import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toGraphData } from '@/lib/graph-adapter';
import { useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { WORKFLOW_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';

const handlers = vi.hoisted(
  () => [] as Array<(event: { payload: { method: string; params: Record<string, unknown> } }) => void>,
);
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({ running: false })) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_name: string, handler: (typeof handlers)[number]) => {
    handlers.push(handler);
    return Promise.resolve(() => {
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    });
  }),
}));
const ID = 'pressure-device';
const ROOT = 'S:/pressure';
function event(seq: number, type = 'step_started', current = 1) {
  return {
    deviceId: ID,
    workflowRoot: ROOT,
    seq,
    ts: seq / 600,
    type,
    node: seq % 2 ? 'a' : 'b',
    edge: null,
    message: 'pressure',
    extra: { loops: [{ stepId: 'loop', current, total: 100 }] },
  };
}
function notify(method: string, params: Record<string, unknown>) {
  handlers.at(-1)?.({ payload: { method, params } });
}
let unlisten: () => void;
beforeEach(async () => {
  vi.useFakeTimers();
  useSessionStore.getState().resetForEngineRestart();
  useDeviceStore.setState({ devices: [], activeId: ID });
  useSessionStore.setState({
    currentWorkflow: {
      root: ROOT,
      graphPath: `${ROOT}/graph.json`,
      nodes: 0,
      edges: 0,
      recognizers: 0,
      templates: 0,
    },
    paused: {},
  });
  useEventStore.setState({ events: {}, seq: 0 });
  const graph = toGraphData(ID, {
    version: 1,
    defaults: {},
    recognizers: {},
    nodes: [],
    edges: [],
    flow: { steps: [] },
  });
  useGraphStore.setState({ graphs: { [WORKFLOW_SCOPE]: graph, [ID]: graph }, liveByDevice: {} });
  unlisten = await useSessionStore.getState().init();
});
afterEach(() => {
  unlisten();
  useSessionStore.getState().resetForEngineRestart();
  vi.useRealTimers();
});

describe('高频执行事件合并', () => {
  it('600普通事件只发布一次日志/loop/graph，保留最近500的完整顺序', () => {
    let logs = 0,
      loops = 0,
      graphs = 0;
    const off = [
      useEventStore.subscribe(() => {
        logs++;
      }),
      useSessionStore.subscribe(() => {
        loops++;
      }),
      useGraphStore.subscribe(() => {
        graphs++;
      }),
    ];
    for (let i = 1; i <= 600; i++)
      notify(
        'engine.event',
        event(
          i,
          i % 3 === 0 ? 'step_finished' : i % 3 === 1 ? 'step_started' : 'action_executed',
          Math.ceil(i / 6),
        ),
      );
    expect(logs).toBe(0);
    vi.advanceTimersByTime(50);
    off.forEach((dispose) => dispose());
    expect({ logs, loops, graphs }).toEqual({ logs: 1, loops: 1, graphs: 1 });
    expect(useEventStore.getState().events[ID]?.map((item) => item.seq)).toEqual(
      Array.from({ length: 500 }, (_, i) => i + 101),
    );
    expect(useSessionStore.getState().loopProgress[ID]?.loop?.current).toBe(100);
  });

  it('10ms循环100轮600事件在1秒内最多20次发布，不按事件扇出', () => {
    let publications = 0;
    const off = useEventStore.subscribe(() => {
      publications++;
    });
    for (let iteration = 0; iteration < 100; iteration++) {
      for (let step = 0; step < 6; step++)
        notify('engine.event', event(iteration * 6 + step + 1, 'step_started', iteration + 1));
      vi.advanceTimersByTime(10);
    }
    off();
    expect(publications).toBe(20);
    expect(useEventStore.getState().events[ID]).toHaveLength(500);
  });

  it('engine.events立即一次提交，同值loop对象与graph复用', () => {
    notify('engine.events', { events: [event(1), event(2)] });
    const progress = useSessionStore.getState().loopProgress[ID];
    const graph = useGraphStore.getState().graphs[ID];
    notify('engine.events', { events: [event(3), event(4)] });
    expect(useSessionStore.getState().loopProgress[ID]).toBe(progress);
    expect(useGraphStore.getState().graphs[ID]).toBe(graph);
    expect(useEventStore.getState().events[ID]).toHaveLength(4);
  });

  it.each(['breakpoint_hit', 'flow_finished', 'step_failed', 'error'])(
    '%s即时flush前序普通事件且保持顺序',
    (critical) => {
      notify('engine.event', event(1));
      notify('engine.event', event(2, critical));
      expect(useEventStore.getState().events[ID]?.map((item) => item.seq)).toEqual([1, 2]);
      if (critical === 'breakpoint_hit') expect(useSessionStore.getState().paused[ID]).toBe('b');
      if (critical === 'flow_finished') expect(useSessionStore.getState().loopProgress[ID]).toEqual({});
      vi.advanceTimersByTime(50);
      expect(useEventStore.getState().events[ID]).toHaveLength(2);
    },
  );

  it('run.stopped即时清loops，旧普通timer不能复活；stopRun也不等待timer', async () => {
    notify('engine.event', event(1));
    notify('run.stopped', { deviceId: ID, workflowRoot: ROOT });
    expect(useSessionStore.getState().running[ID]).toBe(false);
    expect(useSessionStore.getState().loopProgress[ID]).toEqual({});
    vi.advanceTimersByTime(50);
    expect(useSessionStore.getState().loopProgress[ID]).toEqual({});
    notify('engine.event', event(2));
    await useSessionStore.getState().stopRun(ID);
    expect(useEventStore.getState().events[ID]).toHaveLength(2);
    expect(useSessionStore.getState().running[ID]).toBe(false);
  });

  it('reset和unlisten丢弃旧视觉队列，不覆盖新session', () => {
    notify('engine.event', event(1));
    useSessionStore.getState().resetForEngineRestart();
    vi.advanceTimersByTime(50);
    expect(useEventStore.getState().events[ID]).toBeUndefined();
    notify('engine.event', event(2));
    unlisten();
    vi.advanceTimersByTime(50);
    expect(useGraphStore.getState().liveByDevice[ID]).toBeUndefined();
  });

  it('store批量去重跨同批及历史并保留同步单事件API', () => {
    const first = event(1) as Parameters<ReturnType<typeof useEventStore.getState>['appendEngineEvent']>[0];
    useEventStore.getState().appendEngineEvent(first);
    expect(useEventStore.getState().events[ID]).toHaveLength(1);
    useEventStore.getState().appendEngineEvents([first, first, { ...first, seq: 2 }]);
    expect(useEventStore.getState().events[ID]?.map((item) => item.seq)).toEqual([1, 2]);
  });
});
