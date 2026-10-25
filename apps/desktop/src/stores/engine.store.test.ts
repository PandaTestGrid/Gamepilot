/**
 * 引擎 store：能力校验 + 重启。
 *
 * 重启是"引擎跑到旧进程上"的唯一解法，所以这里要钉死两件事：
 *   1. 重启的顺序是 stop → start → ping（顺序错了会连到旧进程上）；
 *   2. 重启后界面的连接态必须复位（旧进程里的设备会话已经没了，
 *      否则会一直显示"已连接"却发不出指令）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REQUIRED_ENGINE_METHODS } from '@/lib/engine-methods';
import { useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
import { PROTOCOL_VERSION } from '@/lib/rpc';
import { useSessionStore } from '@/stores/session.store';

const invoke = vi.fn((_cmd: string, _args?: Record<string, unknown>): Promise<unknown> =>
  Promise.resolve({}),
);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>): Promise<unknown> => invoke(cmd, args),
}));

/** `engine://event` 的 handler：`init()` 订阅之后从这里灌通知 */
const { handlers } = vi.hoisted(() => ({ handlers: [] as Array<(event: { payload: unknown }) => void> }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.push(handler);
    return Promise.resolve(() => undefined);
  }),
}));

// 协议版本从 rpc.ts 拿：契约一升级，这里跟着走（别手写死数字）
const START = { pong: true, version: '0.0.1', protocol: PROTOCOL_VERSION, ts: 0 };

describe('引擎 store', () => {
  beforeEach(() => {
    handlers.length = 0;
    invoke.mockReset();
    invoke.mockImplementation((_cmd: string, args?: Record<string, unknown>) => {
      const method = args?.method;
      if (method === 'engine.ping') {
        return Promise.resolve(START);
      }
      if (method === 'engine.info') {
        return Promise.resolve({
          version: '0.0.1',
          protocol: PROTOCOL_VERSION,
          // 旧进程的方法表：只有项目当前值的读写（没有工作区层，也没有工作流层）
          methods: ['device.list', 'project.get', 'project.set'],
        });
      }
      return Promise.resolve({});
    });
    useEngineStore.setState({ status: 'idle', info: '', notifications: [], missingMethods: [] });
    useSessionStore.setState({
      ready: {},
      frames: {},
      links: {},
      running: {},
      connectingPhase: {},
      error: null,
    });
    useDeviceStore.setState({ devices: [], activeId: '', scanError: null });
  });

  it('自检发现引擎缺方法：状态照样 ready，但把"旧进程"标出来', async () => {
    await useEngineStore.getState().selfCheck();

    const state = useEngineStore.getState();
    expect(state.status).toBe('ready'); // 进程是活的
    expect(state.missingMethods).toContain('workspace.add'); // 工作区层
    expect(state.missingMethods).toContain('workflow.create'); // 工作流层
  });

  it('重启：先 engine_stop 再 engine_start，最后重新握手', async () => {
    const calls: string[] = [];
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd === 'engine_rpc' ? String(args?.method) : cmd);
      if (args?.method === 'engine.ping') {
        return Promise.resolve(START);
      }
      if (args?.method === 'engine.info') {
        return Promise.resolve({
          version: '0.0.1',
          protocol: PROTOCOL_VERSION,
          // 新进程 = 能力清单齐全（跟着 REQUIRED_ENGINE_METHODS 走，契约变了这里自动跟上）
          methods: [...REQUIRED_ENGINE_METHODS, 'device.list'],
        });
      }
      return Promise.resolve({});
    });

    await useEngineStore.getState().restart();

    expect(calls.slice(0, 2)).toEqual(['engine_stop', 'engine_start']);
    expect(calls).toContain('engine.ping');
    expect(useEngineStore.getState().missingMethods).toEqual([]);
    expect(useEngineStore.getState().status).toBe('ready');
  });

  it('重启后设备/会话连接态复位（旧进程的 session 已经没了）', async () => {
    useSessionStore.setState({
      ready: { 'android:1': true },
      frames: { 'android:1': {} as never },
      running: { 'android:1': true },
      error: '旧错误',
    });

    useDeviceStore.setState({
      devices: [
        {
          id: 'android:1',
          name: '测试机',
          uri: 'Android:///?serial=1',
          kind: 'android',
          status: 'connected',
          resolution: [640, 360],
          fps: 10,
        },
      ],
      activeId: 'android:1',
      gridView: true,
    });

    await useEngineStore.getState().restart();

    const session = useSessionStore.getState();

    expect(session.ready).toEqual({});
    expect(session.frames).toEqual({});
    expect(session.running).toEqual({});
    expect(session.error).toBeNull();

    // 旧进程里的设备会话已经没了：界面上的「已连接」与多开网格必须一起复位
    const device = useDeviceStore.getState().devices.find((item) => item.id === 'android:1');
    expect(device?.status).toBe('discovered');
    expect(useDeviceStore.getState().gridView).toBe(false);
  });

  it('重启失败：状态置 error 且把原因写进 info（不静默）', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'engine_start') {
        return Promise.reject(new Error('未找到 engine/.venv'));
      }
      return Promise.resolve({});
    });

    await useEngineStore.getState().restart();

    expect(useEngineStore.getState().status).toBe('error');
    expect(useEngineStore.getState().info).toContain('未找到 engine/.venv');
  });

  it('引擎进程自己退出（engine.exited）：状态变 error，并把"怎么办"写在信息里', async () => {
    const unlisten = await useEngineStore.getState().init();
    expect(handlers).toHaveLength(1);

    handlers[0]?.({ payload: { method: 'engine.exited', params: { reason: 'exit status: 1' } } });

    const state = useEngineStore.getState();
    // 以前这里什么都不做：界面只会回「引擎没在运行」这种没头没尾的错，日志里也没有一行
    expect(state.status).toBe('error');
    expect(state.info).toContain('引擎已退出');
    expect(state.info).toContain('exit status: 1');
    expect(state.info).toContain('重启引擎');
    unlisten();
  });
});
