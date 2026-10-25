import { invoke } from '@tauri-apps/api/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';

const handlers = vi.hoisted(
  () => [] as Array<(event: { payload: { method: string; params: Record<string, unknown> } }) => void>,
);
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    (
      _name: string,
      handler: (event: { payload: { method: string; params: Record<string, unknown> } }) => void,
    ) => {
      handlers.push(handler);
      return Promise.resolve(() => {
        handlers.length = 0;
      });
    },
  ),
}));

const ID = 'android:run-race';
const ROOT = 'S:/flows/ai';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function notify(method: string, root: string | undefined = ROOT): void {
  handlers[0]?.({ payload: { method, params: { deviceId: ID, ...(root ? { workflowRoot: root } : {}) } } });
}
function rpcCalls(method: string) {
  return vi
    .mocked(invoke)
    .mock.calls.filter(
      ([command, args]) => command === 'engine_rpc' && (args as { method?: string })?.method === method,
    );
}

let unlisten: () => void;
describe('运行命令与通知竞态', () => {
  beforeAll(async () => {
    unlisten = await useSessionStore.getState().init();
  });
  afterAll(() => {
    unlisten();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(invoke).mockReset().mockResolvedValue({ running: false });
    useDeviceStore.setState({ devices: [], activeId: ID });
    useSessionStore.getState().resetForEngineRestart();
    useSessionStore.setState({
      currentWorkflow: {
        root: ROOT,
        graphPath: `${ROOT}/graph.json`,
        nodes: 0,
        edges: 0,
        recognizers: 0,
        templates: 0,
      },
      runningStartStep: {},
      paused: {},
    });
    useGraphStore.setState({ graphs: {} });
    vi.spyOn(useGraphStore.getState(), 'flushWorkflowToEngine').mockResolvedValue();
    useEventStore.setState({ events: {}, seq: 0 });
  });

  it('run.started先到，停止后迟到的start回包不能重新置为运行中', async () => {
    const start = deferred<{ running: boolean }>();
    vi.mocked(invoke).mockImplementation((_command, args) =>
      (args as { method?: string })?.method === 'run.start'
        ? start.promise
        : Promise.resolve({ running: false }),
    );
    const starting = useSessionStore.getState().startRun(ID);
    await vi.waitFor(() => expect(rpcCalls('run.start')).toHaveLength(1));
    notify('run.started');
    await useSessionStore.getState().stopRun(ID);
    notify('run.stopped');
    start.resolve({ running: true });
    await starting;
    expect(useSessionStore.getState().running[ID]).toBe(false);
    expect(useSessionStore.getState().runningWorkflowRoots[ID]).toEqual([]);
  });

  it('启动尚在flush时停止，释放flush后不应发出run.start', async () => {
    const flush = deferred<void>();
    vi.mocked(useGraphStore.getState().flushWorkflowToEngine).mockReturnValue(flush.promise);
    const starting = useSessionStore.getState().startRun(ID);
    await useSessionStore.getState().stopRun(ID);
    flush.resolve();
    await starting;
    expect(rpcCalls('run.start')).toHaveLength(0);
    expect(useSessionStore.getState().running[ID]).toBe(false);
  });

  it.each([ROOT, undefined])('自然停止通知(%s)先于start回包，不能复活已结束运行', async (root) => {
    const start = deferred<{ running: boolean }>();
    vi.mocked(invoke).mockReturnValue(start.promise);
    const starting = useSessionStore.getState().startRun(ID);
    await vi.waitFor(() => expect(rpcCalls('run.start')).toHaveLength(1));
    notify('run.started');
    notify('run.stopped', root ?? '');
    start.resolve({ running: true });
    await starting;
    expect(useSessionStore.getState().running[ID]).toBe(false);
  });

  it('停止失败明确报错，不能清掉运行、暂停或循环进度', async () => {
    notify('run.started');
    const loops = { loop: { current: 2, total: 9 } };
    useSessionStore.setState({ paused: { [ID]: 'loop' }, loopProgress: { [ID]: loops } });
    vi.mocked(invoke).mockRejectedValue(new Error('停止RPC超时'));
    await expect(useSessionStore.getState().stopRun(ID)).resolves.toBeUndefined();
    expect(useSessionStore.getState().running[ID]).toBe(true);
    expect(useSessionStore.getState().runningWorkflowRoots[ID]).toEqual([ROOT]);
    expect(useSessionStore.getState().paused[ID]).toBe('loop');
    expect(useSessionStore.getState().loopProgress[ID]).toEqual(loops);
    expect(useSessionStore.getState().error).toContain('停止RPC超时');
    expect(
      useEventStore
        .getState()
        .events[ID]?.some((event) => event.type === 'error' && event.message?.includes('停止RPC超时')),
    ).toBe(true);
  });

  it('旧stop回包不能抹掉用户新启动的同一工作流', async () => {
    notify('run.started');
    const stop = deferred<{ running: boolean }>();
    vi.mocked(invoke).mockImplementation((_command, args) =>
      (args as { method?: string })?.method === 'run.stop'
        ? stop.promise
        : Promise.resolve({ running: true }),
    );
    const stopping = useSessionStore.getState().stopRun(ID);
    notify('run.stopped');
    await useSessionStore.getState().startRun(ID);
    notify('run.started');
    stop.resolve({ running: false });
    await stopping;
    expect(useSessionStore.getState().running[ID]).toBe(true);
    expect(useSessionStore.getState().runningWorkflowRoots[ID]).toEqual([ROOT]);
  });

  it('旧start迟到后仍是停止意图时补偿stop', async () => {
    const start = deferred<{ running: boolean }>();
    vi.mocked(invoke).mockImplementation((_command, args) =>
      (args as { method?: string })?.method === 'run.start'
        ? start.promise
        : Promise.resolve({ running: false }),
    );
    const starting = useSessionStore.getState().startRun(ID);
    await vi.waitFor(() => expect(rpcCalls('run.start')).toHaveLength(1));
    await useSessionStore.getState().stopRun(ID);
    start.resolve({ running: true });
    await starting;
    expect(rpcCalls('run.stop')).toHaveLength(2);
    expect(useSessionStore.getState().running[ID]).toBe(false);
  });

  it('用户已新start时旧start回包绝不能补偿stop', async () => {
    const oldStart = deferred<{ running: boolean }>();
    let starts = 0;
    vi.mocked(invoke).mockImplementation((_command, args) => {
      if ((args as { method?: string })?.method === 'run.start' && starts++ === 0) return oldStart.promise;
      return Promise.resolve({ running: true });
    });
    const starting = useSessionStore.getState().startRun(ID);
    await vi.waitFor(() => expect(rpcCalls('run.start')).toHaveLength(1));
    await useSessionStore.getState().stopRun(ID);
    await useSessionStore.getState().startRun(ID);
    oldStart.resolve({ running: true });
    await starting;
    expect(rpcCalls('run.stop')).toHaveLength(1);
    expect(useSessionStore.getState().running[ID]).toBe(true);
  });

  it('自动重连尚未结束时stop，重连后不得重试旧run.start', async () => {
    const connect = deferred<unknown>();
    vi.mocked(invoke).mockImplementation((_command, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'run.start') return Promise.reject(new Error('设备未连接: android:run-race'));
      if (method === 'device.connect') return connect.promise;
      return Promise.resolve({ running: false });
    });
    const { useDeviceStore } = await import('@/stores/device.store');
    useDeviceStore.setState({
      devices: [
        {
          id: ID,
          name: 'test',
          uri: 'Android:///?serial=run-race',
          kind: 'emulator',
          status: 'connected',
          resolution: [10, 10],
          fps: 0,
        },
      ],
      activeId: ID,
    });
    const starting = useSessionStore.getState().startRun(ID);
    await vi.waitFor(() => expect(rpcCalls('device.connect')).toHaveLength(1));
    await useSessionStore.getState().stopRun(ID);
    connect.resolve({
      deviceId: ID,
      resolution: [10, 10],
      channel: 'test',
      linkNote: '',
      graph: { version: 1, defaults: {}, recognizers: {}, nodes: [], edges: [] },
    });
    await starting;
    expect(rpcCalls('run.start')).toHaveLength(1);
    expect(useSessionStore.getState().running[ID]).toBe(false);
    useSessionStore.getState().setStreamPolicy(ID, 0);
  });

  it('停止一个root不清掉同设备其他仍在运行的工作流', async () => {
    notify('run.started');
    notify('run.started', 'S:/flows/other');
    vi.mocked(invoke).mockImplementation((_command, args) =>
      Promise.resolve(
        (args as { method?: string })?.method === 'run.status'
          ? { deviceId: ID, running: true, runningWorkflowRoots: ['S:/flows/other'] }
          : { running: true },
      ),
    );
    await useSessionStore.getState().stopRun(ID, ROOT);
    expect(useSessionStore.getState().running[ID]).toBe(true);
    expect(useSessionStore.getState().runningWorkflowRoots[ID]).toEqual(['S:/flows/other']);
  });

  it('后端废弃排队start并返回running:false时不伪造运行中', async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: true, running: false, superseded: true });
    await useSessionStore.getState().startRun(ID);
    expect(useSessionStore.getState().running[ID]).not.toBe(true);
    expect(useSessionStore.getState().runningWorkflowRoots[ID]).toBeUndefined();
  });

  it('迟到start已被后端废弃时不额外发送补偿stop', async () => {
    const start = deferred<{ running: boolean }>();
    vi.mocked(invoke).mockImplementation((_command, args) =>
      (args as { method?: string })?.method === 'run.start'
        ? start.promise
        : Promise.resolve({ running: false }),
    );
    const starting = useSessionStore.getState().startRun(ID);
    await vi.waitFor(() => expect(rpcCalls('run.start')).toHaveLength(1));
    await useSessionStore.getState().stopRun(ID);
    start.resolve({ running: false });
    await starting;
    expect(rpcCalls('run.stop')).toHaveLength(1);
    expect(useSessionStore.getState().running[ID]).toBe(false);
  });

  it('后端废弃旧stop时回包不能伪造已停止', async () => {
    notify('run.started');
    vi.mocked(invoke).mockResolvedValue({ ok: true, running: true, superseded: true });
    await useSessionStore.getState().stopRun(ID);
    expect(useSessionStore.getState().running[ID]).toBe(true);
    expect(useSessionStore.getState().runningWorkflowRoots[ID]).toEqual([ROOT]);
  });

  it('重载错过started后，权威frame恢复运行状态；相同规范roots保持对象身份', () => {
    useSessionStore.setState({ frames: { [ID]: { index: 1 } as never } });
    const frame = (roots?: string[], runRevision?: number) =>
      handlers[0]?.({
        payload: {
          method: 'engine.frame',
          params: { deviceId: ID, index: 1, ...(roots ? { runningWorkflowRoots: roots } : {}), runRevision },
        },
      });
    frame([ROOT], 2);
    expect(useSessionStore.getState().running[ID]).toBe(true);
    const roots = useSessionStore.getState().runningWorkflowRoots;
    frame(['s:\\flows\\ai\\'], 2);
    expect(useSessionStore.getState().runningWorkflowRoots).toBe(roots);
    handlers[0]?.({
      payload: { method: 'run.stopped', params: { deviceId: ID, workflowRoot: ROOT, runRevision: 1 } },
    });
    expect(useSessionStore.getState().running[ID]).toBe(true);
    handlers[0]?.({
      payload: { method: 'run.stopped', params: { deviceId: ID, workflowRoot: ROOT, runRevision: 3 } },
    });
    frame([ROOT], 2);
    expect(useSessionStore.getState().running[ID]).toBe(false);
    frame(); // 旧引擎无字段不是“停止”
    expect(useSessionStore.getState().running[ID]).toBe(false);
    frame([ROOT], 4);
    frame();
    expect(useSessionStore.getState().running[ID]).toBe(true);
  });

  it('HMR重新init通过status恢复错过的started', async () => {
    useSessionStore.setState({ ready: { [ID]: true } });
    vi.mocked(invoke).mockResolvedValue({
      deviceId: ID,
      running: true,
      runningWorkflowRoots: [ROOT],
      runRevision: 4,
    });
    unlisten();
    unlisten = await useSessionStore.getState().init();
    await vi.waitFor(() => expect(useSessionStore.getState().running[ID]).toBe(true));
    expect(useSessionStore.getState().runningWorkflowRoots[ID]).toEqual([ROOT]);
  });

  it.each(['run.started', 'run.stopped', 'engine.frame'])('旧status响应不能覆盖较新的%s', async (method) => {
    const status = deferred<unknown>();
    vi.mocked(invoke).mockImplementation((_command, args) =>
      (args as { method?: string })?.method === 'run.status' ? status.promise : Promise.resolve({}),
    );
    useSessionStore.setState({ ready: { [ID]: true }, frames: { [ID]: { index: 1 } as never } });
    unlisten();
    unlisten = await useSessionStore.getState().init();
    if (method === 'engine.frame') {
      handlers[0]?.({
        payload: { method, params: { deviceId: ID, index: 1, runningWorkflowRoots: [ROOT], runRevision: 2 } },
      });
    } else notify(method);
    status.resolve({
      deviceId: ID,
      running: method === 'run.stopped',
      runningWorkflowRoots: method === 'run.stopped' ? [ROOT] : [],
      runRevision: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(useSessionStore.getState().running[ID]).toBe(method !== 'run.stopped');
  });

  it('stop返回running:true且status仍含目标root时不假停', async () => {
    notify('run.started');
    vi.mocked(invoke).mockImplementation((_command, args) =>
      Promise.resolve(
        (args as { method?: string })?.method === 'run.status'
          ? { deviceId: ID, running: true, runningWorkflowRoots: [ROOT] }
          : { running: true },
      ),
    );
    await useSessionStore.getState().stopRun(ID);
    expect(useSessionStore.getState().running[ID]).toBe(true);
    expect(useSessionStore.getState().runningWorkflowRoots[ID]).toEqual([ROOT]);
  });

  it('adopt活设备通过status恢复运行状态', async () => {
    useDeviceStore.setState({
      devices: [
        {
          id: ID,
          name: 'test',
          uri: 'Android:///?serial=x',
          kind: 'emulator',
          status: 'connected',
          resolution: [10, 10],
          fps: 0,
        },
      ],
      activeId: ID,
    });
    vi.mocked(invoke).mockResolvedValue({
      deviceId: ID,
      running: true,
      runningWorkflowRoots: [ROOT],
      runRevision: 1,
    });
    useSessionStore.getState().adoptLiveDevices();
    await vi.waitFor(() => expect(useSessionStore.getState().running[ID]).toBe(true));
    useSessionStore.getState().setStreamPolicy(ID, 0);
  });

  it.each(['device.connected', 'device.disconnected', 'device.failed'])(
    '%s后新session低revision可以恢复',
    (method) => {
      useSessionStore.setState({ frames: { [ID]: { index: 1 } as never } });
      handlers[0]?.({
        payload: {
          method: 'engine.frame',
          params: { deviceId: ID, index: 1, runningWorkflowRoots: [], runRevision: 20 },
        },
      });
      notify(method);
      handlers[0]?.({
        payload: {
          method: 'engine.frame',
          params: { deviceId: ID, index: 1, runningWorkflowRoots: [ROOT], runRevision: 1 },
        },
      });
      expect(useSessionStore.getState().running[ID]).toBe(true);
      useSessionStore.getState().setStreamPolicy(ID, 0);
    },
  );

  it('引擎重启后旧start回包不能恢复运行态', async () => {
    const start = deferred<{ running: boolean }>();
    vi.mocked(invoke).mockReturnValue(start.promise);
    const starting = useSessionStore.getState().startRun(ID);
    await vi.waitFor(() => expect(rpcCalls('run.start')).toHaveLength(1));
    useSessionStore.getState().resetForEngineRestart();
    start.resolve({ running: true });
    await starting;
    expect(useSessionStore.getState().running).toEqual({});
  });
});
