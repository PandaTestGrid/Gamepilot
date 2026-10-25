import { describe, expect, it } from 'vitest';

import {
  formatClickRegionSummary,
  isNormRect,
  normalizeClickRegionRect,
  resolveScreenAspect,
  screenAspectFromResolution,
  screenPreviewBoxSize,
} from '@/features/graph/flow/flow-click-region';
import { clickTargetMode, formatClickCoordSummary } from '@/features/graph/flow/flow-click-params';

describe('flow-click-region', () => {
  it('从分辨率得到宽/高比', () => {
    expect(screenAspectFromResolution([1080, 1920])).toBeCloseTo(1080 / 1920);
    expect(screenAspectFromResolution(null)).toBeGreaterThan(0);
  });

  it('示意图尺寸与宽高比：横屏宽大于高，竖屏高大于宽', () => {
    const landscape = screenPreviewBoxSize(1920 / 1080, 56);
    expect(landscape.width).toBe(56);
    expect(landscape.height).toBeLessThan(landscape.width);

    const portrait = screenPreviewBoxSize(1080 / 1920, 56);
    expect(portrait.height).toBe(56);
    expect(portrait.width).toBeLessThan(portrait.height);
  });

  it('resolveScreenAspect 优先当前设备分辨率', () => {
    expect(resolveScreenAspect({ screenAspect: 9 / 19.5 }, [1920, 1080])).toBeCloseTo(1920 / 1080);
  });

  it('归一化矩形并校验', () => {
    const n = normalizeClickRegionRect([0.9, 0.8, 0.5, 0.5]);
    expect(n[0]).toBe(0.9);
    expect(n[1]).toBe(0.8);
    expect(n[2]).toBeCloseTo(0.1);
    expect(n[3]).toBeCloseTo(0.2);
    expect(isNormRect([0.1, 0.2, 0.3, 0.4])).toBe(true);
    expect(isNormRect([0, 0, 0, 0])).toBe(false);
  });

  it('点击方式识别随机范围', () => {
    expect(clickTargetMode({ by: 'region', rect: [0.1, 0.2, 0.3, 0.4] })).toBe('region');
    expect(formatClickCoordSummary({ by: 'region', rect: [0.1, 0.2, 0.3, 0.4] })).toContain('随机');
    expect(formatClickRegionSummary({ rect: [0.1, 0.2, 0.3, 0.4] })).toContain('0.30×0.40');
  });
});
