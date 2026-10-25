/**
 * 独立窗口启动回归。
 *
 * 两个真实 bug：
 *   1. 点「独立窗口」整个应用立刻未响应 —— Rust 侧在**同步** Tauri 命令里
 *      `WebviewWindowBuilder::build()`，Windows/WebView2 会死锁（见 window.rs 注释）。
 *      这里守前端的一半：窗口挂载后不能因为缺少设备清单就停在空态。
 *   2. 独立窗口没有自己的 `device.list`，`deviceId` 查不到设备，
 *      标题永远显示「未指定设备」，画面栏只能看到空态。
 *   3. 独立窗口没有拉当前工作流：框选/点选/录操作/文字识别全被`没有工作流`拦下，
 *      按钮点了一点反应都没有（用户反馈「独立页面多数功能不能用」）。
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { useDeviceStore } from '@/stores/device.store';
import { useEngineStore } from '@/stores/engine.store';
import { useUiStore } from '@/stores/ui.store';
import { useSessionStore } from '@/stores/session.store';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const listDevicesMock = vi.hoisted(() => vi.fn());
const projectGetMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/rpc', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listDevices: listDevicesMock,
  projectGet: projectGetMock,
}));

const DEVICE_ID = 'android:127.0.0.1:16384:42';

beforeEach(() => {
  listDevicesMock.mockReset();
  listDevicesMock.mockResolvedValue({
    devices: [
      {
        id: DEVICE_ID,
        uri: 'Android:///?serial=127.0.0.1:16384&physical=42',
        name: 'MuMu · 屏23',
        kind: 'emulator',
        status: 'connected',
        resolution: [1280, 720],
      },
    ],
    errors: [],
    pendingAndroidSerials: [],
  });
  projectGetMock.mockReset();
  projectGetMock.mockResolvedValue({
    root: '/p/甲/斗技',
    graphPath: '/p/甲/斗技/graph.json',
    nodes: 0,
    edges: 0,
    recognizers: 0,
    templates: 0,
  });
  useEngineStore.setState({ status: 'ready', info: 'engine test', notifications: [], missingMethods: [] });
  useDeviceStore.setState({ devices: [], activeId: '', gridView: false, scanState: 'idle' });
  useSessionStore.setState({ ready: { [DEVICE_ID]: true }, frames: {}, error: null });
  window.history.replaceState({}, '', `/?pane=screen&device=${encodeURIComponent(DEVICE_ID)}`);
  useUiStore.setState({ recordMode: 'off', recordActionMode: false, draft: null });
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
  listDevicesMock.mockReset();
});

describe('独立画面窗口', () => {
  it('只渲染画面栏，并且自己扫描设备清单（不是「未指定设备」）', async () => {
    render(<App />);

    // 独立窗口没有主壳的三栏与顶部设备条
    expect(screen.queryByText('布局')).toBeNull();
    expect(screen.getByText('独立窗口 · 关闭不影响运行')).toBeInTheDocument();

    // 关键：URL 里的 device 必须能在自己这份 store 里找到
    await waitFor(() => expect(listDevicesMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('MuMu · 屏23')).toBeInTheDocument());
    expect(screen.queryByText('未指定设备')).toBeNull();
  });

  it('独立窗口也要拉当前工作流（否则框选/录制/录操作全被「没有工作流」拦下）', async () => {
    render(<App />);

    await waitFor(() => expect(projectGetMock).toHaveBeenCalled());
    await waitFor(() => expect(useSessionStore.getState().currentWorkflow?.root).toBe('/p/甲/斗技'));

    // 有工作流之后，录制工具才允许进入框选（这里只校验前置条件，不模拟拖框）
    expect(useUiStore.getState().setRecordMode).toBeTypeOf('function');
    useUiStore.getState().setRecordMode('marquee');
    expect(useUiStore.getState().recordMode).toBe('marquee');
    expect(useSessionStore.getState().error).toBeNull();
  });
});




