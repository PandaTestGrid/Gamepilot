import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphToolbar } from '@/features/graph/GraphToolbar';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import type { DeviceRuntime } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const MUMU: DeviceRuntime = {
  id: 'dev-a',
  name: 'MuMu',
  kind: 'emulator',
  uri: 'Android://127.0.0.1:7555/dev-a',
  resolution: [1080, 1920],
  fps: 20,
  status: 'connected',
};

describe('工作流头部', () => {
  beforeEach(() => {
    useDeviceStore.setState({ devices: [MUMU], activeId: MUMU.id });
    useSessionStore.setState({
      currentWorkflow: {
        root: '/p/甲/斗技',
        graphPath: '/p/甲/斗技/graph.json',
        nodes: 0,
        edges: 0,
        recognizers: 0,
        templates: 0,
      },
      running: { [MUMU.id]: true },
      runningWorkflowRoots: { [MUMU.id]: ['/p/甲/斗技'] },
      switchingWorkflow: false,
      switchingWorkflowRoot: '',
      holdRunningDuringSwitch: false,
    });
  });

  it('丢失运行态时仍能直接向引擎停止当前工作流', () => {
    const stopRun = vi.fn(() => Promise.resolve());
    const original = useSessionStore.getState().stopRun;
    useSessionStore.setState({ running: {}, runningWorkflowRoots: {}, stopRun });
    try {
      render(<GraphToolbar />);
      const stop = screen.getByTitle('停止当前工作流（即使界面未显示运行状态，也向引擎发送停止请求）');
      expect(stop).not.toBeDisabled();
      fireEvent.click(stop);
      expect(stopRun).toHaveBeenCalledWith(MUMU.id);
    } finally {
      useSessionStore.setState({ stopRun: original });
    }
  });

  it('已知运行中即使设备扫描滞后或图为空也不能禁用停止', () => {
    useDeviceStore.setState({ devices: [{ ...MUMU, status: 'discovered' }] });
    render(<GraphToolbar />);
    expect(screen.getByTitle('停止（MuMu）')).not.toBeDisabled();
  });

  it('运行中也不在头部画设备/脚本归属', () => {
    render(<GraphToolbar />);
    expect(screen.queryByTestId('flow-run-attribution')).not.toBeInTheDocument();
    expect(screen.queryByText('MuMu · 斗技')).not.toBeInTheDocument();
    expect(screen.getByTitle('左右分屏（并排查看两个已打开的工作流标签）')).toBeInTheDocument();
  });
});
