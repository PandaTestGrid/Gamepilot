import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { App } from '@/App';

// 渲染测试不启动 Tauri：只验证主壳（工具栏 / 三栏 / 底栏 / 设备标签条）真的能挂载
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

describe('主壳渲染', () => {
  it('工具栏、设备标签条、三栏与底栏都渲染出来', () => {
    render(<App />);

    expect(screen.getByText('GamePilot')).toBeInTheDocument();
    expect(screen.getByText('运行')).toBeInTheDocument();
    expect(screen.getByText('录制')).toBeInTheDocument();

    expect(screen.getByText('画面')).toBeInTheDocument();
    expect(screen.getByText('状态图')).toBeInTheDocument();
    expect(screen.getByText('事件')).toBeInTheDocument();
    expect(screen.getByText('识别器')).toBeInTheDocument();

    // 设备标签条：默认两台已连接设备（mock）
    expect(screen.getByText('SM-G9980')).toBeInTheDocument();
    expect(screen.getByText('MuMu Player 12')).toBeInTheDocument();

    // 底栏指标
    expect(screen.getByText('tick')).toBeInTheDocument();
    expect(screen.getByText('fps')).toBeInTheDocument();
  });

  it('录制产生的识别器会同时出现在画面栏读数与识别器面板', () => {
    render(<App />);
    // mock 数据里已有一个确认态识别器；两处都会渲染它
    expect(screen.getAllByText('main_start').length).toBeGreaterThanOrEqual(2);
  });
});
