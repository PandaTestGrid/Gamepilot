import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppStartupScreen } from '@/layout/AppStartupScreen';

describe('AppStartupScreen', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.getElementById('cold-start-splash')?.remove();
  });

  it('冷启动只展示一次品牌标识和引擎 Loading，不挂载主工作台', () => {
    vi.useFakeTimers();
    render(<AppStartupScreen status="idle" info="未连接引擎" onRetry={vi.fn()} onRestart={vi.fn()} />);

    expect(screen.getByTestId('app-loading-screen')).toBeInTheDocument();
    expect(screen.getAllByTestId('app-mark')).toHaveLength(1);
    expect(screen.getByText('正在启动引擎')).toBeInTheDocument();
    expect(screen.getByText('工作台会在引擎启动后自动进入。')).toBeInTheDocument();
    expect(screen.queryByText('扫描设备与工作区')).not.toBeInTheDocument();
    expect(screen.queryByText('恢复工作台')).not.toBeInTheDocument();
  });

  it('引擎启动中保留 Loading 并显示真实状态，不展示工作台入口', () => {
    vi.useFakeTimers();
    render(
      <AppStartupScreen
        status="connecting"
        info="正在启动 Python 引擎"
        onRetry={vi.fn()}
        onRestart={vi.fn()}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.getByText('正在启动引擎')).toBeInTheDocument();
    expect(screen.getByText('工作台会在引擎启动后自动进入。')).toBeInTheDocument();
    expect(screen.queryByText('布局')).not.toBeInTheDocument();
  });

  it('启动失败时提供原因与两个恢复动作', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const onRestart = vi.fn();
    render(
      <AppStartupScreen status="error" info="引擎启动后立刻退出" onRetry={onRetry} onRestart={onRestart} />,
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.getByText('引擎启动失败')).toBeInTheDocument();
    expect(screen.getByText('引擎启动后立刻退出')).toBeInTheDocument();
    expect(screen.getByText('引擎未就绪，工作台尚未加载。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    fireEvent.click(screen.getByRole('button', { name: '重启引擎' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRestart).toHaveBeenCalledOnce();
  });
});
