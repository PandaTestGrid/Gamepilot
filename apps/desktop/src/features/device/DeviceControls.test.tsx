/**
 * 设备控制条（投屏下面那条）—— **只放设备按键**。
 *
 * 这里守三件事：
 *   1. 没连上时按键灰掉并在 title 里说明原因（不搞"点了没反应"）；
 *   2. 连上后按键真的发出去（back / home / recents / power）；
 *   3. **按键随平台变**：iOS 只有主页 + 电源（引擎里 back/recents 其实都映射成 Home），
 *      macOS 本机窗口一个都没有 —— 不再摆一排点了必报错的按钮。
 *
 * 「控制」「录操作」两个开关已经搬到面板头了（见 ScreenPane.test.tsx），
 * 这条里**不该**再出现它们 —— 下面有一条反向断言守着。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceControls } from '@/features/device/DeviceControls';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { DeviceKind } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const DEVICE = 'mock:1';

function renderBar(kind: DeviceKind = 'android'): ReturnType<typeof render> {
  return render(<DeviceControls deviceId={DEVICE} deviceName="Mock 合成设备" kind={kind} />);
}

describe('设备控制条（设备按键）', () => {
  beforeEach(() => {
    useSessionStore.setState({ ready: {}, running: {} });
    useUiStore.setState({ controlMode: true, recordActionMode: false });
  });

  it('设备没连上：按键灰掉，title 说明原因（不搞"点了没反应"）', async () => {
    const user = userEvent.setup();
    const pressKey = vi.fn(() => Promise.resolve());
    useSessionStore.setState({ pressKey });
    renderBar();

    const back = screen.getByText('返回').closest('button');
    expect(back).toBeDisabled();
    expect(back).toHaveAttribute('title', expect.stringContaining('未连接'));

    await user.click(back as HTMLButtonElement);
    expect(pressKey).not.toHaveBeenCalled();
  });

  it('Android：返回 / 桌面 / 最近任务 分别发 back / home / recents', async () => {
    const user = userEvent.setup();
    const pressKey = vi.fn(() => Promise.resolve());
    useSessionStore.setState({ ready: { [DEVICE]: true }, pressKey });
    renderBar('android');

    for (const [label, key] of [
      ['返回', 'back'],
      ['桌面', 'home'],
      ['最近任务', 'recents'],
    ] as const) {
      const button = screen.getByText(label).closest('button');
      expect(button).toBeEnabled();
      await user.click(button as HTMLButtonElement);
      expect(pressKey).toHaveBeenLastCalledWith(DEVICE, key);
    }
  });

  it('iOS：只有「主页」，没有返回/最近任务（引擎把那两个也映射成 Home）', async () => {
    const user = userEvent.setup();
    const pressKey = vi.fn(() => Promise.resolve());
    useSessionStore.setState({ ready: { [DEVICE]: true }, pressKey });
    renderBar('ios');

    expect(screen.getByText('主页')).toBeInTheDocument();
    expect(screen.queryByText('返回')).toBeNull();
    expect(screen.queryByText('最近任务')).toBeNull();
    expect(screen.queryByText('桌面')).toBeNull();

    await user.click(screen.getByText('主页').closest('button') as HTMLButtonElement);
    expect(pressKey).toHaveBeenLastCalledWith(DEVICE, 'home');
  });

  it('macOS 本机窗口：一个按键都不摆，并说清为什么（点下去只会报"不支持"）', () => {
    useSessionStore.setState({ ready: { [DEVICE]: true } });
    renderBar('windows');

    expect(screen.queryByText('返回')).toBeNull();
    expect(screen.getByText(/没有实体导航键/)).toBeInTheDocument();
  });

  it('「控制」「录操作」「电源」都不在这条里（开关在面板头，电源也在面板头）', () => {
    useSessionStore.setState({ ready: { [DEVICE]: true } });
    renderBar();

    expect(screen.queryByText('控制')).toBeNull();
    expect(screen.queryByText('录操作')).toBeNull();
    expect(screen.queryByText('+等1s')).toBeNull();
    expect(screen.queryByText('电源')).toBeNull();
  });

  it('按键是**居中**的：三栏网格（两侧等宽留白），提示不参与居中', () => {
    useSessionStore.setState({ ready: { [DEVICE]: true } });
    renderBar();

    const bar = screen.getByTestId('device-controls');
    expect(bar.className).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]');
    // 中间那栏才是按键，左右各一栏（右栏放提示）
    expect(bar.children).toHaveLength(3);
    const middle = bar.children[1] as HTMLElement;
    expect(middle).toContainElement(screen.getByText('返回'));
  });
});
