import { formatCoordPair } from '@/features/graph/flow/flow-coord-utils';

export type SwipePresetId = 'up' | 'down' | 'left' | 'right';

/** 滑动方式：点对点（两点直线）/ 连续（录下来的轨迹）。 */
export type SwipeMode = 'point' | 'track';

export const SWIPE_MODE_OPTIONS: ReadonlyArray<{ readonly id: SwipeMode; readonly label: string }> = [
  { id: 'point', label: '点对点滑动' },
  { id: 'track', label: '连续滑动' },
];

export type SwipeEasingId = 'linear' | 'ease_in' | 'ease_out' | 'ease_in_out';

export const SWIPE_EASING_OPTIONS: ReadonlyArray<{ readonly id: SwipeEasingId; readonly label: string }> = [
  { id: 'linear', label: '匀速' },
  { id: 'ease_in', label: '先慢后快' },
  { id: 'ease_out', label: '先快后慢' },
  { id: 'ease_in_out', label: '先慢中快后慢' },
];

export const DEFAULT_SWIPE_BEZIER = {
  swipe_bezier: true,
  swipe_bezier_order: 3,
  swipe_bezier_deviation_px: 6,
  swipe_bezier_bias: 0.5,
  swipe_easing: 'ease_in_out' as SwipeEasingId,
  swipe_end_wobble: 0,
  swipe_end_wobble_px: 12,
};

export function parseSwipeEasing(
  value: unknown,
  fallback: SwipeEasingId = DEFAULT_SWIPE_BEZIER.swipe_easing,
): SwipeEasingId {
  if (value === 0 || value === '0' || value === 'linear') {
    return 'linear';
  }
  if (value === 1 || value === '1' || value === 'ease_in') {
    return 'ease_in';
  }
  if (value === 2 || value === '2' || value === 'ease_out') {
    return 'ease_out';
  }
  if (value === 3 || value === '3' || value === 'ease_in_out') {
    return 'ease_in_out';
  }
  return fallback;
}

export function parseOptionalBool(value: unknown): boolean | undefined {
  if (value === true || value === 'true' || value === 1 || value === '1') {
    return true;
  }
  if (value === false || value === 'false' || value === 0 || value === '0') {
    return false;
  }
  return undefined;
}

export function swipeBezierMode(params: Record<string, unknown> | undefined): 'global' | 'on' | 'off' {
  const flag = parseOptionalBool(params?.bezier);
  if (flag === true) {
    return 'on';
  }
  if (flag === false) {
    return 'off';
  }
  return 'global';
}

export const SWIPE_PRESETS: ReadonlyArray<{
  readonly id: SwipePresetId;
  readonly label: string;
  readonly params: { x: number; y: number; to_x: number; to_y: number };
}> = [
  { id: 'up', label: '上滑', params: { x: 0.5, y: 0.75, to_x: 0.5, to_y: 0.25 } },
  { id: 'down', label: '下滑', params: { x: 0.5, y: 0.25, to_x: 0.5, to_y: 0.75 } },
  { id: 'left', label: '左滑', params: { x: 0.75, y: 0.5, to_x: 0.25, to_y: 0.5 } },
  { id: 'right', label: '右滑', params: { x: 0.25, y: 0.5, to_x: 0.75, to_y: 0.5 } },
];

/** 连续轨迹的点数；0 表示这条滑动是直线（没有 path）。 */
export function swipeTrackPointCount(params: Record<string, unknown> | undefined): number {
  const path = params?.path;
  return Array.isArray(path) ? path.length : 0;
}

/**
 * 当前滑动方式。
 *
 * 新数据用 `swipe_mode` 显式保存（选择框切过去即使还没录轨迹也不会跳回去）；
 * 老数据没有这个键，就按「有轨迹 = 连续滑动」推断，和以前的回放行为一致。
 */
export function resolveSwipeMode(params: Record<string, unknown> | undefined): SwipeMode {
  const raw = params?.swipe_mode;
  if (raw === 'point' || raw === 'track') {
    return raw;
  }
  return swipeTrackPointCount(params) >= 3 ? 'track' : 'point';
}

/** 末端保持时长（ms）；0 表示松手即结束。 */
export function parseSwipeHoldMs(params: Record<string, unknown> | undefined): number {
  const raw = params?.hold_ms;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(5000, Math.round(value));
}

export function formatSwipeSummary(params: Record<string, unknown> | undefined): string {
  const from = formatCoordPair(params?.x, params?.y);
  const to = formatCoordPair(params?.to_x, params?.to_y);
  const ms = Number(params?.duration_ms ?? 300);
  const points = swipeTrackPointCount(params);
  const hold = parseSwipeHoldMs(params);
  const extras = [points >= 3 ? `连续 ${points} 点` : '', hold > 0 ? `按住 ${hold}ms` : ''].filter(Boolean);
  return `${from} → ${to} · ${ms}ms${extras.length > 0 ? ` · ${extras.join(' · ')}` : ''}`;
}

export function matchingSwipePresetId(params: Record<string, unknown> | undefined): SwipePresetId | null {
  const match = SWIPE_PRESETS.find(
    (preset) =>
      Number(params?.x) === preset.params.x &&
      Number(params?.y) === preset.params.y &&
      Number(params?.to_x) === preset.params.to_x &&
      Number(params?.to_y) === preset.params.to_y,
  );
  return match?.id ?? null;
}
