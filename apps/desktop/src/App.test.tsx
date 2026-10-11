import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { LAYOUT_PRESETS } from '@/layout/layout-specs';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';

// 渲染测试不启动 Tauri：只验证主壳真的能挂载，且空态有明确引导
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

/** 「运行 / 停止」按钮：顶栏一个、状态图头一个（同一个开关）。
 *  按按钮过滤而不是按文字：底栏也有一格写着"停止"（是 <span>，不是入口）。 */
function runButtons(): HTMLButtonElement[] {
  return screen
    .getAllByRole<HTMLButtonElement>('button')
    .filter((node) => /^(运行|停止)$/.test((node.textContent ?? '').trim()));
}

describe('主壳渲染', () => {
  it('工具栏、三栏、底栏都在，且运行按钮在没设备时是禁用的', () => {
    render(<App />);

    expect(screen.getByText('GamePilot')).toBeInTheDocument();
    expect(screen.getByText('录制')).toBeInTheDocument();

    expect(screen.getByText('画面')).toBeInTheDocument();
    expect(screen.getByText('状态图')).toBeInTheDocument();
    // 右栏 = Tab（脚本库 / 识别器）；事件流搬到了底部调试抽屉，Tab 名是「事件流」
    expect(screen.getByText('脚本库')).toBeInTheDocument();
    expect(screen.getByText('识别器')).toBeInTheDocument();
    expect(screen.getByText('事件流')).toBeInTheDocument();

    // 底栏指标
    expect(screen.getByText('tick')).toBeInTheDocument();
    expect(screen.getByText('fps')).toBeInTheDocument();

    // 运行按钮必须给出"为什么现在不能跑"的理由，而不是点了没反应
    const runs = runButtons();
    expect(runs).toHaveLength(2);
    for (const button of runs) {
      expect(button).toBeDisabled();
    }
  });

  it('没有设备时首屏给出三步引导，不再出现假设备', () => {
    render(<App />);

    expect(screen.getByText('还没有连接设备')).toBeInTheDocument();
    expect(screen.getByText(/点下面的「连接设备」/)).toBeInTheDocument();
    expect(screen.queryByText('SM-G9980')).not.toBeInTheDocument();
    expect(screen.queryByText('MuMu Player 12')).not.toBeInTheDocument();
  });
});

describe('运行入口：顶栏 + 状态图头，同一个开关', () => {
  it('没设备时两处都禁用，且说的是同一句原因', () => {
    useDeviceStore.setState({ devices: [], activeId: '' });
    render(<App />);

    const runs = runButtons();
    expect(runs).toHaveLength(2); // 顶栏一个、状态图头部一个
    const titles = runs.map((button) => button.getAttribute('title') ?? '');
    for (const title of titles) {
      expect(title).toContain('先在设备面板');
    }
    // 同一份原因（lib/useRunControl.ts），不是两处各写一套
    expect(new Set(titles).size).toBe(1);
  });

  it('设备连上但图里没节点时，两处都指向"先去框选录制"', () => {
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
    });
    render(<App />);

    const titles = runButtons().map((button) => button.getAttribute('title') ?? '');
    expect(titles).toHaveLength(2);
    for (const title of titles) {
      expect(title).toContain('状态图里还没有节点');
    }
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

  it('右栏 Tab：默认脚本库（多状态图入口），切到识别器看阈值', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<App />);

    // 默认 Tab = 脚本库：能看出"一个目录 = 一张状态图"这条规则
    expect(screen.getByText('一个目录 = 一张状态图')).toBeInTheDocument();

    await user.click(screen.getByText('识别器', { selector: 'button' }));

    expect(screen.getByText('阈值拖动即时重算当前帧分数')).toBeInTheDocument();
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

  it('设备控制键贴在投屏下面（不在面板头）：返回 / 桌面 / 最近任务 / 电源 + 控制 / 录操作', () => {
    render(<App />);

    const bar = screen.getByTestId('device-controls');
    // 它属于"画面"那一格（跟着投屏一起被上下拖），不是面板头
    expect(bar.closest('[data-panel]')?.id).toBe('view');
    const section = bar.closest('section');
    expect(section?.firstElementChild?.contains(bar)).toBe(false);

    for (const label of ['返回', '桌面', '最近任务', '电源', '控制', '录操作']) {
      expect(within(bar).getByText(label)).toBeInTheDocument();
    }

    // 会话还没就绪时按钮是灰的，并把原因写在 title 里（不是点了没反应）
    expect(within(bar).getByText('返回').closest('button')).toBeDisabled();
    expect(within(bar).getByText('返回').closest('button')).toHaveAttribute(
      'title',
      expect.stringContaining('未连接'),
    );

    // 面板头只留面板自己的工具：框选 / 点选 / 多开 / 读数
    const header = section?.firstElementChild as HTMLElement;
    expect(within(header).getByText('框选')).toBeInTheDocument();
    expect(within(header).queryByText('返回')).not.toBeInTheDocument();
  });
});
