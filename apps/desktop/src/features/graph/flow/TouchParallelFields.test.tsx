import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClickStepFields } from '@/features/graph/flow/ClickStepFields';
import { ParallelStepFields } from '@/features/graph/flow/ParallelStepFields';
import { SwipeStepFields } from '@/features/graph/flow/SwipeStepFields';
import { TouchFingerFields } from '@/features/graph/flow/TouchFingerFields';
import { TouchStepFields } from '@/features/graph/flow/TouchStepFields';

import { useDeviceStore } from '@/stores/device.store';

beforeEach(() => useDeviceStore.setState({ devices: [], activeId: '' }));
afterEach(cleanup);

describe('并行与触摸字段', () => {
  it('已连接设备限制可选手指但不静默修改已有超限值', () => {
    useDeviceStore.setState({ activeId: 'phone', devices: [{ id: 'phone', name: 'phone', uri: 'Android://phone', kind: 'android', status: 'connected', resolution: null, fps: 0, capabilities: { multiTouch: true, maxTouchPoints: 3 } }] });
    const onPatch = vi.fn();
    render(<TouchFingerFields params={{ finger: 8 }} onPatch={onPatch} compact />);
    expect(screen.getByLabelText('触摸手指')).toHaveValue('8');
    expect(screen.getByRole('option', { name: '手指 8（超出设备上限）' })).toBeDisabled();
    expect(screen.queryByRole('option', { name: '手指 4' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('已有配置未修改');
    expect(screen.getByText('当前设备最多支持 3 指触控')).toBeInTheDocument();
    expect(onPatch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('触摸手指'), { target: { value: '2' } });
    expect(onPatch).toHaveBeenCalledWith({ finger: 2 });
  });

  it.each([{ multiTouch: false, maxTouchPoints: 0 }, { multiTouch: true, maxTouchPoints: 0 }])('明确无多指支持时提示但不禁止编辑 %j', (capabilities) => {
    useDeviceStore.setState({ activeId: 'pc', devices: [{ id: 'pc', name: 'pc', uri: 'Windows://pc', kind: 'windows', status: 'connected', resolution: null, fps: 0, capabilities }] });
    const onPatch = vi.fn();
    const view = render(<TouchStepFields params={{ phase: 'down', finger: 4 }} onPatch={onPatch} compact />);
    expect(screen.getByText('当前设备不支持多指触控')).toBeInTheDocument();
    expect(screen.getByLabelText('触摸手指')).not.toBeDisabled();
    expect(screen.getByLabelText('触摸手指')).toHaveValue('4');
    view.rerender(<ParallelStepFields params={{}} onPatch={onPatch} compact />);
    expect(screen.getByText(/当前设备不支持多指触控；并行触摸/)).toBeInTheDocument();
  });

  it('离线能力不用于限制编辑，未知能力明确说明运行设备要求', () => {
    useDeviceStore.setState({ activeId: 'offline', devices: [{ id: 'offline', name: 'offline', uri: 'Android://offline', kind: 'android', status: 'discovered', resolution: null, fps: 0, capabilities: { multiTouch: false, maxTouchPoints: 0 } }] });
    render(<TouchFingerFields params={{ finger: 10 }} onPatch={vi.fn()} />);
    expect(screen.getByText('运行时需支持多指触控的 Android/scrcpy 设备')).toBeInTheDocument();
    expect(screen.getByLabelText('触摸手指')).toHaveValue('10');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('并行mode保存协议值，分支只可选2至4，说明共享覆盖与取消', () => {
    const onPatch = vi.fn();
    const view = render(<ParallelStepFields params={{ mode: 'all', branches: 2 }} onPatch={onPatch} />);
    expect(screen.getByLabelText('并行完成条件')).toHaveValue('all');
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['all', 'any', '2', '3', '4']);
    fireEvent.change(screen.getByLabelText('并行完成条件'), { target: { value: 'any' } });
    expect(onPatch).toHaveBeenCalledWith({ mode: 'any' });
    fireEvent.change(screen.getByLabelText('并行分支数量'), { target: { value: '4' } });
    expect(onPatch).toHaveBeenCalledWith({ branches: 4 });
    view.rerender(<ParallelStepFields params={{ mode: 'any', branches: 4 }} onPatch={onPatch} />);
    expect(screen.getByText(/取消其余分支/)).toBeInTheDocument();
    expect(screen.getByText(/变量共享，后写入/)).toBeInTheDocument();
  });

  it('可选手指默认为自动，不写finger1；显式编号及恢复自动', () => {
    const onPatch = vi.fn();
    const view = render(<TouchFingerFields params={{}} onPatch={onPatch} />);
    expect(screen.getByLabelText('触摸手指')).toHaveValue('');
    expect(onPatch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('触摸手指'), { target: { value: '10' } });
    expect(onPatch).toHaveBeenCalledWith({ finger: 10 });
    view.rerender(<TouchFingerFields params={{ finger: 10 }} onPatch={onPatch} />);
    fireEvent.change(screen.getByLabelText('触摸手指'), { target: { value: '' } });
    expect(onPatch).toHaveBeenLastCalledWith({ finger: undefined });
    expect(screen.getByText(/自动使用所属分支/)).toBeInTheDocument();
  });

  it('原始touch指明phase与手指，归一化坐标夹取，move可选时长', () => {
    const onPatch = vi.fn();
    const view = render(<TouchStepFields params={{ phase: 'down', finger: 3, x: 0.2, y: 0.4 }} onPatch={onPatch} />);
    expect(screen.getByLabelText('触摸手指')).toHaveValue('3');
    expect(screen.queryByRole('option', { name: '自动（所属分支）' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('触摸移动时长')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('触摸 X'), { target: { value: '2' } });
    expect(onPatch).toHaveBeenCalledWith({ x: 1 });
    fireEvent.change(screen.getByLabelText('触摸阶段'), { target: { value: 'move' } });
    expect(onPatch).toHaveBeenCalledWith({ phase: 'move' });
    view.rerender(<TouchStepFields params={{ phase: 'move', finger: 3 }} onPatch={onPatch} />);
    const duration = screen.getByLabelText('触摸移动时长');
    fireEvent.change(duration, { target: { value: '350' } });
    expect(onPatch).toHaveBeenCalledWith({ duration_ms: 350 });
    view.rerender(<TouchStepFields params={{ phase: 'move', finger: 3, duration_ms: 350 }} onPatch={onPatch} />);
    fireEvent.change(screen.getByLabelText('触摸移动时长'), { target: { value: '' } });
    expect(onPatch).toHaveBeenLastCalledWith({ duration_ms: undefined });
    expect(screen.getByText(/分支完成或取消时自动释放/)).toBeInTheDocument();
    view.rerender(<TouchStepFields params={{ phase: 'up', finger: 3 }} onPatch={onPatch} compact />);
    expect(screen.queryByLabelText('触摸移动时长')).not.toBeInTheDocument();
  });

  it.each(['click', 'hold'])('%s字段支持自动分支手指且image半栏不重复', (stepType) => {
    const onPatch = vi.fn();
    const view = render(<ClickStepFields stepId="c" stepType={stepType} params={{ by: 'coord' }} recognizerLabels={[]} onPatch={onPatch} />);
    expect(screen.getByLabelText('触摸手指')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('触摸手指'), { target: { value: '2' } });
    expect(onPatch).toHaveBeenCalledWith({ finger: 2 });
    view.rerender(<ClickStepFields stepId="c" params={{ by: 'coord', finger: 2 }} recognizerLabels={[]} onPatch={onPatch} part="image" />);
    expect(screen.queryByLabelText('触摸手指')).not.toBeInTheDocument();
  });

  it('点到点滑动支持末端按住和手指，切换模式保留二者', () => {
    const onPatch = vi.fn();
    render(<SwipeStepFields stepId="s" params={{ swipe_mode: 'point', finger: 4, hold_ms: 800 }} onPatch={onPatch} compact />);
    expect(screen.getByLabelText('触摸手指')).toHaveValue('4');
    expect(screen.getByTestId('swipe-hold-ms')).toHaveValue(800);
    fireEvent.change(screen.getByTestId('swipe-hold-ms'), { target: { value: '1200' } });
    expect(onPatch).toHaveBeenCalledWith({ hold_ms: 1200 });
    fireEvent.change(screen.getByTestId('swipe-mode-select'), { target: { value: 'track' } });
    expect(onPatch).toHaveBeenCalledWith({ swipe_mode: 'track' });
  });
});
