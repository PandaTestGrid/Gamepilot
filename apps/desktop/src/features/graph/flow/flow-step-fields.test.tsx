import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CallStepFields } from '@/features/graph/flow/CallStepFields';
import { ClickStepFields } from '@/features/graph/flow/ClickStepFields';
import { DelayStepFields } from '@/features/graph/flow/DelayStepFields';
import { FlowStepEditor } from '@/features/graph/flow/FlowStepEditor';
import { KeyStepFields } from '@/features/graph/flow/KeyStepFields';
import { SetvarStepFields } from '@/features/graph/flow/SetvarStepFields';
import { SwipeStepFields } from '@/features/graph/flow/SwipeStepFields';
import { TextStepFields } from '@/features/graph/flow/TextStepFields';
import { SCRIPT_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

describe('SwipeStepFields 录制', () => {
  it('默认点对点：只显示单次录制，切到连续时写入 swipe_mode', () => {
    const beginRecordSwipe = vi.fn();
    const onPatch = vi.fn();
    const original = useUiStore.getState().beginRecordSwipeForFlowStep;
    useUiStore.setState({ beginRecordSwipeForFlowStep: beginRecordSwipe });
    try {
      render(
        <SwipeStepFields
          stepId="sw0"
          params={{ x: 0.5, y: 0.8, to_x: 0.5, to_y: 0.2, duration_ms: 300 }}
          onPatch={onPatch}
          compact
        />,
      );
      expect(screen.getByTestId('swipe-mode-select')).toHaveValue('point');
      expect(screen.getByText('起点')).toBeTruthy();
      // 点对点与连续方式共用末端按住时长。
      expect(screen.getByTestId('swipe-hold-ms')).toBeInTheDocument();
      expect(screen.queryByTestId('swipe-record-track')).toBeNull();
      fireEvent.click(screen.getByTestId('swipe-record-single'));
      expect(beginRecordSwipe).toHaveBeenCalledWith('sw0', 'single');
      // 拟人只在全局设置里配：节点卡片与详细配置都不出现
      expect(screen.queryByTestId('swipe-bezier-compact')).toBeNull();
      expect(screen.queryByTestId('swipe-bezier-fields')).toBeNull();

      fireEvent.change(screen.getByTestId('swipe-mode-select'), { target: { value: 'track' } });
      expect(onPatch).toHaveBeenCalledWith({ swipe_mode: 'track' });
    } finally {
      useUiStore.setState({ beginRecordSwipeForFlowStep: original });
    }
  });

  it('连续滑动只显示连续录制，切回点对点时清掉旧轨迹', () => {
    const beginRecordSwipe = vi.fn();
    const onPatch = vi.fn();
    const original = useUiStore.getState().beginRecordSwipeForFlowStep;
    useUiStore.setState({ beginRecordSwipeForFlowStep: beginRecordSwipe });
    try {
      render(
        <SwipeStepFields
          stepId="sw0"
          params={{
            swipe_mode: 'track',
            x: 0.2,
            y: 0.8,
            to_x: 0.6,
            to_y: 0.6,
            duration_ms: 400,
            path: [
              [0.2, 0.8],
              [0.4, 0.8],
              [0.6, 0.6],
            ],
          }}
          onPatch={onPatch}
        />,
      );
      expect(screen.getByTestId('swipe-mode-select')).toHaveValue('track');
      expect(screen.queryByTestId('swipe-record-single')).toBeNull();
      expect(screen.queryByText('起点')).toBeNull();
      fireEvent.click(screen.getByTestId('swipe-record-track'));
      expect(beginRecordSwipe).toHaveBeenCalledWith('sw0', 'track');

      fireEvent.change(screen.getByTestId('swipe-mode-select'), { target: { value: 'point' } });
      expect(onPatch).toHaveBeenCalledWith({ swipe_mode: 'point', path: undefined });
    } finally {
      useUiStore.setState({ beginRecordSwipeForFlowStep: original });
    }
  });

  it('连续滑动还没录轨迹时给出提示', () => {
    render(
      <SwipeStepFields
        stepId="sw5"
        params={{ swipe_mode: 'track', x: 0.5, y: 0.8, to_x: 0.5, to_y: 0.2, duration_ms: 300 }}
        onPatch={vi.fn()}
      />,
    );
    expect(screen.getByTestId('swipe-track-empty')).toHaveTextContent('还没有轨迹');
    expect(screen.queryByTestId('swipe-track')).toBeNull();
  });

  it('详细配置也没有拟人贝塞尔参数（统一走全局设置）', () => {
    render(
      <SwipeStepFields
        stepId="sw1"
        params={{ x: 0.5, y: 0.8, to_x: 0.5, to_y: 0.2, duration_ms: 300 }}
        onPatch={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('swipe-bezier-fields')).toBeNull();
    expect(screen.queryByTestId('swipe-bezier-mode')).toBeNull();
    expect(screen.queryByText(/拟人贝塞尔/)).toBeNull();
  });
});

describe('SwipeStepFields 连续滑动', () => {
  it('按住时长可编辑（空 = 松手即结束）', () => {
    const onPatch = vi.fn();
    render(
      <SwipeStepFields
        stepId="sw2"
        params={{
          swipe_mode: 'track',
          x: 0.5,
          y: 0.8,
          to_x: 0.5,
          to_y: 0.2,
          duration_ms: 300,
        }}
        onPatch={onPatch}
      />,
    );
    fireEvent.change(screen.getByTestId('swipe-hold-ms'), { target: { value: '1200' } });
    expect(onPatch).toHaveBeenCalledWith({ hold_ms: 1200 });
    fireEvent.change(screen.getByTestId('swipe-hold-ms'), { target: { value: '99999' } });
    expect(onPatch).toHaveBeenCalledWith({ hold_ms: 5000 });
  });

  it('有轨迹时显示点数，可一键清除', () => {
    const onPatch = vi.fn();
    render(
      <SwipeStepFields
        stepId="sw3"
        params={{
          x: 0.2,
          y: 0.8,
          to_x: 0.6,
          to_y: 0.6,
          duration_ms: 400,
          path: [
            [0.2, 0.8],
            [0.4, 0.8],
            [0.6, 0.6],
          ],
          hold_ms: 600,
        }}
        onPatch={onPatch}
      />,
    );
    expect(screen.getByTestId('swipe-track')).toHaveTextContent('连续轨迹 3 点');
    expect(screen.getByTestId('swipe-track')).toHaveTextContent('按住 600ms');
    // 缩略图：把 path 原样画出来，用户能确认"录的确实是我要的那条线"
    const preview = screen.getByTestId('swipe-track-preview');
    const points = preview.querySelector('polyline')?.getAttribute('points');
    expect(points?.split(' ')).toHaveLength(3);
    expect(points?.startsWith('20,80 40,80')).toBe(true);
    fireEvent.click(screen.getByTestId('swipe-track-clear'));
    // 清除轨迹后仍留在「连续滑动」，方便马上重录
    expect(onPatch).toHaveBeenCalledWith({ path: undefined, swipe_mode: 'track' });
  });

  it('直线滑动不显示轨迹行', () => {
    render(
      <SwipeStepFields
        stepId="sw4"
        params={{ x: 0.5, y: 0.8, to_x: 0.5, to_y: 0.2, duration_ms: 300 }}
        onPatch={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('swipe-track')).toBeNull();
  });
});

describe('ClickStepFields 拟人点击', () => {
  it('节点里没有拟人参数：偏移 / 按下 / 微移只在全局设置', () => {
    render(
      <ClickStepFields
        stepId="c-human"
        params={{ by: 'coord', event: 'click', x: 0.5, y: 0.5 }}
        recognizerLabels={[]}
        onPatch={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('click-human-fields')).toBeNull();
    expect(screen.queryByTestId('click-jitter-px')).toBeNull();
    expect(screen.queryByTestId('click-tap-duration')).toBeNull();
    expect(screen.queryByTestId('click-micro-px')).toBeNull();
  });

  it('画布卡片（compact）也不显示拟人参数', () => {
    render(
      <ClickStepFields
        stepId="c-human-compact"
        params={{ by: 'coord', event: 'click', x: 0.5, y: 0.5 }}
        recognizerLabels={[]}
        onPatch={vi.fn()}
        compact
      />,
    );
    expect(screen.queryByTestId('click-human-compact-fields')).toBeNull();
    expect(screen.queryByTestId('click-compact-jitter-px')).toBeNull();
    expect(screen.queryByTestId('click-compact-tap-duration')).toBeNull();
    expect(screen.queryByTestId('click-compact-micro-px')).toBeNull();
  });

  it('老数据里残留的拟人字段不会渲染成输入框', () => {
    render(
      <ClickStepFields
        stepId="c-human-old"
        params={{
          by: 'coord',
          event: 'click',
          x: 0.5,
          y: 0.5,
          click_jitter_px: 5,
          tap_duration_ms: 80,
          click_micro_px: 7,
        }}
        recognizerLabels={[]}
        onPatch={vi.fn()}
        compact
      />,
    );
    expect(screen.queryByText('拟人')).toBeNull();
    expect(screen.queryByTestId('click-human-compact-fields')).toBeNull();
  });
});

describe('ClickStepFields 坐标点', () => {
  it('坐标方式有示意图、数值输入与点选按钮', () => {
    const onPatch = vi.fn();
    const beginPickCoord = vi.fn();
    const original = useUiStore.getState().beginPickClickCoordForFlowStep;
    useUiStore.setState({ beginPickClickCoordForFlowStep: beginPickCoord });
    try {
      render(
        <ClickStepFields
          stepId="c0"
          params={{ by: 'coord', event: 'click', x: 0.15, y: 0.43 }}
          recognizerLabels={[]}
          onPatch={onPatch}
          compact
        />,
      );
      expect(screen.queryByTestId('click-coord-preview')).toBeNull();
      expect(screen.getByTestId('click-coord-pick')).toBeTruthy();
      expect(screen.getByTestId('click-coord-x')).toBeTruthy();
      fireEvent.click(screen.getByTestId('click-coord-pick'));
      expect(beginPickCoord).toHaveBeenCalledWith('c0');
      fireEvent.change(screen.getByTestId('click-coord-x'), { target: { value: '0.2' } });
      expect(onPatch).toHaveBeenCalledWith({ by: 'coord', rec: '', x: 0.2 });
    } finally {
      useUiStore.setState({ beginPickClickCoordForFlowStep: original });
    }
  });

  it.each(['识别器', '坐标', '随机范围'])('旧中文 by=%s 显示无效状态，不静默转成坐标/图像/范围', (by) => {
    const onPatch = vi.fn();
    render(
      <ClickStepFields
        stepId="invalid-click"
        params={{ by, rec: 'region_1', rect: [0, 0, 0.2, 0.2], x: 0.5, y: 0.5 }}
        recognizerLabels={['region_1']}
        onPatch={onPatch}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('无效点击方式');
    const select = screen.getByTestId<HTMLSelectElement>('click-target-mode-select');
    expect(select.value).toBe('');
    expect(screen.queryByTestId('click-coord-field')).toBeNull();
    expect(screen.queryByTestId('click-region-field')).toBeNull();
    expect(screen.queryByTestId('step-selection-strategy')).toBeNull();
    expect(onPatch).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: 'coord' } });
    expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ by: 'coord', rec: '' }));
  });

  it('点击方式用下拉切换，第一项是图像识别、第二项是 AI 识别', () => {
    const onPatch = vi.fn();
    render(
      <ClickStepFields
        stepId="c0"
        params={{ by: 'recognizer', rec: '' }}
        recognizerLabels={[]}
        onPatch={onPatch}
        compact
      />,
    );
    const select = screen.getByTestId<HTMLSelectElement>('click-target-mode-select');
    expect(select.value).toBe('image');
    const options = Array.from(select.querySelectorAll('option')).map((item) => item.textContent);
    expect(options).toEqual(['图像识别', 'AI 识别', '坐标点', '范围内随机']);
    fireEvent.change(select, { target: { value: 'region' } });
    expect(onPatch).toHaveBeenCalled();
    const patch = onPatch.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch.by).toBe('region');
  });

  it('切到 AI 识别：仍写 by=recognizer，只加 ai 标记', () => {
    const onPatch = vi.fn();
    render(
      <ClickStepFields
        stepId="c0b"
        params={{ by: 'recognizer', rec: '' }}
        recognizerLabels={[]}
        onPatch={onPatch}
        compact
      />,
    );
    fireEvent.change(screen.getByTestId('click-target-mode-select'), { target: { value: 'ai' } });
    const patch = onPatch.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch.by).toBe('recognizer');
    expect(patch.ai).toBe(true);
  });
});

