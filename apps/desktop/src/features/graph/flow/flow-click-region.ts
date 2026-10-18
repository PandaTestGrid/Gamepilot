/** 点击模块：归一化矩形内随机落点（与引擎 `by=随机范围` + `rect` 对齐） */

export const CLICK_BY_REGION = '随机范围';

/** 无分辨率信息时示意图默认竖屏（宽/高） */
export const DEFAULT_SCREEN_ASPECT = 9 / 19.5;

export type NormRect = readonly [number, number, number, number];

export function screenAspectFromResolution(resolution: readonly [number, number] | undefined | null): number {
  if (!resolution || resolution[0] <= 0 || resolution[1] <= 0) {
    return DEFAULT_SCREEN_ASPECT;
  }
  return resolution[0] / resolution[1];
}

export function readScreenAspect(params: Record<string, unknown> | undefined): number {
  const raw = params?.screenAspect;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_SCREEN_ASPECT;
}

/** 示意图宽高比：优先当前设备分辨率，其次步骤里保存的 screenAspect */
export function resolveScreenAspect(
  params: Record<string, unknown> | undefined,
  liveResolution?: readonly [number, number] | null,
): number {
  if (liveResolution && liveResolution[0] > 0 && liveResolution[1] > 0) {
    return liveResolution[0] / liveResolution[1];
  }
  return readScreenAspect(params);
}

/** 示意图外框像素尺寸（aspect = 宽/高，longSide 为较长边上限） */
export function screenPreviewBoxSize(aspect: number, longSide: number): { width: number; height: number } {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_SCREEN_ASPECT;
  if (ratio >= 1) {
    return {
      width: longSide,
      height: Math.max(8, Math.round(longSide / ratio)),
    };
  }
  return {
    width: Math.max(8, Math.round(longSide * ratio)),
    height: longSide,
  };
}

const MIN_SIDE = 0.01;

export function isNormRect(value: unknown): value is NormRect {
  if (!Array.isArray(value) || value.length !== 4) {
    return false;
  }
  const x = Number(value[0]);
  const y = Number(value[1]);
  const w = Number(value[2]);
  const h = Number(value[3]);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) {
    return false;
  }
  return w >= MIN_SIDE && h >= MIN_SIDE && x >= 0 && y >= 0 && x + w <= 1.001 && y + h <= 1.001;
}

/** 把框选结果收进 [0,1] 并保证有最小边长 */
export function normalizeClickRegionRect(rect: readonly [number, number, number, number]): NormRect {
  let [x, y, w, h] = rect;
  x = Math.min(1, Math.max(0, x));
  y = Math.min(1, Math.max(0, y));
  w = Math.max(MIN_SIDE, Math.min(1 - x, w));
  h = Math.max(MIN_SIDE, Math.min(1 - y, h));
  return [x, y, w, h];
}

export function formatClickRegionSummary(params: Record<string, unknown> | undefined): string {
  const rect = params?.rect;
  if (!isNormRect(rect)) {
    return '未框选范围';
  }
  const [x, y, w, h] = rect;
  return `随机 ${w.toFixed(2)}×${h.toFixed(2)} @${x.toFixed(2)},${y.toFixed(2)}`;
}
