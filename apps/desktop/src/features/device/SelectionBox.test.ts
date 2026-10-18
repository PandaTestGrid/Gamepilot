import { describe, expect, it } from 'vitest';

import { moveSelection, resizePickSquare, resizeSelection } from './SelectionBox';

describe('选区编辑几何', () => {
  it('整体拖动并钳在画面内', () => {
    const moved = moveSelection([0.1, 0.2, 0.2, 0.2], 0.05, -0.5);
    expect(moved[0]).toBeCloseTo(0.15);
    expect(moved[1]).toBe(0);
    expect(moveSelection([0.8, 0.8, 0.2, 0.2], 0.5, 0.5)).toEqual([0.8, 0.8, 0.2, 0.2]);
  });

  it('框选四角自由缩放', () => {
    const se = resizeSelection([0.1, 0.2, 0.2, 0.2], 'se', 0.1, 0.1);
    expect(se[0]).toBeCloseTo(0.1);
    expect(se[1]).toBeCloseTo(0.2);
    expect(se[2]).toBeCloseTo(0.3);
    expect(se[3]).toBeCloseTo(0.3);

    const nw = resizeSelection([0.2, 0.2, 0.3, 0.3], 'nw', 0.1, 0.1);
    expect(nw[0]).toBeCloseTo(0.3);
    expect(nw[1]).toBeCloseTo(0.3);
    expect(nw[2]).toBeCloseTo(0.2);
    expect(nw[3]).toBeCloseTo(0.2);
  });

  it('点选四角缩放保持设备像素正方形', () => {
    // 600×1200，120px 方形（w=0.2, h=0.1），拖右下角到 (0.5, 0.5)
    const next = resizePickSquare([0.1, 0.1, 0.2, 0.1], 'se', [0.5, 0.5], [600, 1200]);
    expect(next.pickPx).toBe(320); // 超过上限，收到 320
    expect(next.rect[2] * 600).toBeCloseTo(320);
    expect(next.rect[3] * 1200).toBeCloseTo(320);
    expect(next.pickCenter[0]).toBeCloseTo(next.rect[0] + next.rect[2] / 2);
  });

  it('点选缩放有最小 32px，且不越界', () => {
    const tiny = resizePickSquare([0.1, 0.1, 0.2, 0.1], 'se', [0.1001, 0.1001], [600, 1200]);
    expect(tiny.pickPx).toBe(32);
    expect(tiny.rect[2] * 600).toBeCloseTo(32);

    const nearEdge = resizePickSquare([0.1, 0.1, 0.2, 0.1], 'nw', [0, 0], [600, 1200]);
    expect(nearEdge.rect[0]).toBeGreaterThanOrEqual(0);
    expect(nearEdge.rect[1]).toBeGreaterThanOrEqual(0);
    expect(nearEdge.rect[0] + nearEdge.rect[2]).toBeLessThanOrEqual(1);
    expect(nearEdge.rect[1] + nearEdge.rect[3]).toBeLessThanOrEqual(1);
  });
});
