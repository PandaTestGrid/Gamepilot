import { beforeEach, describe, expect, it, vi } from 'vitest';

import { engineStart, engineStop, ping, PROTOCOL_VERSION, rpc } from './rpc';

// 单测不启动 Tauri：mock 掉 invoke 这一层，只验证「信封与命令名」不被改坏
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

describe('rpc 客户端', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('rpc() 以 engine_rpc 命令 + method/params 结构调用 invoke', async () => {
    invokeMock.mockResolvedValue({ pong: true });
    const result = await rpc('engine.ping', { echo: 1 });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('engine_rpc', {
      method: 'engine.ping',
      params: { echo: 1 },
    });
    expect(result).toEqual({ pong: true });
  });

  it('rpc() 不传 params 时默认空对象（引擎侧要求 params 必须是对象）', async () => {
    invokeMock.mockResolvedValue({});
    await rpc('engine.info');

    expect(invokeMock).toHaveBeenCalledWith('engine_rpc', { method: 'engine.info', params: {} });
  });

  it('ping() 走 engine.ping 并回传协议版本', async () => {
    invokeMock.mockResolvedValue({ pong: true, version: '0.0.1', protocol: PROTOCOL_VERSION, ts: 1 });

    const result = await ping();

    expect(invokeMock).toHaveBeenCalledWith('engine_rpc', { method: 'engine.ping', params: {} });
    expect(result.pong).toBe(true);
    expect(result.protocol).toBe(PROTOCOL_VERSION);
  });

  it('engineStart()/engineStop() 对应两个独立命令', async () => {
    invokeMock.mockResolvedValue('started');

    await engineStart();
    expect(invokeMock).toHaveBeenLastCalledWith('engine_start');

    invokeMock.mockResolvedValue(undefined);
    await engineStop();
    expect(invokeMock).toHaveBeenLastCalledWith('engine_stop');
  });
});
