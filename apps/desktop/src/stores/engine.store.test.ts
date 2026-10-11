/**
 * 引擎 store：能力校验 + 重启。
 *
 * 重启是"引擎跑到旧进程上"的唯一解法，所以这里要钉死两件事：
 *   1. 重启的顺序是 stop → start → ping（顺序错了会连到旧进程上）；
 *   2. 重启后界面的连接态必须复位（旧进程里的设备会话已经没了，
 *      否则会一直显示"已连接"却发不出指令）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
import { useSessionStore } from '@/stores/session.store';

const invoke = vi.fn((_cmd: string, _args?: Record<string, unknown>): Promise<unknown> =>
  Promise.resolve({}),
);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>): Promise<unknown> => invoke(cmd, args),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const START = { pong: true, version: '0.0.1', protocol: 1, ts: 0 };

describe('引擎 store', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((_cmd: string, args?: Record<string, unknown>) => {
      const method = args?.method;
      if (method === 'engine.ping') {
        return Promise.resolve(START);
      }
      if (method === 'engine.info') {
        return Promise.resolve({
          version: '0.0.1',
          protocol: 1,
          methods: ['device.list', 'project.get', 'project.list', 'project.set'],
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
    expect(state.missingMethods).toContain('project.create'); // 但能力不够
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
          protocol: 1,
          methods: ['project.create', 'project.duplicate', 'project.rename', 'project.delete'],
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
      ready: { 'mock:1': true },
      frames: { 'mock:1': {} as never },
      running: { 'mock:1': true },
      error: '旧错误',
    });

    await useEngineStore.getState().restart();

    const session = useSessionStore.getState();
    expect(session.ready).toEqual({});
    expect(session.frames).toEqual({});
    expect(session.running).toEqual({});
    expect(session.error).toBeNull();
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
});
