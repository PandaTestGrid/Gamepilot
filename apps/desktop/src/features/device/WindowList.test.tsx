/**
 * 「本机窗口」选择器（WindowList）的交互测试。
 *
 * 覆盖的每条都是用户在 Windows / macOS 上真会碰到的：
 *   - win32 句柄按 0x 十六进制展示，点行直接用窗口自带的 deviceId + URI 连接；
 *   - 输入方式只保留「前台 / 后台」两档（`post=global` / `post=sync`）；
 *   - 手输 `0x1A2B` 能换算成十进制拼 `Windows:///?hwnd=6699`；
 *   - 平台不允许（macOS 缺屏幕录制权限）时把原因讲清楚；
 *   - 已绑定的窗口点一下 = 切过去，而不是重连。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WindowList, withPostMode } from '@/features/device/WindowList';
import { windowList, type WindowListResult } from '@/lib/rpc';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock('@/lib/rpc', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, windowList: vi.fn() };
});

const WIN32_RESULT: WindowListResult = {
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
};

const DARWIN_RESULT: WindowListResult = {
  platform: 'darwin',
  allowed: true,
  note: '1 个可选窗口',
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
      clientWidth: 1200,
      clientHeight: 780,
      uri: 'Mac:///?window=89',
      deviceId: 'macos:89',
    },
  ],
};

function setup(result: WindowListResult): {
  connect: ReturnType<typeof vi.fn>;
  activate: ReturnType<typeof vi.fn>;
} {
  vi.mocked(windowList).mockResolvedValue(result);
  const connect = vi.fn();
  const activate = vi.fn();
  render(<WindowList connected={new Set<string>()} onConnect={connect} onActivate={activate} />);
  return { connect, activate };
}

describe('本机窗口选择器', () => {
  beforeEach(() => {
    vi.mocked(windowList).mockReset();
  });

  it('Windows：句柄按 0x 展示，点行用 item.deviceId + 绑定 URI 连接（默认前台 SendInput）', async () => {
    const user = userEvent.setup();
    const { connect } = setup(WIN32_RESULT);

    expect(await screen.findByText('0x6636F6')).toBeInTheDocument();
    expect(screen.getByText('Game.exe')).toBeInTheDocument();
    expect(screen.getByText('1280×700')).toBeInTheDocument();

    await user.click(screen.getByText('Game.exe').closest('button') as HTMLButtonElement);
    expect(connect).toHaveBeenCalledWith('windows:6698742', 'Windows:///?hwnd=6698742&post=global');
  });

  it('Windows：选「后台」后连接 URI 带 post=sync（同步消息，游戏后台控制走它）', async () => {
    const user = userEvent.setup();
    const { connect } = setup(WIN32_RESULT);
    await screen.findByText('Game.exe');

    await user.click(screen.getByRole('button', { name: '后台' }));
    await user.click(screen.getByText('Game.exe').closest('button') as HTMLButtonElement);

    expect(connect).toHaveBeenCalledWith('windows:6698742', 'Windows:///?hwnd=6698742&post=sync');
  });

  it('Windows：输入方式只保留「前台 / 后台」两档', async () => {
    setup(WIN32_RESULT);
    await screen.findByText('Game.exe');

    expect(screen.getByRole('button', { name: '前台' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '后台' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '兼容' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '后台+光标' })).not.toBeInTheDocument();
  });

  it('已绑定的窗口切输入方式 = 就地重连（否则用户会以为切了没生效）', async () => {
    const user = userEvent.setup();
    vi.mocked(windowList).mockResolvedValue(WIN32_RESULT);
    const onReconnect = vi.fn();
    render(
      <WindowList
        connected={new Set(['windows:6698742'])}
        activeDeviceId="windows:6698742"
        onConnect={vi.fn()}
        onReconnect={onReconnect}
        onActivate={vi.fn()}
      />,
    );
    await screen.findByText('Game.exe');

    await user.click(screen.getByRole('button', { name: '后台' }));

    expect(onReconnect).toHaveBeenCalledWith('windows:6698742', 'Windows:///?hwnd=6698742&post=sync');
  });

  it('Windows：手输 0x1A2B 换算成十进制，拼 Windows URI 后连接', async () => {
    const user = userEvent.setup();
    const { connect } = setup(WIN32_RESULT);
    await screen.findByText('Game.exe');

    const input = screen.getByLabelText('窗口句柄');
    await user.type(input, '0x1A2B');
    await user.click(screen.getByRole('button', { name: '连接' }));

    expect(connect).toHaveBeenCalledWith('windows:6699', 'Windows:///?hwnd=6699&post=global');
  });

  it('macOS 缺屏幕录制权限：说明原因并给出系统设置路径', async () => {
    vi.mocked(windowList).mockResolvedValue({
      platform: 'darwin',
      allowed: false,
      note: '缺少「屏幕录制」权限：能连上，但抓到的画面是空白',
      windows: [],
    });
    render(<WindowList connected={new Set<string>()} onConnect={vi.fn()} onActivate={vi.fn()} />);

    expect(await screen.findByText(/缺少「屏幕录制」权限/)).toBeInTheDocument();
    expect(screen.getByText(/系统设置 → 隐私与安全性 → 屏幕录制/)).toBeInTheDocument();
  });

  it('已绑定的窗口点一下 = 切过去（不重连），并标「已绑定」', async () => {
    const user = userEvent.setup();
    vi.mocked(windowList).mockResolvedValue(DARWIN_RESULT);
    const connect = vi.fn();
    const activate = vi.fn();
    render(<WindowList connected={new Set(['macos:89'])} onConnect={connect} onActivate={activate} />);

    expect(await screen.findByText('已绑定')).toBeInTheDocument();
    await user.click(screen.getByText('Safari').closest('button') as HTMLButtonElement);

    expect(activate).toHaveBeenCalledWith('macos:89');
    expect(connect).not.toHaveBeenCalled();
  });

  it('刷新按钮重新枚举窗口（新开的 App 要刷新才出现）', async () => {
    const user = userEvent.setup();
    setup(WIN32_RESULT);
    await screen.findByText('Game.exe');
    expect(windowList).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(windowList).toHaveBeenCalledTimes(2));
  });

  it('withPostMode：重复切换不会叠加，旧 cursor / post 参数会被清掉', () => {
    const base = 'Windows:///?hwnd=6698742';
    expect(withPostMode(base, 'global')).toBe('Windows:///?hwnd=6698742&post=global');
    expect(withPostMode(withPostMode(base, 'sync'), 'global')).toBe('Windows:///?hwnd=6698742&post=global');
    // 手写 URI 里的进阶参数（hybrid/cursor）在界面切档时也要清掉
    expect(withPostMode('Windows:///?hwnd=6698742&post=hybrid&cursor=1', 'sync')).toBe(
      'Windows:///?hwnd=6698742&post=sync',
    );
  });
});
