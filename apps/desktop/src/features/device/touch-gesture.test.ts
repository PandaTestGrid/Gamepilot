import { describe, expect, it } from 'vitest';

import {
  buildSwipeTrack,
  type GesturePoint,
  type GestureSample,
  gestureDistance,
  gestureTravel,
  isSwipeGesture,
  simplifyTrack,
  SWIPE_MIN_DISTANCE,
  SWIPE_TRACK_MAX_POINTS,
} from '@/features/device/touch-gesture';

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

/** 造一条采样轨迹：`at` 每点递增 `stepMs`。 */
function samples(points: readonly GesturePoint[], stepMs = 16, start = 0): GestureSample[] {
  return points.map((point, index) => ({ point, at: start + index * stepMs }));
}

describe('轨迹简化（RDP）', () => {
  it('直线上的抖动折成两个点', () => {
    const straight: GesturePoint[] = [
      [0.2, 0.8],
      [0.25, 0.799],
      [0.3, 0.801],
      [0.4, 0.8],
    ];
    expect(simplifyTrack(straight)).toEqual([
      [0.2, 0.8],
      [0.4, 0.8],
    ]);
  });

  it('拐弯的点留着（这是"连续滑动"相对直线滑动的全部价值）', () => {
    const bend: GesturePoint[] = [
      [0.2, 0.8],
      [0.4, 0.8],
      [0.6, 0.6],
    ];
    expect(simplifyTrack(bend)).toHaveLength(3);
  });

  it('点数超上限时自动放大阈值', () => {
    // 一条正弦波：点很密，但形状信息不多，折完必须进 32 点以内
    const wave: GesturePoint[] = Array.from({ length: 400 }, (_, index) => [
      index / 400,
      0.5 + Math.sin(index / 12) * 0.01,
    ]);
    const simplified = simplifyTrack(wave);
    expect(simplified.length).toBeLessThanOrEqual(SWIPE_TRACK_MAX_POINTS);
    expect(simplified[0]).toEqual(wave[0]);
    expect(simplified[simplified.length - 1]).toEqual(wave[wave.length - 1]);
  });
});

describe('录制轨迹 + 末端保持', () => {
  it('直线拖动：不存轨迹（回放走原来的直线滑动）', () => {
    const track = buildSwipeTrack(
      samples([
        [0.5, 0.8],
        [0.5, 0.6],
        [0.5, 0.4],
      ]),
    );
    expect(track.path).toEqual([]);
    expect(track.holdMs).toBe(0);
  });

  it('弧线拖动：轨迹留下来', () => {
    const track = buildSwipeTrack(
      samples([
        [0.2, 0.8],
        [0.4, 0.8],
        [0.6, 0.6],
      ]),
    );
    expect(track.path.length).toBeGreaterThanOrEqual(3);
  });

  it('松手前停在终点 ≥200ms：静止那段折成 holdMs，不进轨迹', () => {
    const track = buildSwipeTrack([
      ...samples(
        [
          [0.2, 0.8],
          [0.4, 0.7],
          [0.5, 0.4],
        ],
        16,
        0,
      ),
      // 手指到终点后按住 500ms 不动
      { point: [0.5, 0.4], at: 532 },
      { point: [0.501, 0.401], at: 800 },
      { point: [0.5, 0.4], at: 1032 },
    ]);
    expect(track.holdMs).toBeGreaterThanOrEqual(500);
    expect(track.path[track.path.length - 1]).toEqual([0.5, 0.4]);
  });

  it('只是减速（静止不到 200ms）：不算按住', () => {
    const track = buildSwipeTrack([
      ...samples(
        [
          [0.2, 0.8],
          [0.5, 0.4],
        ],
        16,
        0,
      ),
      { point: [0.5, 0.4], at: 100 },
    ]);
    expect(track.holdMs).toBe(0);
  });

  it('按下没动就抬手：不是滑动，也没有 hold', () => {
    const track = buildSwipeTrack(samples([[0.5, 0.5]]));
    expect(track).toEqual({ path: [], holdMs: 0 });
  });
});

describe('画圈（起止点重合）也算滑动', () => {
  function circle(radius = 0.15, steps = 24): GesturePoint[] {
    return Array.from({ length: steps + 1 }, (_, index): GesturePoint => {
      const angle = (index / steps) * Math.PI * 2;
      return [0.5 + Math.cos(angle) * radius, 0.5 + Math.sin(angle) * radius];
    });
  }

  it('合位移为 0，但走过的路程很长 → 仍然是滑动（这是"画了个圆却没录进去"的根因）', () => {
    const points = circle();
    const from = points[0]!;
    const to = points[points.length - 1]!;
    expect(gestureDistance(from, to)).toBeLessThan(SWIPE_MIN_DISTANCE);
    expect(gestureTravel(points)).toBeGreaterThan(0.5);
    expect(isSwipeGesture(from, to)).toBe(false);
    expect(isSwipeGesture(from, to, SWIPE_MIN_DISTANCE, points)).toBe(true);
  });

  it('按下时手抖几个像素不算滑动（累积路程也攒不够 3 倍阈值）', () => {
    const jitter: GesturePoint[] = Array.from({ length: 20 }, (_, index): GesturePoint => [
      0.5 + (index % 2) * 0.0008,
      0.5 + ((index + 1) % 2) * 0.0008,
    ]);
    const from = jitter[0]!;
    const to = jitter[jitter.length - 1]!;
    expect(isSwipeGesture(from, to, SWIPE_MIN_DISTANCE, jitter)).toBe(false);
  });

  it('来回推摇杆（出去再回来）也算滑动', () => {
    const points: GesturePoint[] = [
      [0.2, 0.8],
      [0.2, 0.6],
      [0.2, 0.5],
      [0.2, 0.8],
    ];
    expect(isSwipeGesture([0.2, 0.8], [0.2, 0.8], SWIPE_MIN_DISTANCE, points)).toBe(true);
  });
});

describe('画一个圆：轨迹不该退化成两点', () => {
  it('绕一圈回到起点，折线仍然是多段（圆不能被简化成直线）', () => {
    const samples: GestureSample[] = [];
    const steps = 60;
    for (let index = 0; index <= steps; index += 1) {
      const angle = (index / steps) * Math.PI * 2;
      samples.push({
        point: [0.5 + Math.cos(angle) * 0.2, 0.5 + Math.sin(angle) * 0.2] as GesturePoint,
        at: index * 16,
      });
    }
    const track = buildSwipeTrack(samples);
    expect(track.path.length).toBeGreaterThanOrEqual(6);
    // 首尾几乎重合（画圆），但仍然保留了弧上的点
    expect(track.path[0]?.[0]).toBeCloseTo(0.7, 6);
    expect(track.holdMs).toBe(0);
  });
});
