import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceTabs } from '@/layout/DeviceTabs';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import type { DeviceRuntime } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock('@/lib/windows', () => ({ openPaneWindow: vi.fn() }));

const MUMU: DeviceRuntime = {
  id: 'dev-a',
  name: 'MuMu',
  kind: 'emulator',
  uri: 'Android://127.0.0.1:7555/dev-a',
  resolution: [1080, 1920],
  fps: 20,
  status: 'connected',
};

const PHONE: DeviceRuntime = {
  id: 'dev-b',
  name: 'SM-G9980',
  kind: 'android',
  uri: 'Android://127.0.0.1:5037/dev-b',
  resolution: [1080, 1920],
  fps: 18,
  status: 'connected',
};

describe('顶部设备标签：哪台在执行哪份工作流', () => {
  beforeEach(() => {
    useDeviceStore.setState({ devices: [MUMU, PHONE], activeId: PHONE.id });
    useSessionStore.setState({
      running: { [MUMU.id]: true },
      runningWorkflowRoots: { [MUMU.id]: ['/p/甲/斗技'] },
    });
  });

  it('正在执行的设备标工作流名；空闲设备仍显示 fps', () => {
    render(<DeviceTabs />);

    expect(screen.getByText('MuMu').className).toContain('truncate');
    expect(screen.getByTestId('device-tab-dev-a')).toHaveTextContent('斗技');
    expect(screen.getByTestId('device-tab-dev-a').querySelector('button')?.getAttribute('title')).toContain(
      'MuMu · 运行中 · 斗技',
    );
    expect(screen.getByTestId('device-tab-dev-b')).toHaveTextContent('fps');
    expect(screen.getByTestId('device-tab-dev-b')).not.toHaveTextContent('斗技');
    expect(screen.getByText('2 台已连接 · 1 台在执行')).toBeInTheDocument();
    expect(screen.queryByText(/台运行中/)).not.toBeInTheDocument();
  });

  it('点正在执行的设备：跳到那台设备和它正在跑的脚本', async () => {
    const user = userEvent.setup();
    const switchWorkflow = vi.fn(() => Promise.resolve());
    useSessionStore.setState({
      currentWorkflow: {
        root: '/p/甲/百鬼',
        graphPath: '/p/甲/百鬼/graph.json',
        nodes: 0,
        edges: 0,
        recognizers: 0,
        templates: 0,
      },
      switchWorkflow,
    });
    render(<DeviceTabs />);

    await user.click(screen.getByText('MuMu'));
    expect(useDeviceStore.getState().activeId).toBe(MUMU.id);
    expect(switchWorkflow).toHaveBeenCalledWith('/p/甲/斗技');
  });
});
