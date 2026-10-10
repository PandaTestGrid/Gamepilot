import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { App } from '@/App';

// 渲染测试不启动 Tauri：只验证主壳真的能挂载，且空态有明确引导
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

describe('主壳渲染', () => {
  it('工具栏、三栏、底栏都在，且运行按钮在没设备时是禁用的', () => {
    render(<App />);

    expect(screen.getByText('GamePilot')).toBeInTheDocument();
    expect(screen.getByText('运行')).toBeInTheDocument();
    expect(screen.getByText('录制')).toBeInTheDocument();

    expect(screen.getByText('画面')).toBeInTheDocument();
    expect(screen.getByText('状态图')).toBeInTheDocument();
    expect(screen.getByText('事件')).toBeInTheDocument();
    expect(screen.getByText('识别器')).toBeInTheDocument();

    // 底栏指标
    expect(screen.getByText('tick')).toBeInTheDocument();
    expect(screen.getByText('fps')).toBeInTheDocument();

    // 运行按钮必须给出"为什么现在不能跑"的理由，而不是点了没反应
    expect(screen.getByText('运行').closest('button')).toBeDisabled();
  });

  it('没有设备时首屏给出三步引导，不再出现假设备', () => {
    render(<App />);

    expect(screen.getByText('还没有连接设备')).toBeInTheDocument();
    expect(screen.getByText(/点下面的「连接设备」/)).toBeInTheDocument();
    expect(screen.queryByText('SM-G9980')).not.toBeInTheDocument();
    expect(screen.queryByText('MuMu Player 12')).not.toBeInTheDocument();
  });
});
