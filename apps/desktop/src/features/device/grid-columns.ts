/**
 * 多开网格该分几列。
 *
 * 以前的规则是 `count >= 4 ? 2 : 1` —— 两条竖屏手机被硬排成一列，
 * 在宽窗口里每台只在中间露一小块，左右全是黑边（用户截图就是这个）。
 *
 * 现在的规则看**格子的实际形状**：
 *   1. 先按可用宽度算"最多能并几列"：每格至少要能放下 `MIN_TILE_WIDTH`；
 *   2. 再按"并排后格子更接近画面比例"来挑：一列时格子很宽、画面只占中间一条，
 *      并排后每个格子变窄、画面反而更大；
 *   3. 不论怎么算，列数不超过设备数（3 台不会排出 4 列空位）。
 *
 * 用户手动选了列数（`gridColumns !== 'auto'`）时直接采用，不再计算。
 */
import type { GridColumns } from '@/stores/ui.store';

/** 单格的期望最小宽度（px）：再窄按键条和头栏就开始挤压 */
export const MIN_TILE_WIDTH = 300;

export interface GridColumnInput {
  /** 可用内容宽度（px）；jsdom / 首帧未量到时为 0 */
  readonly width: number;
  /** 已连接设备数 */
  readonly count: number;
  /** 这些设备里最"宽"的画面比例（宽/高）；竖屏是 0.56，横屏是 1.78 */
  readonly aspect: number;
  /** 用户偏好：auto 或固定列数 */
  readonly preference: GridColumns;
  /** 网格容器高度（px），用来判断并排后每格是否还放得下 */
  readonly height: number;
}

export function gridColumnsFor(input: GridColumnInput): number {
  if (input.preference !== 'auto') {
    return Math.max(1, Math.min(input.preference, Math.max(1, input.count)));
  }

  const count = Math.max(1, input.count);
  if (count === 1) {
    return 1;
  }

  // 宽度没量到（首帧 / jsdom）：退回到"两台并排、三台起两列"的保守值
  if (input.width <= 0) {
    return count >= 4 ? 2 : Math.min(2, count);
  }

  const maxByWidth = Math.max(1, Math.floor(input.width / MIN_TILE_WIDTH));
  // 高度也不该被忽略：一行放不下两台时就只能一列（否则每格被压成一条）
  const maxByHeight = input.height > 0 ? Math.max(1, Math.floor(input.height / 132)) : count;
  const upper = Math.min(count, maxByWidth, maxByHeight);

  // 挑"格子形状最接近画面比例"的列数。
  // 用对数的绝对差而不是单向惩罚：格子太宽（左右黑边）和太窄（上下黑边）
  // 都会把画面压小，只罚一侧会让"三台横屏排成两条"这类方案看起来零浪费。
  let best = 1;
  let bestScore = Number.POSITIVE_INFINITY;
  const target = Math.max(0.1, input.aspect);
  for (let columns = upper; columns >= 1; columns -= 1) {
    const tileWidth = input.width / columns;
    const rows = Math.ceil(count / columns);
    const tileHeight =
      input.height > 0 ? input.height / rows : tileWidth / Math.max(0.1, input.aspect);
    const tileAspect = tileWidth / Math.max(1, tileHeight);
    // 同等形状下宁可少分列：格子更大，按键条/头栏的可读性更好
    const score = Math.abs(Math.log(tileAspect / target)) + columns * 0.02;
    if (score < bestScore) {
      bestScore = score;
      best = columns;
    }
  }
  return best;
}

