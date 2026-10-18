import { invoke } from '@tauri-apps/api/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { useSessionStore } from '@/stores/session.store';
import type { DeviceRuntime } from '@/types';

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

const DEVICE: DeviceRuntime = {
  id: 'android:emulator-5554:42',
  name: 'MuMu · 屏2',
  uri: 'Android:///?serial=emulator-5554&display=2&physical=42',
  kind: 'emulator',
  status: 'connected',
  resolution: [100, 200],
  fps: 10,
};

function notify(method: string, params: Record<string, unknown>): void {
  handlers[0]?.({ payload: { method, params } });
}

function engineEvent(type: string, node: string | null): void {
  notify('engine.event', {
    deviceId: DEVICE.id,
    workflowRoot: '',
    type,
    node,
    message: '',
    ts: 1,
  });
}

let unlisten: () => void;

describe('断点暂停状态：引擎事件是唯一真源', () => {
  beforeAll(async () => {
    unlisten = await useSessionStore.getState().init();
  });
  afterAll(() => {
    unlisten();
  });
  beforeEach(() => {
    useDeviceStore.setState({ devices: [DEVICE], activeId: DEVICE.id });
    useSessionStore.setState({ paused: {}, breakpoints: {}, running: {}, error: null });
    useEventStore.setState({ events: {}, seq: 0 });
  });

  it('breakpoint_hit 记下暂停所在的步骤', () => {
    engineEvent('breakpoint_hit', 's3');
    expect(useSessionStore.getState().paused[DEVICE.id]).toBe('s3');
  });

  it('继续之后（run.resumed）立刻清掉暂停态', () => {
    engineEvent('breakpoint_hit', 's3');
    notify('run.resumed', { deviceId: DEVICE.id });
    expect(useSessionStore.getState().paused[DEVICE.id]).toBeNull();
  });

  it('又跑了一步（step_started）也算离开暂停态', () => {
    engineEvent('breakpoint_hit', 's3');
    engineEvent('step_started', 's4');
    expect(useSessionStore.getState().paused[DEVICE.id]).toBeNull();
  });

  it('停止运行（run.stopped）清掉暂停态，避免横幅挂在已停的设备上', () => {
    engineEvent('breakpoint_hit', 's3');
    notify('run.stopped', { deviceId: DEVICE.id });
    expect(useSessionStore.getState().paused[DEVICE.id]).toBeNull();
  });

  it('切换断点时把引擎返回的断点表存下来（引擎是唯一真源）', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ edgeId: 's3', enabled: true, breakpoints: ['s3'] });
    await useSessionStore.getState().setStepBreakpoint(DEVICE.id, 's3', true);

    expect(invoke).toHaveBeenCalledWith('engine_rpc', {
      method: 'run.breakpoint',
      params: { deviceId: DEVICE.id, edgeId: 's3', enabled: true },
    });
    expect(useSessionStore.getState().breakpoints[DEVICE.id]).toEqual(['s3']);
  });
});
