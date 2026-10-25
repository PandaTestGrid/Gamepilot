/**
 * App 挂载期的异步订阅回归。
 *
 * `init()` / `initSession()` 返回的是 Promise：热更新或慢启动时，订阅结果可能**晚于组件卸载**
 * 才回来。晚到的订阅必须立刻注销，否则每次热更新都多留一份监听器（同一条通知被处理 N 次）。
 */
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
import { useSessionStore } from '@/stores/session.store';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));

/** listen() 什么时候返回由测试控制：用来模拟"订阅结果晚于卸载" */
const deferred = vi.hoisted(
  () => [] as Array<{ resolve: (unlisten: () => void) => void; reject: (error: unknown) => void }>,
);
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    () =>
      new Promise<() => void>((resolve, reject) => {
        deferred.push({ resolve, reject });
      }),
  ),
}));

function resetStores(): void {
  useEngineStore.setState({ status: 'ready', info: 'engine test', notifications: [], missingMethods: [] });
  useSessionStore.setState({
    ready: {},
    frames: {},
    links: {},
    running: {},
    connectingPhase: {},
    error: null,
  });
  useDeviceStore.setState({ devices: [], activeId: '' });
}

describe('App 的异步订阅', () => {
  beforeEach(() => {
    deferred.length = 0;
    resetStores();
  });

  afterEach(() => {
    deferred.length = 0;
    resetStores();
  });

  it('卸载之后才返回的订阅会被立刻注销（不留重复监听器）', async () => {
    const view = render(<App />);
    await waitFor(() => expect(deferred.length).toBeGreaterThanOrEqual(2));

    const unlisteners = deferred.map(() => vi.fn());
    view.unmount();
    deferred.forEach((pending, index) => {
      const unlisten = unlisteners[index];
      if (unlisten) pending.resolve(unlisten);
    });

    await waitFor(() => {
      for (const unlisten of unlisteners) {
        expect(unlisten).toHaveBeenCalled();
      }
    });
  });

  it('订阅 Promise 被拒绝时不会产生未处理的 rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const view = render(<App />);
      await waitFor(() => expect(deferred.length).toBeGreaterThanOrEqual(2));

      for (const pending of deferred) pending.reject(new Error('事件通道不可用'));
      await new Promise((resolve) => setTimeout(resolve, 0));

      view.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
