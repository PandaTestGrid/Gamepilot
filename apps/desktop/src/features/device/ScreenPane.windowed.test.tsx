/**
 * 「画面已弹到独立窗口」时主窗口不再重复画一路投屏。
 *
 * 真实反馈：点了独立窗口之后，主窗口那块区域**还留着画面**，
 * 看起来像独立窗口没生效 —— 其实是同一台设备的投屏被两个 WebView 各解了一遍。
 * 现在主窗口让位成提示，独立窗口（`?pane=screen`）里照常画。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreenPane } from '@/features/device/ScreenPane';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const DEVICE = 'mock:1';

function setup(windowed: boolean): void {
  useSessionStore.setState({ ready: { [DEVICE]: true }, frames: {}, currentWorkflow: null, error: null });
  useDeviceStore.setState({
    activeId: DEVICE,
    gridView: false,
    devices: [
      {
        id: DEVICE,
        name: 'Mock 屏',
        uri: 'mock:1',
        kind: 'android',
        status: 'connected',
        resolution: [1280, 720],
        fps: 12,
        windowed,
      },
    ],
  });
  useUiStore.setState({ controlMode: true, recordMode: 'off', recordActionMode: false, draft: null });
}

beforeEach(() => {
  // 主窗口：没有 ?pane=
  window.history.replaceState({}, '', '/');
});

describe('画面在独立窗口时主窗口让位', () => {
  it('已弹窗的设备显示占位，不再渲染实时画面 <img>', () => {
    setup(true);
    render(<ScreenPane />);

    expect(screen.getByTestId('screen-in-separate-window')).toBeInTheDocument();
    expect(screen.queryByAltText('Mock 屏 实时画面')).toBeNull();
  });

  it('「收回主窗口」把画面要回来（关掉独立窗口 + 恢复本窗口渲染）', async () => {
    setup(true);
    render(<ScreenPane />);

    fireEvent.click(screen.getByText('收回主窗口'));

    await waitFor(() => expect(useDeviceStore.getState().devices[0]?.windowed).toBe(false));
    await waitFor(() => expect(screen.queryByTestId('screen-in-separate-window')).toBeNull());
  });

  it('没弹窗时照常渲染实时画面', () => {
    setup(false);
    render(<ScreenPane />);

    expect(screen.queryByTestId('screen-in-separate-window')).toBeNull();
    expect(screen.getByText('等待首帧…')).toBeInTheDocument();
  });
});

