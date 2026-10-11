import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { LAYOUT_PRESETS } from '@/layout/layout-specs';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';

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

describe('可拖拽布局（回归：以前只有左右能拖，上下拖不动）', () => {
  it('横向与纵向都有分隔线：三栏拖宽度，栏内拖高度', () => {
    render(<App />);

    const separators = screen.getAllByRole('separator');
    // 横向 Group 的分隔线是竖线（aria-orientation=vertical）：画面|状态图|右栏 两条
    const vertical = separators.filter((node) => node.getAttribute('aria-orientation') === 'vertical');
    // 纵向 Group 的分隔线是横线（aria-orientation=horizontal）：
    // 画面/识别读数、画布/编辑区、事件/识别器 三条
    const horizontal = separators.filter((node) => node.getAttribute('aria-orientation') === 'horizontal');

    expect(vertical).toHaveLength(2);
    expect(horizontal).toHaveLength(3);
    // 每条线都要能拖：库只给"有 role=separator 的元素"装指针/键盘处理
    for (const node of separators) {
      expect(node).toHaveAttribute('tabindex');
    }
  });

  it('画布编辑区常驻但默认收起成提示条，避免白占画布高度', () => {
    render(<App />);

    expect(screen.getByText(/点画布上的节点或边/)).toBeInTheDocument();
    expect(screen.queryByText('保存到脚本')).not.toBeInTheDocument();
  });

  it('布局菜单里的每个预设都点得动（面板 id 与预设对不上就会在这里炸）', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<App />);

    await user.click(screen.getByText('布局'));
    for (const preset of LAYOUT_PRESETS) {
      await user.click(screen.getByText(preset.name));
    }
    await user.click(screen.getByText('恢复默认布局'));
  });
});

describe('画面栏渲染（回归：曾经连上了也不出图）', () => {
  it('设备已连接且收到帧时，画面栏一定渲染出 img', () => {
    useDeviceStore.setState({
      devices: [
        {
          id: 'android:3387980',
          name: 'OPPO A57',
          uri: 'Android:///?serial=3387980',
          kind: 'android',
          status: 'connected',
          resolution: [720, 1280],
          fps: 14,
        },
      ],
      activeId: 'android:3387980',
      gridView: false,
    });
    useSessionStore.setState({
      frames: {
        'android:3387980': {
          imageUrl: 'blob:gamepilot/frame',
          index: 42,
          resolution: [720, 1280],
          node: 'home',
          pending: null,
          tick: 42,
          fps: 14,
          captureMs: 0.3,
          detections: [],
          ts: Date.now(),
        },
      },
      links: { 'android:3387980': { channel: 'scrcpy', note: 'scrcpy 720×1280' } },
    });

    render(<App />);

    const image = screen.getByAltText('OPPO A57 实时画面');
    expect(image).toBeInTheDocument();
    expect(image).toHaveAttribute('src', 'blob:gamepilot/frame');
    // 底栏要显示通道，方便一眼看出走的哪条路
    expect(screen.getByText('scrcpy')).toBeInTheDocument();
  });
});