describe('ClickStepFields 交互', () => {
  it('可切换点击 / 双击 / 长按并修改长按时长', () => {
    const onPatch = vi.fn();
    const { rerender } = render(
      <ClickStepFields
        stepId="c1"
        params={{ by: 'coord', event: 'click', x: 0.5, y: 0.5 }}
        recognizerLabels={[]}
        onPatch={onPatch}
      />,
    );

    fireEvent.click(screen.getByTestId('click-event-double_click'));
    expect(onPatch).toHaveBeenCalledWith({ event: 'double_click' });

    fireEvent.click(screen.getByTestId('click-event-long_press'));
    expect(onPatch).toHaveBeenCalledWith({ event: 'long_press', duration_ms: 600 });

    rerender(
      <ClickStepFields
        stepId="c1"
        params={{ by: 'coord', event: 'long_press', x: 0.5, y: 0.5, duration_ms: 600 }}
        recognizerLabels={[]}
        onPatch={onPatch}
      />,
    );
    fireEvent.change(screen.getByTestId('click-duration-input'), { target: { value: '950' } });
    expect(onPatch).toHaveBeenLastCalledWith({ event: 'long_press', duration_ms: 950 });
  });
});

describe('ClickStepFields 范围内随机的布局', () => {
  it('未框选时是虚线空态 +「框选范围」，框选后换成示意图 + 清除', () => {
    const onPatch = vi.fn();
    const beginPick = vi.fn();
    const originalBeginPick = useUiStore.getState().beginPickClickRegionForFlowStep;
    useUiStore.setState({ beginPickClickRegionForFlowStep: beginPick });

    try {
      const { rerender } = render(
        <ClickStepFields
          stepId="c2"
          params={{ by: 'region', event: 'click' }}
          recognizerLabels={[]}
          onPatch={onPatch}
          compact
        />,
      );

      expect(screen.getByTestId('click-region-empty')).toBeTruthy();
      expect(screen.queryByTestId('click-region-preview')).toBeNull();
      expect(screen.queryByText('清除')).toBeNull();
      // 读数和按钮在同一张卡片里（不再拆成上下两块）
      expect(screen.getByTestId('click-region-field').contains(screen.getByTestId('click-region-pick'))).toBe(
        true,
      );

      fireEvent.click(screen.getByTestId('click-region-pick'));
      expect(beginPick).toHaveBeenCalledWith('c2');

      // 框选中：按钮文案变成「在画面拖框…」
      useUiStore.setState({ pendingFlowClickRegionStepId: 'c2', recordMode: 'marquee' });
      rerender(
        <ClickStepFields
          stepId="c2"
          params={{ by: 'region', event: 'click' }}
          recognizerLabels={[]}
          onPatch={onPatch}
          compact
        />,
      );
      expect(screen.getByText('在画面拖框…')).toBeTruthy();

      rerender(
        <ClickStepFields
          stepId="c2"
          params={{ by: 'region', event: 'click', rect: [0.04, 0.58, 0.9, 0.23] }}
          recognizerLabels={[]}
          onPatch={onPatch}
          compact
        />,
      );
      expect(screen.getByTestId('click-region-preview')).toBeTruthy();
      expect(screen.queryByTestId('click-region-empty')).toBeNull();
      expect(
        screen.getByTestId('click-region-field').contains(screen.getByTestId('click-region-preview')),
      ).toBe(true);
      expect(screen.getByTestId('click-region-field').contains(screen.getByText('清除'))).toBe(true);

      fireEvent.click(screen.getByText('清除'));
      expect(onPatch).toHaveBeenCalledWith({
        by: 'coord',
        rect: undefined,
        screenAspect: undefined,
        preview: undefined,
        x: 0.5,
        y: 0.5,
      });
    } finally {
      useUiStore.setState({
        beginPickClickRegionForFlowStep: originalBeginPick,
        pendingFlowClickRegionStepId: null,
      });
    }
  });
});

