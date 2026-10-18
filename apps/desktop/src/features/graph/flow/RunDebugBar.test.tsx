import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RunDebugBar } from '@/features/graph/flow/RunDebugBar';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';

const resumeRun = vi.fn(() => Promise.resolve());
const stepRun = vi.fn(() => Promise.resolve());
const stopRun = vi.fn(() => Promise.resolve());

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

function connectDevice(): void {
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
}

function graphWithStep(id: string, title: string): void {
  useGraphStore.setState({
    graphs: {
      'dev-1': {
        flow: {
          steps: [{ id, type: 'click', title, params: { by: '坐标', x: 0.5, y: 0.5 } }],
        },
      },
    } as never,
  });
}

describe('断点暂停横幅', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectDevice();
    graphWithStep('s2', '点击开始按钮');
    useSessionStore.setState({
      paused: {},
      resumeRun,
      stepRun,
      stopRun,
    });
  });

  it('没暂停时不渲染', () => {
    render(<RunDebugBar />);
    expect(screen.queryByTestId('flow-debug-bar')).not.toBeInTheDocument();
  });

  it('暂停时显示停在哪一步，并能继续 / 单步 / 停止', () => {
    useSessionStore.setState({ paused: { 'dev-1': 's2' } });
    render(<RunDebugBar />);

    expect(screen.getByTestId('flow-debug-bar')).toHaveTextContent('第 1 步');
    expect(screen.getByTestId('flow-debug-bar')).toHaveTextContent('点击');

    fireEvent.click(screen.getByTestId('flow-debug-resume'));
    expect(resumeRun).toHaveBeenCalledWith('dev-1');

    fireEvent.click(screen.getByTestId('flow-debug-step'));
    expect(stepRun).toHaveBeenCalledWith('dev-1');

    fireEvent.click(screen.getByTestId('flow-debug-stop'));
    expect(stopRun).toHaveBeenCalledWith('dev-1');
  });

  it('只读快照里不出现（没有可操作的运行）', () => {
    useSessionStore.setState({ paused: { 'dev-1': 's2' } });
    render(<RunDebugBar readOnly />);
    expect(screen.queryByTestId('flow-debug-bar')).not.toBeInTheDocument();
  });
});
