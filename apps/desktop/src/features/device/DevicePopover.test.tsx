/**
 * 设备弹层的交互测试：分类 Tab、点击语义（连接 / 切换 / 断开）、本机窗口 Tab。
 *
 * 这几条正是用户抱怨的点：
 *   - 以前 Tab 写死六个，空的也显示 → 以为设备没了；
 *   - 本机窗口的伪设备在列表里能点，点下去却连 `window=0`；
 *   - 已连接的行点一下是重连/断开，不是**切换当前设备**；
 *   - Windows 本机窗口要能按窗口 `deviceId` + 绑定 URI 连接（不再只认 macOS 句柄）。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DevicePopover } from '@/features/device/DevicePopover';
import { windowList } from '@/lib/rpc';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { DeviceRuntime } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock('@/lib/rpc', async (importOriginal) => {
  // 只替换窗口枚举：其余 RPC 保持真实实现（本用例不触发网络）
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, windowList: vi.fn() };
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
const SPARE = device({ id: 'android:2', kind: 'android', name: 'Pixel 7', status: 'discovered' });
const MAC_PICKER = device({ id: 'macos:picker', kind: 'windows', name: '本机窗口（macOS）· 2 个可选窗口' });
const MAC_WINDOW = device({ id: 'macos:89', kind: 'windows', name: 'Safari', status: 'connected' });
const WINDOWS_PICKER = device({
  id: 'windows:picker',
  kind: 'windows',
  name: '本机窗口（Windows）· 1 个可选窗口',
});
const WINDOWS_WINDOW = device({ id: 'windows:6698742', kind: 'windows', name: '某游戏' });

function open(devices: DeviceRuntime[], activeId = ANDROID.id): void {
  useDeviceStore.setState({ devices, activeId, scanState: 'idle', scanErrors: [], scanError: null });
  useUiStore.setState({ devicePopoverOpen: true, deviceTab: 'all' });
}

describe('设备弹层', () => {
  it('行右侧留边距：`连接` 不贴弹层边框（用户反馈"太贴边了"）', () => {
    open([SPARE]);
    render(<DevicePopover />);

    const connect = screen.getByRole('button', { name: '连接' });
    // 按钮所在的那一行要有右内边距，否则文字会顶到面板边框上
    expect(connect.parentElement).toHaveClass('pr-2');
  });

  beforeEach(() => {
    vi.mocked(windowList).mockResolvedValue({
      platform: 'darwin',
      allowed: true,
      note: '2 个可选窗口',
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
          deviceId: 'macos:89',
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
          deviceId: 'macos:42',
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
    open([ANDROID, SPARE, MAC_PICKER, MAC_WINDOW, WINDOWS_PICKER, WINDOWS_WINDOW]);
    render(<DevicePopover />);

    expect(screen.getByTitle('全部（4）')).toBeInTheDocument();
    expect(screen.getByTitle('安卓（2）')).toBeInTheDocument();
    expect(screen.getByTitle('本机窗口（4）')).toBeInTheDocument();
    expect(screen.queryByTitle(/^Mock（/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^iOS（/)).not.toBeInTheDocument();
  });

  it('本机窗口的伪设备不在可连列表里，只给一条去窗口 Tab 的入口（Windows / macOS 通用文案）', () => {
    open([ANDROID, WINDOWS_PICKER, WINDOWS_WINDOW]);
    render(<DevicePopover />);

    // 列表里没有那个伪设备的行（它只有 1 个真窗口 + 1 台安卓）
    expect(screen.queryByText(/本机窗口（Windows）· 1 个可选窗口/)).not.toBeInTheDocument();
    expect(screen.getByText(/在「本机窗口」Tab 里挑一个窗口绑定并连接/)).toBeInTheDocument();
  });

  it('点已连接的设备 = 切换当前设备（不再重连），并收起弹层', async () => {
    const user = userEvent.setup();
    const setActive = vi.fn();
    open([SPARE, ANDROID], SPARE.id);
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
    open([ANDROID, SPARE], ANDROID.id);
    render(<DevicePopover />);

    await user.click(screen.getByText('Pixel 7').closest('button') as HTMLButtonElement);

    expect(connect).toHaveBeenCalledWith(SPARE.id, SPARE.uri);
  });

  it('模拟器已打开的应用窗口会单独成行，可直接连接', () => {
    const connect = vi.fn(() => Promise.resolve(true));
    useSessionStore.setState({ connect });
    const EMULATOR = device({
      id: 'android:emulator-5554',
      kind: 'emulator',
      name: 'MuMu 12',
      status: 'connected',
    });
    // 引擎扫描出来的多屏行：id 带屏号、名字带屏号与顶层应用包名、URI 带 display
    const SCREEN_4 = device({
      id: 'android:emulator-5554:42',
      kind: 'emulator',
      name: 'MuMu 12 · 屏4 · com.netease.onmyoji.wyzymnqsd_cps',
      uri: 'Android:///?serial=emulator-5554&display=4&physical=42',
      resolution: [900, 1600],
    });
    open([EMULATOR, SCREEN_4, SPARE], EMULATOR.id);
    render(<DevicePopover />);

    expect(screen.getByTitle('模拟器（2）')).toBeInTheDocument();
    expect(screen.getByTitle('安卓（1）')).toBeInTheDocument();
    expect(screen.getByText('MuMu 12')).toBeInTheDocument();
    expect(screen.getByText(/屏4/)).toBeInTheDocument();
    expect(screen.getByText(/已打开的应用窗口会单独成行/)).toBeInTheDocument();
    expect(connect).not.toHaveBeenCalled();
  });

  it('当前设备标出「当前」，行内「断开」仍然可用', async () => {
    const user = userEvent.setup();
    const disconnect = vi.fn(() => Promise.resolve());
    useSessionStore.setState({ disconnect });
    open([ANDROID, SPARE], ANDROID.id);
    render(<DevicePopover />);

    expect(screen.getByText('当前')).toBeInTheDocument();
    await user.click(screen.getByText('断开'));
    expect(disconnect).toHaveBeenCalledWith(ANDROID.id);
  });

  it('本机窗口 Tab（macOS）：列出窗口（App/标题/尺寸/句柄），已绑定的标出来，点未连的去连', async () => {
    const user = userEvent.setup();
    const connect = vi.fn(() => Promise.resolve(true));
    useSessionStore.setState({ connect });
    open([ANDROID, MAC_PICKER, MAC_WINDOW]);
    render(<DevicePopover />);

    await user.click(screen.getByTitle('本机窗口（2）'));

    expect(await screen.findByText('Safari')).toBeInTheDocument();
    expect(screen.getByText('MuMuPlayer')).toBeInTheDocument();
    expect(screen.getByText('89')).toBeInTheDocument();
    expect(screen.getByText('1200×800')).toBeInTheDocument();
    expect(screen.getByText('已绑定')).toBeInTheDocument(); // 89 已连接

    await user.click(screen.getByText('MuMuPlayer').closest('button') as HTMLButtonElement);
    expect(connect).toHaveBeenCalledWith('macos:42', 'Mac:///?window=42');
  });

  it('本机窗口 Tab（Windows）：句柄按十六进制展示，点行用窗口 deviceId + 绑定 URI 连接', async () => {
    const user = userEvent.setup();
    const connect = vi.fn(() => Promise.resolve(true));
    useSessionStore.setState({ connect });
    vi.mocked(windowList).mockResolvedValue({
      platform: 'win32',
      allowed: true,
      note: '1 个可选窗口',
      windows: [
        {
          handle: 6698742,
          hwnd: 6698742,
          pid: 12345,
          process: 'Game.exe',
          app: 'Game.exe',
          title: '某游戏 - 窗口',
          class: 'UnityWndClass',
          label: 'Game.exe — 某游戏 - 窗口',
          x: 100,
          y: 80,
          width: 1280,
          height: 720,
          clientWidth: 1280,
          clientHeight: 700,
          minimized: false,
          uri: 'Windows:///?hwnd=6698742',
          deviceId: 'windows:6698742',
        },
      ],
    });
    open([ANDROID, WINDOWS_PICKER, WINDOWS_WINDOW]);
    render(<DevicePopover />);

    await user.click(screen.getByTitle('本机窗口（2）'));

    expect(await screen.findByText('0x6636F6')).toBeInTheDocument();
    expect(screen.getByText('Game.exe')).toBeInTheDocument();
    expect(screen.getByText('1280×700')).toBeInTheDocument();

    await user.click(screen.getByText('Game.exe').closest('button') as HTMLButtonElement);
    expect(connect).toHaveBeenCalledWith('windows:6698742', 'Windows:///?hwnd=6698742&post=global');
  });

  it('本机窗口 Tab 支持搜索（进程 / App / 标题 / 句柄）', async () => {
    const user = userEvent.setup();
    open([ANDROID, MAC_PICKER]);
    render(<DevicePopover />);

    await user.click(screen.getByTitle('本机窗口（1）'));
    await screen.findByText('Safari');

    await user.type(screen.getByPlaceholderText('搜进程 / App 名 / 窗口标题 / 句柄'), '89');
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