describe('DelayStepFields 交互', () => {
  it('支持预设选择与自定义毫秒输入', () => {
    const onPatch = vi.fn();
    render(<DelayStepFields params={{ ms: 500 }} onPatch={onPatch} compact />);

    fireEvent.click(screen.getByTestId('delay-preset-1000'));
    expect(onPatch).toHaveBeenCalledWith({ ms: 1000 });

    const input = screen.getByTestId('delay-ms-input');
    fireEvent.change(input, { target: { value: '750' } });
    expect(onPatch).toHaveBeenLastCalledWith({ ms: 750 });
  });
});

describe('SetvarStepFields 交互', () => {
  it('变量名与值改一次就写进 params', () => {
    const onPatch = vi.fn();
    render(<SetvarStepFields params={{ name: '', value: '' }} onPatch={onPatch} compact />);

    fireEvent.change(screen.getByTestId('setvar-name'), { target: { value: '次数' } });
    expect(onPatch).toHaveBeenLastCalledWith({ name: '次数' });

    fireEvent.change(screen.getByTestId('setvar-value'), { target: { value: '$次数 + 1' } });
    expect(onPatch).toHaveBeenLastCalledWith({ value: '$次数 + 1' });
  });
});

describe('TextStepFields 交互', () => {
  it('在节点上输入文字，失焦后写入 params.value', () => {
    const onPatch = vi.fn();
    render(<TextStepFields params={{ value: '' }} onPatch={onPatch} compact />);

    const input = screen.getByTestId<HTMLTextAreaElement>('text-step-input');
    fireEvent.change(input, { target: { value: '你好' } });
    expect(onPatch).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(onPatch).toHaveBeenCalledWith({ value: '你好' });
  });
});

