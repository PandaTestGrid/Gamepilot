/**
 * 延时模块的「随机等待范围」：参数读法、默认范围、写反了自动换回来，
 * 以及节点里开关与两个输入框的真实交互。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DelayStepFields } from '@/features/graph/flow/DelayStepFields';
import {
  defaultRandomRange,
  delayIsRandom,
  randomDelayPatch,
  randomDelayRangeOf,
} from '@/features/graph/flow/flow-delay-params';
import { flowStepTitle } from '@/features/graph/flow/flow-step-meta';

describe('随机等待参数', () => {
  it('未开随机时保持固定延时语义', () => {
    expect(delayIsRandom({ ms: 800 })).toBe(false);
    expect(delayIsRandom(undefined)).toBe(false);
    expect(delayIsRandom({ random: 'yes' })).toBe(false);
    expect(flowStepTitle({ id: 'd', type: 'delay', params: { ms: 800 } })).toBe('延时 · 800ms');
  });

  it('开了随机但没有范围时回退到固定 ms，标题显示范围', () => {
    expect(randomDelayRangeOf({ random: true, ms: 700 })).toEqual({ random: true, min: 700, max: 700 });
    expect(flowStepTitle({ id: 'd', type: 'delay', params: { random: true, ms: 700 } })).toBe(
      '延时 · 700~700ms（随机）',
    );
  });

  it('范围读法与上下限写反都收敛到合法区间', () => {
    expect(randomDelayRangeOf({ random: true, minMs: 200, maxMs: 1500 })).toEqual({
      random: true,
      min: 200,
      max: 1500,
    });
    expect(randomDelayRangeOf({ random: true, minMs: 1500, maxMs: 200 })).toEqual({
      random: true,
      min: 200,
      max: 1500,
    });
    expect(randomDelayRangeOf({ random: true, minMs: -5, maxMs: 9999999 })).toEqual({
      random: true,
      min: 0,
      max: 600000,
    });
  });

  it('打开随机给一个可用的默认范围，关闭随机只关开关不动原 ms', () => {
    const opened = randomDelayPatch({ ms: 400 }, true);
    expect(opened).toEqual({ random: true, minMs: 400, maxMs: 1200 });
    expect(defaultRandomRange({ ms: 400 })).toEqual({ min: 400, max: 1200 });
    expect(randomDelayPatch({ ms: 400, random: true, minMs: 400, maxMs: 1200 }, false)).toEqual({ random: false });
    // 已有范围时再打开沿用原范围，不重置用户配置
    expect(randomDelayPatch({ ms: 400, minMs: 250, maxMs: 900 }, true)).toEqual({
      random: true,
      minMs: 250,
      maxMs: 900,
    });
  });
});

describe('延时节点里的随机范围编辑', () => {
  function setup(params: Record<string, unknown>) {
    const onPatch = vi.fn();
    const { rerender } = render(<DelayStepFields params={params} onPatch={onPatch} compact />);
    return {
      onPatch,
      rerender: (next: Record<string, unknown>) => rerender(<DelayStepFields params={next} onPatch={onPatch} compact />),
    };
  }

  it('点「随机」打开范围，再点一次只关闭随机', () => {
    const { onPatch, rerender } = setup({ ms: 600 });
    fireEvent.click(screen.getByTestId('delay-random-toggle'));
    expect(onPatch).toHaveBeenCalledWith({ random: true, minMs: 600, maxMs: 1200 });

    rerender({ ms: 600, random: true, minMs: 600, maxMs: 1200 });
    expect(screen.getByTestId('delay-random-toggle')).toHaveAttribute('aria-checked', 'true');
    // 固定输入框隐藏，改看两个范围框
    expect(screen.queryByTestId('delay-ms-input')).toBeNull();
    fireEvent.click(screen.getByTestId('delay-random-toggle'));
    expect(onPatch).toHaveBeenLastCalledWith({ random: false });
  });

  it('改最短/最长会写入对应字段，超到另一边时整段换回来', () => {
    const { onPatch, rerender } = setup({ ms: 500, random: true, minMs: 500, maxMs: 1000 });
    const min = screen.getByTestId('delay-min-input');
    const max = screen.getByTestId('delay-max-input');
    expect(min).toHaveValue(500);
    expect(max).toHaveValue(1000);

    fireEvent.change(min, { target: { value: '300' } });
    expect(onPatch).toHaveBeenLastCalledWith({ minMs: 300 });

    rerender({ ms: 500, random: true, minMs: 300, maxMs: 1000 });
    fireEvent.change(screen.getByTestId('delay-max-input'), { target: { value: '1800' } });
    expect(onPatch).toHaveBeenLastCalledWith({ maxMs: 1800 });

    // 最短被改到超过最长：不要停在非法区间，两头一起抬到新值
    rerender({ ms: 500, random: true, minMs: 300, maxMs: 1800 });
    fireEvent.change(screen.getByTestId('delay-min-input'), { target: { value: '2000' } });
    expect(onPatch).toHaveBeenLastCalledWith({ minMs: 2000, maxMs: 2000 });
  });

  it('随机模式不展示固定延时的预设按钮，关闭后恢复', () => {
    const { rerender } = setup({ ms: 500, random: true, minMs: 500, maxMs: 1000 });
    expect(screen.queryByTestId('delay-preset-500')).toBeNull();
    rerender({ ms: 500, random: false });
    expect(screen.getByTestId('delay-preset-500')).toBeInTheDocument();
    expect(screen.getByTestId('delay-ms-input')).toHaveValue(500);
  });
});
