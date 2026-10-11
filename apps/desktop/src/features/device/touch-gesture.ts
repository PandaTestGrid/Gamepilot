/**
 * 手势判定（纯逻辑）：按下 → 抬起之间位移多大算「滑动」，多小算「轻触」。
 *
 * 为什么单独抽出来：**反馈层和录制层必须用同一把尺子**。
 *
 * 踩过的坑：反馈层原来根本不判手势 —— 按下闪一个波纹、抬手再闪一个波纹，
 * 于是"拖拽滑动"被画成了**两个点击**（起点一个、终点一个），
 * 看起来像点错了地方。而录制层用的是 0.012 的位移阈值：
 * 两边不一致还会出现更糟的情况 —— 画面上看着是"点了两下"，录下来却是"一次滑动"。
 *
 * 坐标一律是**当前画面的归一化坐标**（和 `lib/canvas.ts`、引擎、录制脚本同一套基准）。
 */

/** 位移超过它才算滑动（约等于手机上 8dp 的 touch slop 折算到归一化坐标）。 */
export const SWIPE_MIN_DISTANCE = 0.012;

export type GesturePoint = readonly [number, number];

/** 起止点的归一化直线距离。 */
export function gestureDistance(from: GesturePoint, to: GesturePoint): number {
  return Math.hypot(to[0] - from[0], to[1] - from[1]);
}

/**
 * 这个手势是滑动吗？
 *
 * 注意判定用**起止点**而不是"中途有没有 move 事件"：手抖 1px 也会发 move，
 * 按 move 判会把所有轻触都误判成滑动；按起止点距离判才和用户的意图一致。
 */
export function isSwipeGesture(
  from: GesturePoint,
  to: GesturePoint,
  threshold: number = SWIPE_MIN_DISTANCE,
): boolean {
  return gestureDistance(from, to) > threshold;
}
