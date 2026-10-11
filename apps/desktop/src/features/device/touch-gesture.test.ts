import { describe, expect, it } from 'vitest';

import { SWIPE_MIN_DISTANCE, gestureDistance, isSwipeGesture } from '@/features/device/touch-gesture';

describe('手势判定（轻触 vs 滑动）', () => {
  it('手抖一点点还是轻触：位移在阈值内不算滑动', () => {
    // 真机上按下时鼠标/手指几乎必然有 1~2px 抖动，不能因此判成滑动
    expect(isSwipeGesture([0.5, 0.5], [0.5, 0.5])).toBe(false);
    expect(isSwipeGesture([0.5, 0.5], [0.5 + SWIPE_MIN_DISTANCE / 2, 0.5])).toBe(false);
  });

  it('拖出阈值就是滑动：横向、纵向、斜向都算', () => {
    expect(isSwipeGesture([0.2, 0.5], [0.5, 0.5])).toBe(true);
    expect(isSwipeGesture([0.5, 0.9], [0.5, 0.2])).toBe(true);
    expect(isSwipeGesture([0.2, 0.2], [0.3, 0.3])).toBe(true);
  });

  it('斜向按欧氏距离算，不是各轴分别比阈值', () => {
    // 每个轴各走 0.009（都小于 0.012），合起来 0.0127 > 0.012 —— 是滑动
    expect(isSwipeGesture([0.5, 0.5], [0.509, 0.509])).toBe(true);
    // 单独看某一轴会误判成轻触，这里守住"取合位移"
    expect(Math.abs(0.509 - 0.5)).toBeLessThan(SWIPE_MIN_DISTANCE);
  });

  it('距离用归一化坐标：和画面显示尺寸无关，横竖屏一致', () => {
    expect(gestureDistance([0.1, 0.2], [0.4, 0.6])).toBeCloseTo(0.5, 10);
    expect(gestureDistance([0, 0], [0, 0])).toBe(0);
  });

  it('阈值可传：调用方（例如"抬手才知道是不是滑动"的反馈）能放宽', () => {
    expect(isSwipeGesture([0.5, 0.5], [0.55, 0.5], 0.1)).toBe(false);
    expect(isSwipeGesture([0.5, 0.5], [0.55, 0.5], 0.01)).toBe(true);
  });
});