describe('CallStepFields 交互', () => {
  it('在节点上可选择同工作区工作流，当前工作流标出来', () => {
    const onPatch = vi.fn();
    render(
      <CallStepFields
        params={{ name: '' }}
        workflows={[{ name: '百鬼夜行' }, { name: '日常' }]}
        currentName="百鬼夜行"
        onPatch={onPatch}
        compact
      />,
    );

    const select = screen.getByTestId<HTMLSelectElement>('call-workflow-select');
    expect(select).toHaveDisplayValue('（选择工作流）');
    fireEvent.change(select, { target: { value: '日常' } });
    expect(onPatch).toHaveBeenCalledWith({ name: '日常' });
  });

  it('选中目标工作流后显示它的触发条件（例如 9 点定时）', () => {
    render(
      <CallStepFields
        params={{ name: '组队' }}
        workflows={[
          { name: '斗技' },
          { name: '组队', trigger: { type: 'schedule', params: { at: '09:00' } } },
        ]}
        currentName="斗技"
        onPatch={vi.fn()}
        compact
      />,
    );

    expect(screen.getByTestId('call-target-trigger')).toHaveTextContent('触发：定时触发 · 09:00');
  });
});

describe('KeyStepFields 交互', () => {
  it('Android 可切系统键与平台；Windows 显示游戏键盘并可点 WASD', () => {
    const onPatch = vi.fn();
    const { rerender } = render(
      <KeyStepFields params={{ value: 'back' }} deviceKind="android" onPatch={onPatch} compact />,
    );

    fireEvent.click(screen.getByTestId('key-option-home'));
    expect(onPatch).toHaveBeenCalledWith({ value: 'home' });

    fireEvent.click(screen.getByTestId('key-option-recents'));
    expect(onPatch).toHaveBeenCalledWith({ value: 'recents' });

    fireEvent.change(screen.getByTestId('key-platform-select'), { target: { value: 'ios' } });
    expect(onPatch).toHaveBeenCalledWith({ platform: 'ios', value: 'home' });

    rerender(<KeyStepFields params={{ value: 'back' }} deviceKind="windows" onPatch={onPatch} />);
    expect(screen.getByTestId('key-step-fields')).toBeInTheDocument();
    expect(screen.queryByTestId('key-platform-select')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('key-option-w'));
    expect(onPatch).toHaveBeenCalledWith({ value: 'w' });
    fireEvent.click(screen.getByTestId('key-option-space'));
    expect(onPatch).toHaveBeenCalledWith({ value: 'space' });
  });
});

