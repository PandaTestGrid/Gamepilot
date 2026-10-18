import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { LAYOUT_PRESETS } from '@/layout/layout-specs';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

// 渲染测试不启动 Tauri：只验证主壳真的能挂载，且空态有明确引导
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

describe('主壳渲染', () => {
  it('顶部条、三栏、底栏都在；中间那栏是当前工作流', () => {
    render(<App />);

    // 顶部条 = 设备标签 + 布局 + 引擎状态（整排独立工具栏已去掉）
    expect(screen.getByText('布局')).toBeInTheDocument();
    expect(screen.queryByText('录制')).not.toBeInTheDocument();
    expect(screen.getByText('画面')).toBeInTheDocument();
    // 中间那栏 = 当前工作流（IDE 编辑器风格：标签 + 左托盘 + 画布 + 下方详情坞）
    expect(screen.getAllByText('工作流').length).toBeGreaterThan(0);
    expect(screen.getByTestId('flow-canvas-wrap')).toBeInTheDocument();
    // 不再有「界面图 / 步骤链」那种来回切的模式
    expect(screen.queryByText('步骤链')).toBeNull();
    // 右栏只剩「工作区」；识别器/素材在画面下方的「素材区」；
    // 事件流搬到了底部调试抽屉，Tab 名是「事件流」
    expect(screen.getByTestId('workspace-region')).toBeInTheDocument();
    expect(screen.getByText('素材区')).toBeInTheDocument();
    expect(screen.getByText('事件流')).toBeInTheDocument();

    // 底栏指标
    expect(screen.getByText('tick')).toBeInTheDocument();
    expect(screen.getByText('fps')).toBeInTheDocument();
  });

  it('没有设备时首屏给出三步引导，不再出现假设备', () => {
    render(<App />);

    expect(screen.getByText('还没有连接设备')).toBeInTheDocument();
    expect(screen.getByText(/点下面列表里的一台设备/)).toBeInTheDocument();
    expect(screen.queryByText('SM-G9980')).not.toBeInTheDocument();
    expect(screen.queryByText('MuMu Player 12')).not.toBeInTheDocument();
  });
});

