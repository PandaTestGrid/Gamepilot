import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowRunStrip } from '@/features/graph/flow/FlowRunStrip';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

describe('画布运行条：切 Tab 时「运行中」前面转圈', () => {
  beforeEach(() => {
    useDeviceStore.setState({
      devices: [
        {
          id: 'dev-1',
          name: '测试机',
          kind: 'android',
          uri: 'Android://127.0.0.1:5037/dev-1',
          resolution: [1080, 1920],
          fps: 20,
          status: 'connected',
        },
      ],
      activeId: 'dev-1',
    });
    useSessionStore.setState({
      running: { 'dev-1': true },
      runningWorkflowRoots: { 'dev-1': ['/p/甲/斗技'] },
      currentWorkflow: {
        root: '/p/甲/斗技',
        graphPath: '/p/甲/斗技/graph.json',
        nodes: 0,
        edges: 0,
        recognizers: 0,
        templates: 0,
      },
      switchingWorkflow: false,
      holdRunningDuringSwitch: false,
    });
  });

  it('正在跑、没在切换：设备名 · 运行中，不转圈', () => {
    render(<FlowRunStrip />);
    expect(screen.getByText('测试机 · 运行中')).toBeInTheDocument();
    expect(screen.queryByText(/运行中不能改流程图/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-busy-spinner')).not.toBeInTheDocument();
  });

  it('切工作流时「运行中」前面出现 loading', () => {
    useSessionStore.setState({ switchingWorkflow: true, holdRunningDuringSwitch: true });
    render(<FlowRunStrip />);
    expect(screen.getByText('测试机 · 运行中')).toBeInTheDocument();
    expect(screen.getByTestId('run-busy-spinner')).toBeInTheDocument();
  });

  it('热重载已经把 running 清掉：仍显示转圈的运行中', () => {
    useSessionStore.setState({
      running: { 'dev-1': false },
      switchingWorkflow: true,
      holdRunningDuringSwitch: true,
    });
    render(<FlowRunStrip />);
    expect(screen.getByText('测试机 · 运行中')).toBeInTheDocument();
    expect(screen.getByTestId('run-busy-spinner')).toBeInTheDocument();
  });

  it('enterWorkflowSwitch 会记住切入前正在跑', () => {
    useSessionStore.getState().enterWorkflowSwitch();
    expect(useSessionStore.getState()).toMatchObject({
      switchingWorkflow: true,
      holdRunningDuringSwitch: true,
    });
    useSessionStore.setState({ running: { 'dev-1': false } });
    expect(useSessionStore.getState().holdRunningDuringSwitch).toBe(true);
    useSessionStore.getState().leaveWorkflowSwitch();
    expect(useSessionStore.getState()).toMatchObject({
      switchingWorkflow: false,
      holdRunningDuringSwitch: false,
    });
  });
});
