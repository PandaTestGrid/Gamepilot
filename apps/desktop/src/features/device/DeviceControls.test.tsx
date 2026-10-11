/**
 * 设备控制条（投屏下面那条）的行为测试。
 *
 * 位置由 App.test 里的"在 view 面板内、不在面板头"那条断言守住；
 * 这里守行为：没连上时灰掉并说明原因、连上后按键真的发出去、录操作能录一步等待。
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceControls } from '@/features/device/DeviceControls';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const DEVICE = 'mock:1';

function renderBar(): ReturnType<typeof render> {
  return render(<DeviceControls deviceId={DEVICE} deviceName="Mock 合成设备" />);
}

describe('设备控制条', () => {
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

  it('连上后：返回 / 桌面 / 最近任务 / 电源 分别发 back / home / recents / power', async () => {
    const user = userEvent.setup();
    const pressKey = vi.fn(() => Promise.resolve());
    useSessionStore.setState({ ready: { [DEVICE]: true }, pressKey });
    renderBar();

    for (const [label, key] of [
      ['返回', 'back'],
      ['桌面', 'home'],
      ['最近任务', 'recents'],
      ['电源', 'power'],
    ] as const) {
      const button = screen.getByText(label).closest('button');
      expect(button).toBeEnabled();
      await user.click(button as HTMLButtonElement);
      expect(pressKey).toHaveBeenLastCalledWith(DEVICE, key);
    }
  });

  it('控制开关：切换 ui.store.controlMode，并同步右侧提示', async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ ready: { [DEVICE]: true } });
    renderBar();

    expect(screen.getByText('点画面=轻触 · 拖拽=滑动')).toBeInTheDocument();

    await user.click(screen.getByText('控制'));
    expect(useUiStore.getState().controlMode).toBe(false);
    expect(screen.getByText('控制已关：画面只用于框选/点选')).toBeInTheDocument();
  });

  it('录操作：开着时多出「+等1s」，点一下录一步等待', async () => {
    const user = userEvent.setup();
    const recordStep = vi.fn(() => Promise.resolve('e_1'));
    useSessionStore.setState({ ready: { [DEVICE]: true }, recordStep });
    renderBar();

    expect(screen.queryByText('+等1s')).not.toBeInTheDocument();

    await user.click(screen.getByText('录操作'));
    expect(useUiStore.getState().recordActionMode).toBe(true);

    const bar = screen.getByTestId('device-controls');
    await user.click(within(bar).getByText('+等1s'));
    expect(recordStep).toHaveBeenCalledWith(DEVICE, { type: 'wait', seconds: 1 });
  });
});
