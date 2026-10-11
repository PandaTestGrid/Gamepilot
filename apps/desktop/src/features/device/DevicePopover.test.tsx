/**
 * 设备弹层的交互测试：分类 Tab、点击语义（连接 / 切换 / 断开）、本机窗口 Tab。
 *
 * 这几条正是用户抱怨的点：
 *   - 以前 Tab 写死六个，空的也显示 → 以为设备没了；
 *   - macOS 的"本机窗口"伪设备在列表里能点，点下去却连 `window=0`；
 *   - 已连接的行点一下是重连/断开，不是**切换当前设备**。
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DevicePopover } from '@/features/device/DevicePopover';
import { macWindows } from '@/lib/rpc';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { DeviceRuntime } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock('@/lib/rpc', async (importOriginal) => {
  // 只替换窗口枚举：其余 RPC 保持真实实现（本用例不触发网络）
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, macWindows: vi.fn() };
});

function device(patch: Partial<DeviceRuntime> & Pick<DeviceRuntime, 'id' | 'kind'>): DeviceRuntime {
  return {
    name: patch.id,
    uri: `Uri:///?id=${patch.id}`,
    status: 'discovered',
    resolution: null,
    fps: 0,
    ...patch,
  };
}

const ANDROID = device({ id: 'android:1', kind: 'android', name: 'OPPO A57', status: 'connected' });
const MOCK = device({ id: 'mock:1', kind: 'mock', name: 'Mock 合成设备', status: 'discovered' });
const MAC_PICKER = device({ id: 'macos:picker', kind: 'windows', name: '本机窗口（macOS）· 2 个可选窗口' });
const MAC_WINDOW = device({ id: 'macos:89', kind: 'windows', name: 'Safari', status: 'connected' });

function open(devices: DeviceRuntime[], activeId = ANDROID.id): void {
  useDeviceStore.setState({ devices, activeId, scanState: 'idle', scanErrors: [], scanError: null });
  useUiStore.setState({ devicePopoverOpen: true, deviceTab: 'all' });
}

describe('设备弹层', () => {
  beforeEach(() => {
    vi.mocked(macWindows).mockResolvedValue({
      platform: 'darwin',
      allowed: true,
      windows: [
        {
          handle: 89,
          pid: 1,
          app: 'Safari',
          title: 'Apple',
          label: 'Safari · Apple',
          x: 0,
          y: 0,
          width: 1200,
          height: 800,
          uri: 'Mac:///?window=89',
        },
        {
          handle: 42,
          pid: 2,
          app: 'MuMuPlayer',
          title: '游戏',
          label: 'MuMuPlayer · 游戏',
          x: 0,
          y: 0,
          width: 900,
          height: 600,
          uri: 'Mac:///?window=42',
        },
      ],
    });
    useSessionStore.setState({
      connect: vi.fn(() => Promise.resolve(true)),
      disconnect: vi.fn(() => Promise.resolve()),
    });
    useDeviceStore.setState({ scan: vi.fn(() => Promise.resolve()), devices: [], activeId: '' });
  });

  it('只显示有内容的分类，并带数量（空分类不再占位）', () => {
    open([ANDROID, MOCK, MAC_PICKER, MAC_WINDOW]);
    render(<DevicePopover />);

    const tabs = within(screen.getByTitle('全部（4）').parentElement as HTMLElement);
    expect(screen.getByTitle('全部（4）')).toBeInTheDocument();
    expect(screen.getByTitle('安卓（1）')).toBeInTheDocument();
    expect(screen.getByTitle('本机窗口（2）')).toBeInTheDocument();
    expect(screen.getByTitle('Mock（1）')).toBeInTheDocument();
    expect(screen.queryByTitle(/^iOS（/)).not.toBeInTheDocument();
    expect(tabs).toBeTruthy();
  });

  it('macOS 的"本机窗口"伪设备不在可连列表里，只给一条去窗口 Tab 的入口', () => {
    open([ANDROID, MAC_PICKER, MAC_WINDOW]);
    render(<DevicePopover />);

    // 列表里没有那个伪设备的行（它只有 1 个真窗口 + 1 台安卓）
    expect(screen.queryByText(/本机窗口（macOS）· 2 个可选窗口/)).not.toBeInTheDocument();
    expect(screen.getByText(/在「本机窗口」Tab 里挑一个窗口连/)).toBeInTheDocument();
  });

  it('点已连接的设备 = 切换当前设备（不再重连），并收起弹层', async () => {
    const user = userEvent.setup();
    const setActive = vi.fn();
    open([MOCK, ANDROID], MOCK.id);
    useDeviceStore.setState({ setActive });
    render(<DevicePopover />);

    await user.click(screen.getByText('OPPO A57').closest('button') as HTMLButtonElement);

    expect(setActive).toHaveBeenCalledWith(ANDROID.id);
    expect(useUiStore.getState().devicePopoverOpen).toBe(false);
  });

  it('点未连接的设备 = 连接', async () => {
    const user = userEvent.setup();
    const connect = vi.fn(() => Promise.resolve(true));
    useSessionStore.setState({ connect });
    open([ANDROID, MOCK], ANDROID.id);
    render(<DevicePopover />);

    await user.click(screen.getByText('Mock 合成设备').closest('button') as HTMLButtonElement);

    expect(connect).toHaveBeenCalledWith(MOCK.id, MOCK.uri);
  });

  it('当前设备标出「当前」，行内「断开」仍然可用', async () => {
    const user = userEvent.setup();
    const disconnect = vi.fn(() => Promise.resolve());
    useSessionStore.setState({ disconnect });
    open([ANDROID, MOCK], ANDROID.id);
    render(<DevicePopover />);

    expect(screen.getByText('当前')).toBeInTheDocument();
    await user.click(screen.getByText('断开'));
    expect(disconnect).toHaveBeenCalledWith(ANDROID.id);
  });

  it('本机窗口 Tab：列出窗口（App/标题/尺寸/句柄），已连的标「当前」，点未连的窗口去连', async () => {
    const user = userEvent.setup();
    const connect = vi.fn(() => Promise.resolve(true));
    useSessionStore.setState({ connect });
    open([ANDROID, MAC_PICKER, MAC_WINDOW]);
    render(<DevicePopover />);

    await user.click(screen.getByTitle('本机窗口（2）'));

    expect(await screen.findByText('Safari')).toBeInTheDocument();
    expect(screen.getByText('MuMuPlayer')).toBeInTheDocument();
    expect(screen.getByText('#89')).toBeInTheDocument();
    expect(screen.getByText('1200×800')).toBeInTheDocument();
    expect(screen.getByText('当前')).toBeInTheDocument(); // 89 已连接

    await user.click(screen.getByText('MuMuPlayer').closest('button') as HTMLButtonElement);
    expect(connect).toHaveBeenCalledWith('macos:42', 'Mac:///?window=42');
  });

  it('本机窗口 Tab 支持搜索（App / 标题 / 句柄）', async () => {
    const user = userEvent.setup();
    open([ANDROID, MAC_PICKER]);
    render(<DevicePopover />);

    await user.click(screen.getByTitle('本机窗口（1）'));
    await screen.findByText('Safari');

    await user.type(screen.getByPlaceholderText('搜 App 名 / 窗口标题 / 句柄'), '89');
    expect(screen.getByText('Safari')).toBeInTheDocument();
    expect(screen.queryByText('MuMuPlayer')).not.toBeInTheDocument();
  });

  it('Esc 关闭弹层（键盘能用）', async () => {
    const user = userEvent.setup();
    open([ANDROID]);
    render(<DevicePopover />);

    await user.keyboard('{Escape}');
    expect(useUiStore.getState().devicePopoverOpen).toBe(false);
  });
});
