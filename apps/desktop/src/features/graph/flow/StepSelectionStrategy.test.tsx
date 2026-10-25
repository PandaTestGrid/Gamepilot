import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { StepSelectionStrategy } from '@/features/graph/flow/StepSelectionStrategy';
import { flowStepTitle } from '@/features/graph/flow/flow-step-meta';

describe('StepSelectionStrategy', () => {
  it('默认自动，切换策略会写入 params', () => {
    const onChange = vi.fn();
    render(<StepSelectionStrategy value={undefined} onChange={onChange} />);

    expect(screen.getByTestId<HTMLSelectElement>('step-selection-select').value).toBe('auto');
    expect(screen.queryByTestId('step-selection-index')).toBeNull();

    fireEvent.change(screen.getByTestId('step-selection-select'), { target: { value: 'all' } });
    expect(onChange).toHaveBeenCalledWith({ strategy: 'all', index: undefined });
  });

  it('选「第 N 个」出现序号输入，并带默认值 1', () => {
    const onChange = vi.fn();
    render(<StepSelectionStrategy value="nth" index={3} onChange={onChange} />);

    const index = screen.getByTestId<HTMLInputElement>('step-selection-index');
    expect(index.value).toBe('3');

    fireEvent.change(index, { target: { value: '5' } });
    expect(onChange).toHaveBeenCalledWith({ strategy: 'nth', index: 5 });
  });

  it('节点标题显示策略摘要', () => {
    expect(
      flowStepTitle({ id: 's', type: 'click', params: { by: 'recognizer', rec: '剑', strategy: 'all' } }),
    ).toBe('点击 · 剑 · 全部');
    expect(
      flowStepTitle({
        id: 's',
        type: 'click',
        params: { by: 'recognizer', rec: '剑', strategy: 'nth', index: 2 },
      }),
    ).toBe('点击 · 剑 · 第 2 个');
  });
});