describe('可拖拽布局（回归：以前只有左右能拖，上下拖不动）', () => {
  it('横向与纵向都有分隔线：三栏拖宽度，栏内拖高度', () => {
    render(<App />);

    const separators = screen.getAllByRole('separator');
    // 横向 Group 的分隔线是竖线（aria-orientation=vertical）：画面|中间区|右栏 两条
    const vertical = separators.filter((node) => node.getAttribute('aria-orientation') === 'vertical');
    // 纵向 Group 的分隔线是横线（aria-orientation=horizontal）：
    // 画面/素材区、画布/编辑区、事件/识别器 三条
    const horizontal = separators.filter((node) => node.getAttribute('aria-orientation') === 'horizontal');

    expect(vertical).toHaveLength(2);
    expect(horizontal).toHaveLength(3);
    // 每条线都要能拖：库只给"有 role=separator 的元素"装指针/键盘处理
    for (const node of separators) {
      expect(node).toHaveAttribute('tabindex');
    }
  });

  it('右栏只剩「工作区」一个 Tab（识别器/素材搬到画面下方的素材区了）', () => {
    render(<App />);

    expect(screen.getByTestId('workspace-region')).toBeInTheDocument();
    // 识别器那套在画面下方：素材区
    expect(screen.getByText('素材区')).toBeInTheDocument();
    expect(screen.queryByText('阈值拖动即时重算当前帧分数')).toBeNull();
  });

  it('画布编辑区常驻但默认收起成提示条，避免白占画布高度', () => {
    render(<App />);

    expect(screen.getAllByText(/点画布上的模块/).length).toBeGreaterThan(0);
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

  it('导航键贴在投屏下面（居中）；「控制 / 多开 / 电源」留在画面栏头，「框选 / 点选 / 录操作」收进下方工作流详情坞', () => {
    render(<App />);

    const bar = screen.getByTestId('device-controls');
    // 按键属于"画面"那一格（跟着投屏一起被上下拖），不是面板头
    expect(bar.closest('[data-panel]')?.id).toBe('view');
    const section = bar.closest('section');
    expect(section?.firstElementChild?.contains(bar)).toBe(false);

    // 这条只剩**导航键**（居中摆，像手机下面那排）
    for (const label of ['返回', '桌面', '最近任务']) {
      expect(within(bar).getByText(label)).toBeInTheDocument();
    }
    // 开关和电源都不是导航键
    expect(within(bar).queryByText('控制')).not.toBeInTheDocument();
    expect(within(bar).queryByText('录操作')).not.toBeInTheDocument();
    expect(within(bar).queryByText('电源')).not.toBeInTheDocument();

    // 会话还没就绪时按键是灰的，并把原因写在 title 里（不是点了没反应）
    expect(within(bar).getByText('返回').closest('button')).toBeDisabled();
    expect(within(bar).getByText('返回').closest('button')).toHaveAttribute(
      'title',
      expect.stringContaining('未连接'),
    );

    // 画面栏面板头：只留设备控制相关的单行按钮（控制 / 多开 / 电源），不再挤下录制按钮
    const header = section?.firstElementChild as HTMLElement;
    expect(within(header).getByText('控制')).toBeInTheDocument();
    expect(within(header).getByText('电源')).toBeInTheDocument();
    expect(within(header).queryByText('框选')).not.toBeInTheDocument();
    expect(within(header).queryByText('录操作')).not.toBeInTheDocument();
    expect(within(header).queryByText('返回')).not.toBeInTheDocument();

    // 录制工具（框选 / 点选 / 录操作）统一放在工作流下方详情坞（「配置」前面，全部为图标按钮）
    // 设备未连接时三个录制按钮均禁用并提示未连接原因
    for (const testId of ['dock-record-marquee', 'dock-record-pick', 'dock-record-action']) {
      const btn = screen.getByTestId(testId);
      expect(btn).toBeInTheDocument();
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', expect.stringContaining('未连接'));
    }
  });

  it('框选 / 点选 / 录操作三者互斥，不能同时开启', () => {
    useDeviceStore.setState({ activeId: 'android:3387980' });
    useSessionStore.setState({
      ready: { 'android:3387980': true },
      currentWorkflow: {
        root: '/p/甲/斗技',
        graphPath: '/p/甲/斗技/graph.json',
        nodes: 0,
        edges: 0,
        recognizers: 0,
        templates: 0,
      },
    });
    render(<App />);

    const marqueeBtn = screen.getByTestId('dock-record-marquee');
    const pickBtn = screen.getByTestId('dock-record-pick');
    const actionBtn = screen.getByTestId('dock-record-action');

    fireEvent.click(marqueeBtn);
    expect(useUiStore.getState().recordMode).toBe('marquee');
    expect(useUiStore.getState().recordActionMode).toBe(false);

    fireEvent.click(actionBtn);
    expect(useUiStore.getState().recordActionMode).toBe(true);
    expect(useUiStore.getState().recordMode).toBe('off');

    fireEvent.click(pickBtn);
    expect(useUiStore.getState().recordMode).toBe('pick');
    expect(useUiStore.getState().recordActionMode).toBe(false);
  });

  it('框选 / 点选 / 录操作：点到画面和工具栏以外（或 Esc）就关掉', () => {
    useDeviceStore.setState({ activeId: 'android:3387980' });
    useSessionStore.setState({
      ready: { 'android:3387980': true },
      currentWorkflow: {
        root: '/p/甲/斗技',
        graphPath: '/p/甲/斗技/graph.json',
        nodes: 0,
        edges: 0,
        recognizers: 0,
        templates: 0,
      },
    });
    render(<App />);

    const marqueeBtn = screen.getByTestId('dock-record-marquee');
    fireEvent.click(marqueeBtn);
    expect(useUiStore.getState().recordMode).toBe('marquee');

    fireEvent.pointerDown(marqueeBtn);
    expect(useUiStore.getState().recordMode).toBe('marquee');

    fireEvent.pointerDown(screen.getByTestId('flow-canvas-wrap'));
    expect(useUiStore.getState().recordMode).toBe('off');

    fireEvent.click(screen.getByTestId('dock-record-action'));
    expect(useUiStore.getState().recordActionMode).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().recordActionMode).toBe(false);
  });
});
