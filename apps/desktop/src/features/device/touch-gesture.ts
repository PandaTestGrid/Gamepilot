/**
 * 手势判定与轨迹采样（纯逻辑）：按下 → 抬起之间位移多大算「滑动」，多小算「轻触」，
 * 拖出来的那条线怎么折成「轨迹 + 末端保持」。
 *
 * 为什么单独抽出来：**反馈层和录制层必须用同一把尺子**。
 *
 * 反馈层与录制层共用阈值，坐标为画面归一化值。
 */

/** 位移超过它才算滑动（约等于手机上 8dp 的 touch slop 折算到归一化坐标）。 */
export const SWIPE_MIN_DISTANCE = 0.012;

/** 轨迹最多留几个点：32 个点足够画出弧线，又不会把脚本撑成几千行。 */
export const SWIPE_TRACK_MAX_POINTS = 32;

/** 折线简化阈值（归一化）：0.004 ≈ 1080p 上的 4px，比这更小的抖动没有信息量。 */
export const SWIPE_TRACK_EPSILON = 0.004;

/** 松手前静止超过它才算「按住」（折成 hold_ms）。低于它就只是正常减速。 */
export const SWIPE_HOLD_MIN_MS = 200;

/** 按住判定距离：手指按住不动时仍会有 1~2px 抖动。 */
export const SWIPE_STOP_DISTANCE = 0.006;

export type GesturePoint = readonly [number, number];

/** 一次采样：归一化坐标 + 采样时刻（毫秒，`performance.now()`）。 */
export type GestureSample = {
  readonly point: GesturePoint;
  readonly at: number;
};

/** 录制出来的滑动轨迹：轨迹点为空表示「直线滑」；holdMs 为松手前的保持时长。 */
export type SwipeTrack = {
  readonly path: readonly GesturePoint[];
  readonly holdMs: number;
};

/** 起止点的归一化直线距离。 */
export function gestureDistance(from: GesturePoint, to: GesturePoint): number {
  return Math.hypot(to[0] - from[0], to[1] - from[1]);
}

/** 手指实际走过的总路程（把每一小段位移加起来）。 */
export function gestureTravel(points: readonly GesturePoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += gestureDistance(points[index - 1]!, points[index]!);
  }
  return total;
}

/**
 * 这个手势是滑动吗？
 *
 * 两个判据，任意一个成立就算滑动：
 * 1. **起止点距离**超过阈值 —— 正常的一划。用它而不是"中途有没有 move 事件"：
 *    手抖 1px 也会发 move，按 move 判会把所有轻触都误判成滑动；
 * 2. **走过的总路程**超过 3 倍阈值 —— 画圈 / 折返 / 来回推摇杆：起止点几乎重合，
 *    但手指明明走了很远，绝不能当成轻点（否则圆形轨迹根本录不进去）。
 *    取 3 倍是为了放过"按下时的手抖"（抖动累积也就几个像素）。
 */
export function isSwipeGesture(
  from: GesturePoint,
  to: GesturePoint,
  threshold: number = SWIPE_MIN_DISTANCE,
  points?: readonly GesturePoint[],
): boolean {
  if (gestureDistance(from, to) > threshold) {
    return true;
  }
  return points !== undefined && gestureTravel(points) > threshold * 3;
}

/** 点到线段的距离（RDP 的误差量）。 */
function segmentDistance(point: GesturePoint, from: GesturePoint, to: GesturePoint): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return gestureDistance(point, from);
  }
  const t = Math.max(0, Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / lengthSq));
  return Math.hypot(point[0] - (from[0] + t * dx), point[1] - (from[1] + t * dy));
}

/** Ramer–Douglas–Peucker（显式栈，避免长轨迹递归过深）。 */
function simplifyOnce(points: readonly GesturePoint[], epsilon: number): GesturePoint[] {
  if (points.length <= 2) {
    return [...points];
  }
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let farthestDistance = 0;
    for (let index = first + 1; index < last; index += 1) {
      const distance = segmentDistance(points[index]!, points[first]!, points[last]!);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthest = index;
      }
    }
    if (farthest !== -1 && farthestDistance > epsilon) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  const simplified: GesturePoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    if (keep[index]) {
      simplified.push(points[index]!);
    }
  }
  return simplified;
}

/**
 * 折线简化：先按 `epsilon` 去掉抖动，点数还超上限就自动放大阈值再折。
 *
 * 一条直线（手抖几个像素）会折成两个点 —— 这也是「只有偏离直线才存轨迹」的判据。
 */
export function simplifyTrack(
  points: readonly GesturePoint[],
  epsilon: number = SWIPE_TRACK_EPSILON,
): GesturePoint[] {
  let threshold = epsilon;
  let simplified = simplifyOnce(points, threshold);
  for (let attempt = 0; attempt < 6 && simplified.length > SWIPE_TRACK_MAX_POINTS; attempt += 1) {
    threshold *= 1.8;
    simplified = simplifyOnce(points, threshold);
  }
  return simplified;
}

/**
 * 把按下→抬起之间的采样点折成「轨迹 + 保持时长」。
 *
 * - 末尾连续静止 ≥ `SWIPE_HOLD_MIN_MS` 的部分不进轨迹，而是折成 `holdMs`
 *   （推摇杆、按住不放：手指最后停在终点上）。
 * - 轨迹简化后不足 3 个点 = 基本是直线 → 返回空轨迹，回放走原来的直线滑动。
 */
export function buildSwipeTrack(
  samples: readonly GestureSample[],
  options: { readonly holdMinMs?: number; readonly stopDistance?: number } = {},
): SwipeTrack {
  const holdMinMs = options.holdMinMs ?? SWIPE_HOLD_MIN_MS;
  const stopDistance = options.stopDistance ?? SWIPE_STOP_DISTANCE;
  if (samples.length < 2) {
    return { path: [], holdMs: 0 };
  }
  const last = samples[samples.length - 1]!;
  let stillFrom = samples.length - 1;
  while (stillFrom > 0 && gestureDistance(samples[stillFrom - 1]!.point, last.point) <= stopDistance) {
    stillFrom -= 1;
  }
  const stillMs = last.at - samples[stillFrom]!.at;
  const holdMs = stillFrom > 0 && stillMs >= holdMinMs ? Math.round(stillMs) : 0;
  const moving = holdMs > 0 ? samples.slice(0, stillFrom + 1) : samples;
  const simplified = simplifyTrack(moving.map((sample) => sample.point));
  return { path: simplified.length >= 3 ? simplified : [], holdMs };
}
