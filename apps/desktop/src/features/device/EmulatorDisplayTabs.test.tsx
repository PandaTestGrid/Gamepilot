import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmulatorDisplayTabs } from '@/features/device/EmulatorDisplayTabs';
import { ScreenPane } from '@/features/device/ScreenPane';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore, type FrameState } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { DeviceRuntime } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const MAIN: DeviceRuntime = {
  id: 'android:emulator-5554',
  name: 'MuMu 12',
  uri: 'Android:///?serial=emulator-5554',
  kind: 'emulator',
  status: 'connected',
  resolution: [720, 1280],
  fps: 10,
};
const GAME: DeviceRuntime = {
  ...MAIN,
  id: 'android:emulator-5554:4',
  name: 'MuMu 12 · 屏4 · com.netease.onmyoji.wyzymnqsd_cps',
  uri: 'Android:///?serial=emulator-5554&display=4',
};
const NEW: DeviceRuntime = {
  ...GAME,
  id: 'android:emulator-5554:12',
  name: 'MuMu 12 · 屏12 · com.example.game',
  uri: 'Android:///?serial=emulator-5554&display=12',
  status: 'discovered',
};

function frame(imageUrl: string): FrameState {
  return {
    imageUrl,
    index: 1,
    resolution: [720, 1280],
    node: null,
    pending: null,
    tick: 0,
    fps: 10,
    captureMs: 1,
    detections: [],
    ts: 1,
  };
}

const initialConnect = useSessionStore.getState().connect;
const initialDisconnect = useSessionStore.getState().disconnect;
const initialPressKey = useSessionStore.getState().pressKey;
const initialScan = useDeviceStore.getState().scan;

describe('模拟器窗口栏', () => {
  beforeEach(() => {
    useDeviceStore.setState({
      devices: [MAIN, GAME, NEW],
      activeId: MAIN.id,
      gridView: false,
      scanState: 'idle',
      scan: vi.fn(() => Promise.resolve()),
    });
    useSessionStore.setState({
      ready: { [MAIN.id]: true, [GAME.id]: true },
      frames: {
        [MAIN.id]: frame('data:image/jpeg;base64,AAAA'),
        [GAME.id]: frame('data:image/jpeg;base64,BBBB'),
      },
      connect: vi.fn(() => Promise.resolve(true)),
      disconnect: vi.fn(() => Promise.resolve()),
      pressKey: vi.fn(() => Promise.resolve()),
      error: null,
    });
    useGraphStore.setState({ graphs: {} });
    useUiStore.setState({ controlMode: true, recordMode: 'off', recordActionMode: false, draft: null });
  });

  it('在画面上方显示主屏与应用屏；点已连接的屏切换画面和导航控制', async () => {
    const user = userEvent.setup();
    render(<ScreenPane />);

    const tabs = screen.getByRole('group', { name: '模拟器窗口切换' });
    expect(within(tabs).getByRole('button', { name: /主屏/ })).toHaveAttribute('aria-current', 'true');
    expect(within(tabs).getByRole('button', { name: /^屏4 ·/ })).toHaveAttribute(
      'title',
      expect.stringContaining('com.netease.onmyoji'),
    );
    expect(screen.getByAltText('MuMu 12 实时画面')).toHaveAttribute('src', 'data:image/jpeg;base64,AAAA');

    await user.click(within(tabs).getByRole('button', { name: /^屏4 ·/ }));
    expect(useDeviceStore.getState().activeId).toBe(GAME.id);
    expect(screen.getByAltText(`${GAME.name} 实时画面`)).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,BBBB',
    );
    expect(within(tabs).getByRole('button', { name: /^屏4 ·/ })).toHaveAttribute('aria-current', 'true');
    await user.click(screen.getByRole('button', { name: '返回' }));
    expect(useSessionStore.getState().pressKey).toHaveBeenCalledWith(GAME.id, 'back');
    expect(useSessionStore.getState().connect).not.toHaveBeenCalled();
  });

  it('默认只有主屏，展开「添加屏幕」自动刷新实际附屏，但仍需显式接入', async () => {
    const user = userEvent.setup();
    useDeviceStore.setState({ devices: [MAIN] });
    const scan = vi.fn(() => {
      useDeviceStore.setState({ devices: [MAIN, GAME, NEW] });
      return Promise.resolve();
    });
    useDeviceStore.setState({ scan });
    render(<EmulatorDisplayTabs />);
    const tabs = screen.getByRole('group', { name: '模拟器窗口切换' });

    expect(within(tabs).getByRole('button', { name: /主屏/ })).toBeInTheDocument();
    expect(within(tabs).queryByRole('button', { name: /屏12/ })).not.toBeInTheDocument();
    await user.click(within(tabs).getByRole('button', { name: '添加屏幕' }));
    expect(scan).toHaveBeenCalledOnce();
    expect(within(tabs).queryByRole('button', { name: /屏12/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /添加屏12/ }));
    expect(useSessionStore.getState().connect).toHaveBeenCalledWith(NEW.id, NEW.uri);
  });

  it('附屏断开只结束该屏会话，随后可重新添加；主屏没有断开按钮', async () => {
    const user = userEvent.setup();
    const disconnect = vi.fn((id: string) => {
      useSessionStore.setState({ ready: { [MAIN.id]: true } });
      useDeviceStore.getState().disconnect(id);
      return Promise.resolve();
    });
    useSessionStore.setState({ disconnect });
    render(<EmulatorDisplayTabs />);

    const tabs = screen.getByRole('group', { name: '模拟器窗口切换' });
    expect(within(tabs).queryByRole('button', { name: '断开屏0' })).not.toBeInTheDocument();
    await user.click(within(tabs).getByRole('button', { name: '断开屏4' }));
    expect(disconnect).toHaveBeenCalledWith(GAME.id);
    expect(within(tabs).queryByRole('button', { name: /屏4 ·/ })).not.toBeInTheDocument();
    await user.click(within(tabs).getByRole('button', { name: '添加屏幕' }));
    expect(screen.getByRole('button', { name: /添加屏4/ })).toBeInTheDocument();
  });

  it('普通单屏真机不显示模拟器窗口栏', () => {
    useDeviceStore.setState({
      activeId: 'android:phone',
      devices: [{ ...MAIN, id: 'android:phone', uri: 'Android:///?serial=phone', kind: 'android' }],
    });
    render(<EmulatorDisplayTabs />);
    expect(screen.queryByRole('group', { name: '模拟器窗口切换' })).not.toBeInTheDocument();
  });
});

// 别把测试里的 RPC 桩留给同 worker 的其它用例。
afterAll(() => {
  useSessionStore.setState({
    connect: initialConnect,
    disconnect: initialDisconnect,
    pressKey: initialPressKey,
  });
  useDeviceStore.setState({ scan: initialScan });
});
