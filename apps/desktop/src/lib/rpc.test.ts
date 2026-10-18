import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanErrorText, engineStart, engineStop, ping, PROTOCOL_VERSION, rpc } from './rpc';

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

describe('错误文案（cleanErrorText）', () => {
  it('拆信封：只留 message，前缀保留（说明是哪一层报的）', () => {
    const raw =
      '引擎返回错误: {"code":-32603,"message":"RuntimeError: 『相机』还在被使用，先改掉再删：界面『新界面』的进入条件"}';

    expect(cleanErrorText(raw)).toBe(
      '引擎返回错误: 『相机』还在被使用，先改掉再删：界面『新界面』的进入条件',
    );
  });

  it('没有前缀的信封（Rust 桥直接抛的 JSON）也能拆', () => {
    expect(cleanErrorText('{"code":-32603,"message":"ValueError: 已经有同名识别器: start_btn"}')).toBe(
      '已经有同名识别器: start_btn',
    );
  });

  it('KeyError 的 Python 引号也去掉', () => {
    expect(cleanErrorText("KeyError: '识别器不存在: logo'")).toBe('识别器不存在: logo');
  });

  it('本来就不是信封的：原样返回（消息里带 { 也不许乱拆）', () => {
    expect(cleanErrorText('引擎响应超时（>10s）')).toBe('引擎响应超时（>10s）');
    expect(cleanErrorText('params 必须是对象 {a: 1}')).toBe('params 必须是对象 {a: 1}');
    expect(cleanErrorText('  前后有空白  ')).toBe('前后有空白');
  });

  it('rpc() 把 reject 值统一成干净 message 的 Error（不管抛的是字符串还是 Error）', async () => {
    invokeMock.mockRejectedValue(
      '引擎返回错误: {"code":-32603,"message":"RuntimeError: 『相机』还在被使用，先改掉再删：界面『新界面』的进入条件"}',
    );
    await expect(rpc('recognizer.remove', {})).rejects.toThrow(
      '引擎返回错误: 『相机』还在被使用，先改掉再删：界面『新界面』的进入条件',
    );

    invokeMock.mockRejectedValue(new Error('{"code":-32603,"message":"RuntimeError: 写入失败"}'));
    await expect(rpc('graph.save', {})).rejects.toThrow('写入失败');
  });
});