describe('FlowStepEditor 图像配置中的阈值设置', () => {
  it('在右侧「图像配置」更换/录制按钮下方显示并可调整识别器阈值', () => {
    const setThreshold = vi.fn(() => Promise.resolve());
    useSessionStore.setState({ setThreshold });
    const graph = {
      deviceId: SCRIPT_SCOPE,
      nodes: [],
      edges: [],
      recognizers: [
        {
          label: 'region_1',
          type: 'template' as const,
          template: 'templates/region_1.png',
          score: 0.9,
          threshold: 0.82,
          roi: [0, 0, 1, 1] as const,
          search: 'region' as const,
          samples: 1,
          state: 'confirmed' as const,
        },
      ],
      variables: [],
      activeNodeId: null,
      pendingNodeId: null,
      flow: {
        steps: [
          { id: 't', type: 'manual', params: {} },
          { id: 's_1', type: 'click', params: { by: 'recognizer', rec: 'region_1' } },
        ],
      },
    };
    useGraphStore.setState({
      graphs: { [SCRIPT_SCOPE]: graph },
    });

    render(<FlowStepEditor step={graph.flow.steps[1]!} graph={graph} />);

    expect(screen.getByTestId('recognizer-threshold-control')).toBeInTheDocument();
    const slider = screen.getByTestId<HTMLInputElement>('recognizer-threshold-slider');
    expect(slider.value).toBe('0.82');

    fireEvent.change(slider, { target: { value: '0.91' } });
    expect(useGraphStore.getState().graphs[SCRIPT_SCOPE]?.recognizers[0]?.threshold).toBe(0.91);
  });

  it('搜索范围只在步骤上配：默认原区域，可切全屏', () => {
    const onPatch = vi.fn();
    render(
      <ClickStepFields
        stepId="s1"
        params={{ by: 'recognizer', rec: 'region_1' }}
        recognizerLabels={['region_1']}
        onPatch={onPatch}
        previewSide
        part="image"
      />,
    );

    // 只有两个选项：原区域（默认）/ 全屏；录制时不再设模板默认值
    expect(screen.getByTestId('step-search-scope')).toBeInTheDocument();
    expect(screen.queryByTestId('recognizer-search-control')).toBeNull();
    expect(screen.queryByTestId('step-search-auto')).toBeNull();
    expect(screen.getByTestId('step-search-region')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('step-search-full')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('step-search-full'));
    expect(onPatch).toHaveBeenCalledWith({ search: 'full' });
  });

  it('图像点击可以配「多目标」策略：全屏命中一排图标时选点哪一个', () => {
    const onPatch = vi.fn();
    const { rerender } = render(
      <ClickStepFields
        stepId="s1"
        params={{ by: 'recognizer', rec: 'region_1' }}
        recognizerLabels={['region_1']}
        onPatch={onPatch}
        previewSide
        part="image"
      />,
    );

    expect(screen.getByTestId('step-selection-strategy')).toBeInTheDocument();
    expect(screen.getByTestId<HTMLSelectElement>('step-selection-select').value).toBe('auto');

    fireEvent.change(screen.getByTestId('step-selection-select'), { target: { value: 'nearest' } });
    expect(onPatch).toHaveBeenCalledWith({ strategy: 'nearest', index: undefined });

    rerender(
      <ClickStepFields
        stepId="s1"
        params={{ by: 'recognizer', rec: 'region_1', strategy: 'nth', index: 2 }}
        recognizerLabels={['region_1']}
        onPatch={onPatch}
        previewSide
        part="image"
      />,
    );
    expect(screen.getByTestId<HTMLInputElement>('step-selection-index').value).toBe('2');
  });

  it('坐标 / 随机范围点击不显示多目标策略', () => {
    render(
      <ClickStepFields
        stepId="s1"
        params={{ by: 'coord', x: 0.5, y: 0.5 }}
        recognizerLabels={['region_1']}
        onPatch={vi.fn()}
        part="image"
      />,
    );
    expect(screen.queryByTestId('step-selection-strategy')).toBeNull();
  });
});
