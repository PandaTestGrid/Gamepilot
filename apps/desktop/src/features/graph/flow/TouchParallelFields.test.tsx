import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClickStepFields } from '@/features/graph/flow/ClickStepFields';
import { ParallelStepFields } from '@/features/graph/flow/ParallelStepFields';
import { SwipeStepFields } from '@/features/graph/flow/SwipeStepFields';
import { TouchStepFields } from '@/features/graph/flow/TouchStepFields';

afterEach(cleanup);

describe('并行与触摸字段', () => {
  it('并行模式保存协议值，且不再暴露手动手指或设备能力提示', () => {
    const onPatch = vi.fn();
    const view = render(<ParallelStepFields params={{ mode: 'all', branches: 2 }} onPatch={onPatch} />);
    expect(screen.getByLabelText('并行完成条件')).toHaveValue('all');
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['all', 'any', '2', '3', '4']);
    expect(screen.queryByLabelText('触摸手指')).not.toBeInTheDocument();
    expect(screen.queryByText(/多指触控/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('并行完成条件'), { target: { value: 'any' } });
    expect(onPatch).toHaveBeenCalledWith({ mode: 'any' });
    fireEvent.change(screen.getByLabelText('并行分支数量'), { target: { value: '4' } });
    expect(onPatch).toHaveBeenCalledWith({ branches: 4 });
    view.rerender(<ParallelStepFields params={{ mode: 'any', branches: 4 }} onPatch={onPatch} />);
    expect(screen.getByText(/取消其余分支/)).toBeInTheDocument();
    expect(screen.getByText(/变量共享，后写入/)).toBeInTheDocument();
  });

  it('原始 touch 只编辑阶段/坐标/时长，手指由引擎自动分配', () => {
    const onPatch = vi.fn();
    const view = render(<TouchStepFields params={{ phase: 'down', finger: 3, x: 0.2, y: 0.4 }} onPatch={onPatch} />);
    expect(screen.queryByLabelText('触摸手指')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('触摸移动时长')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('触摸 X'), { target: { value: '2' } });
    expect(onPatch).toHaveBeenCalledWith({ x: 1 });
    fireEvent.change(screen.getByLabelText('触摸阶段'), { target: { value: 'move' } });
    expect(onPatch).toHaveBeenCalledWith({ phase: 'move' });
    view.rerender(<TouchStepFields params={{ phase: 'move', x: 0.5, y: 0.5 }} onPatch={onPatch} />);
    const duration = screen.getByLabelText('触摸移动时长');
    fireEvent.change(duration, { target: { value: '350' } });
    expect(onPatch).toHaveBeenCalledWith({ duration_ms: 350 });
    view.rerender(<TouchStepFields params={{ phase: 'move', duration_ms: 350 }} onPatch={onPatch} />);
    fireEvent.change(screen.getByLabelText('触摸移动时长'), { target: { value: '' } });
    expect(onPatch).toHaveBeenLastCalledWith({ duration_ms: undefined });
    expect(screen.getByText(/自动分配并复用/)).toBeInTheDocument();
    view.rerender(<TouchStepFields params={{ phase: 'up' }} onPatch={onPatch} compact />);
    expect(screen.queryByLabelText('触摸移动时长')).not.toBeInTheDocument();
  });

  it.each(['click', 'hold'])('%s 字段不再暴露手动手指配置', (stepType) => {
    render(<ClickStepFields stepId="c" stepType={stepType} params={{ by: 'coord' }} recognizerLabels={[]} onPatch={vi.fn()} />);
    expect(screen.queryByLabelText('触摸手指')).not.toBeInTheDocument();
  });

  it('点到点滑动仍保留末端按住与轨迹切换', () => {
    const onPatch = vi.fn();
    render(<SwipeStepFields stepId="s" params={{ swipe_mode: 'point', finger: 4, hold_ms: 800 }} onPatch={onPatch} compact />);
    expect(screen.queryByLabelText('触摸手指')).not.toBeInTheDocument();
    expect(screen.getByTestId('swipe-hold-ms')).toHaveValue(800);
    fireEvent.change(screen.getByTestId('swipe-hold-ms'), { target: { value: '1200' } });
    expect(onPatch).toHaveBeenCalledWith({ hold_ms: 1200 });
    fireEvent.change(screen.getByTestId('swipe-mode-select'), { target: { value: 'track' } });
    expect(onPatch).toHaveBeenCalledWith({ swipe_mode: 'track' });
  });
});
