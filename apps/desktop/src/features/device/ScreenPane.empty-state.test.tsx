/**
 * 画面栏空态「已发现」列表：点一行要**直接连上**。
 *
 * 用户反馈：点了只是弹出设备弹层（"弹出弹框去连接"），并没有真的连 ——
 * 设备就在列表里，还要再去弹层里选一次是多余的。
 *
 * 顺带守住：iOS 那一行的分辨率要在（引擎 discover 阶段读 lockdown 的 iTunes 域）。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreenPane } from '@/features/device/ScreenPane';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { DeviceRuntime } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const PHONE: DeviceRuntime = {
  id: 'android:22041211AC',
  name: '22041211AC',
  uri: 'Android:///?serial=22041211AC',
  kind: 'android',
  status: 'discovered',
  resolution: [1080, 2400],
  fps: 0,
};
const IPHONE: DeviceRuntime = {
  id: 'ios:00008110',
  name: 'happyelements iPhone (iOS 26.6)',
  uri: 'iOS:///?udid=00008110',
  kind: 'ios',
  status: 'discovered',
  resolution: [1170, 2532],
  fps: 0,
};

describe('画面栏空态：已发现设备', () => {
  beforeEach(() => {
    useDeviceStore.setState({
      devices: [PHONE, IPHONE],
      activeId: '',
      gridView: false,
      scanState: 'idle',
      scanError: null,
    });
    useSessionStore.setState({
      ready: {},
      frames: {},
      links: {},
      running: {},
      connectingPhase: {},
      error: null,
      connect: vi.fn(() => Promise.resolve(true)),
    });
    useGraphStore.setState({ graphs: {} });
    useUiStore.setState({
      devicePopoverOpen: false,
      controlMode: true,
      recordMode: 'off',
      recordActionMode: false,
      draft: null,
    });
  });

  it('点一行 = 直接连那台，而不是弹设备面板', async () => {
    const user = userEvent.setup();
    render(<ScreenPane />);

    // iOS 的分辨率也要显示出来（以前是 —）
    expect(screen.getByText('1170×2532')).toBeInTheDocument();

    await user.click(screen.getByText(IPHONE.name));

    expect(useSessionStore.getState().connect).toHaveBeenCalledWith(IPHONE.id, IPHONE.uri);
    // 关键：**没有**再弹出设备弹层
    expect(useUiStore.getState().devicePopoverOpen).toBe(false);
  });

  it('连接中那一行显示「连接中…」并禁用（避免连点两下）', () => {
    useDeviceStore.setState({ devices: [{ ...PHONE, status: 'connecting' }], activeId: '' });
    render(<ScreenPane />);

    expect(screen.getByText('连接中…')).toBeInTheDocument();
    expect(screen.getByText('连接中…').closest('button')).toBeDisabled();
  });

  it('「连接设备」按钮仍然打开设备面板（搜索 / 分类 / 手输 URI）', async () => {
    const user = userEvent.setup();
    render(<ScreenPane />);

    await user.click(screen.getByRole('button', { name: '连接设备' }));

    expect(useUiStore.getState().devicePopoverOpen).toBe(true);
  });
});
