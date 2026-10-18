import { describe, expect, it } from 'vitest';

import {
  formatSwipeSummary,
  matchingSwipePresetId,
  parseSwipeEasing,
  parseSwipeHoldMs,
  resolveSwipeMode,
  SWIPE_PRESETS,
  swipeBezierMode,
  swipeTrackPointCount,
} from '@/features/graph/flow/flow-swipe-params';
import { flowStepTitle } from '@/features/graph/flow/flow-step-meta';

describe('swipe presets', () => {
  it('上滑预设可识别', () => {
    const up = SWIPE_PRESETS.find((item) => item.id === 'up')!.params;
    expect(matchingSwipePresetId({ ...up, duration_ms: 300 })).toBe('up');
  });

  it('标题包含起止与时长', () => {
    expect(
      flowStepTitle({
        id: 's',
        type: 'swipe',
        params: { x: 0.5, y: 0.75, to_x: 0.5, to_y: 0.25, duration_ms: 400 },
      }),
    ).toContain('400ms');
    expect(formatSwipeSummary({ x: 0.5, y: 0.75, to_x: 0.5, to_y: 0.25, duration_ms: 400 })).toContain('→');
  });
});

describe('滑动方式', () => {
  it('显式 swipe_mode 优先（选了连续即使还没录轨迹也不跳回去）', () => {
    expect(resolveSwipeMode({ swipe_mode: 'point' })).toBe('point');
    expect(resolveSwipeMode({ swipe_mode: 'track' })).toBe('track');
    expect(
      resolveSwipeMode({
        swipe_mode: 'track',
        path: [
          [0, 0],
          [0.5, 0.5],
          [1, 1],
        ],
      }),
    ).toBe('track');
  });

  it('老数据没有 swipe_mode 时按轨迹推断', () => {
    expect(resolveSwipeMode({ x: 0.5, y: 0.8, to_x: 0.5, to_y: 0.2 })).toBe('point');
    expect(resolveSwipeMode({})).toBe('point');
    expect(
      resolveSwipeMode({
        path: [
          [0, 0],
          [0.5, 0.5],
          [1, 1],
        ],
      }),
    ).toBe('track');
    expect(
      resolveSwipeMode({
        path: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toBe('point');
  });
});

describe('swipe bezier params', () => {
  it('未写 bezier 时跟随全局', () => {
    expect(swipeBezierMode({})).toBe('global');
    expect(swipeBezierMode({ bezier: true })).toBe('on');
    expect(swipeBezierMode({ bezier: false })).toBe('off');
  });

  it('兼容脚本里的 0/1/2/3 速度类型', () => {
    expect(parseSwipeEasing(0)).toBe('linear');
    expect(parseSwipeEasing(1)).toBe('ease_in');
    expect(parseSwipeEasing('ease_out')).toBe('ease_out');
    expect(parseSwipeEasing(3)).toBe('ease_in_out');
  });
});

describe('连续滑动（轨迹 + 末端按住）', () => {
  it('摘要里标出点数与按住时长', () => {
    const summary = formatSwipeSummary({
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
      hold_ms: 800,
    });
    expect(summary).toContain('400ms');
    expect(summary).toContain('连续 3 点');
    expect(summary).toContain('按住 800ms');
  });

  it('直线滑动不写这两个标记', () => {
    const summary = formatSwipeSummary({ x: 0.5, y: 0.8, to_x: 0.5, to_y: 0.2, duration_ms: 300 });
    expect(summary).not.toContain('连续');
    expect(summary).not.toContain('按住');
  });

  it('点数/按住时长的解析容错', () => {
    expect(swipeTrackPointCount({})).toBe(0);
    expect(swipeTrackPointCount({ path: 'bad' })).toBe(0);
    expect(
      swipeTrackPointCount({
        path: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toBe(2);
    expect(parseSwipeHoldMs({})).toBe(0);
    expect(parseSwipeHoldMs({ hold_ms: -5 })).toBe(0);
    expect(parseSwipeHoldMs({ hold_ms: '1000' })).toBe(1000);
    expect(parseSwipeHoldMs({ hold_ms: 99999 })).toBe(5000);
  });
});
