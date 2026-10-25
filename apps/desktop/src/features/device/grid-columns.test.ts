/**
 * 多开分列：用户截图里两条竖屏手机被排成一列，宽窗口里每台只在中间露一小块。
 * 这里守住「按宽度/形状算列数」的规则，以及手动覆盖优先。
 */
import { describe, expect, it } from 'vitest';

import { gridColumnsFor, MIN_TILE_WIDTH } from '@/features/device/grid-columns';

const PORTRAIT = 900 / 1600; // 0.5625
const LANDSCAPE = 1280 / 720; // 1.78

describe('多开网格分列', () => {
  it('宽窗口里两条竖屏并排（而不是上下堆成一列）', () => {
    const columns = gridColumnsFor({
      width: 1000,
      height: 700,
      count: 2,
      aspect: PORTRAIT,
      preference: 'auto',
    });
    expect(columns).toBe(2);
  });

  it('窄栏里两条竖屏只能一列（并排会把每格压到按键条都放不下）', () => {
    const columns = gridColumnsFor({
      width: MIN_TILE_WIDTH,
      height: 700,
      count: 2,
      aspect: PORTRAIT,
      preference: 'auto',
    });
    expect(columns).toBe(1);
  });

  it('三台横屏在"又宽又矮"的区域里排成三列（并排才装得下）', () => {
    const columns = gridColumnsFor({
      width: MIN_TILE_WIDTH * 6,
      height: 400,
      count: 3,
      aspect: LANDSCAPE,
      preference: 'auto',
    });
    expect(columns).toBe(3);
  });

  it('同样是三台横屏，但在接近方形的区域里排两列（三列会被压成细条）', () => {
    const columns = gridColumnsFor({
      width: MIN_TILE_WIDTH * 3,
      height: 700,
      count: 3,
      aspect: LANDSCAPE,
      preference: 'auto',
    });
    expect(columns).toBe(2);
  });

  it('列数永远不超过设备数（3 台不会排出 4 列空位）', () => {
    const columns = gridColumnsFor({
      width: 4000,
      height: 900,
      count: 3,
      aspect: PORTRAIT,
      preference: 'auto',
    });
    expect(columns).toBeLessThanOrEqual(3);
  });

  it('手动钉死列数：直接采用，且被设备数夹住', () => {
    expect(
      gridColumnsFor({ width: 3000, height: 900, count: 2, aspect: PORTRAIT, preference: 1 }),
    ).toBe(1);
    expect(
      gridColumnsFor({ width: 700, height: 900, count: 3, aspect: PORTRAIT, preference: 3 }),
    ).toBe(3);
    expect(
      gridColumnsFor({ width: 3000, height: 900, count: 1, aspect: PORTRAIT, preference: 3 }),
    ).toBe(1);
  });

  it('宽度还没量到（首帧 / jsdom）：保守地两台并排', () => {
    expect(gridColumnsFor({ width: 0, height: 0, count: 2, aspect: PORTRAIT, preference: 'auto' })).toBe(2);
    expect(gridColumnsFor({ width: 0, height: 0, count: 1, aspect: PORTRAIT, preference: 'auto' })).toBe(1);
  });
});

