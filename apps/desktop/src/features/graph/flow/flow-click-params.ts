import { clampUnitCoord, formatCoordPair } from '@/features/graph/flow/flow-coord-utils';
import {
  CLICK_BY_REGION,
  formatClickRegionSummary,
  isNormRect,
} from '@/features/graph/flow/flow-click-region';
import { coerceStr } from '@/lib/coerce';

/** 引擎 `flow_engine._spec_for` 只认 params.by ===「坐标」 */
export const CLICK_BY_COORD = '坐标';
export const CLICK_BY_RECOGNIZER = '识别器';
export { CLICK_BY_REGION };

export type ClickTargetMode = 'coord' | 'recognizer' | 'region';

export type ClickEventKind = 'click' | 'double_click' | 'long_press';

export const CLICK_EVENT_OPTIONS: ReadonlyArray<{
  readonly id: ClickEventKind;
  readonly label: string;
}> = [
  { id: 'click', label: '点击' },
  { id: 'double_click', label: '双击' },
  { id: 'long_press', label: '长按' },
];

/** 点击方式：图像优先（新建节点默认也是图像） */
export const CLICK_TARGET_MODE_OPTIONS: ReadonlyArray<{
  readonly id: ClickTargetMode;
  readonly label: string;
}> = [
  { id: 'recognizer', label: '图像' },
  { id: 'coord', label: '坐标点' },
  { id: 'region', label: '范围内随机' },
];

export function clickEventKind(
  params: Record<string, unknown> | undefined,
  stepType?: string,
): ClickEventKind {
  const raw = coerceStr(params?.event || params?.clickType).trim();
  if (raw === 'double_click' || raw === 'double') {
    return 'double_click';
  }
  if (raw === 'long_press' || raw === 'hold') {
    return 'long_press';
  }
  if (raw === 'click') {
    return 'click';
  }
  if (stepType === 'hold') {
    return 'long_press';
  }
  return 'click';
}

export function clickEventLabel(kind: ClickEventKind): string {
  switch (kind) {
    case 'double_click':
      return '双击';
    case 'long_press':
      return '长按';
    default:
      return '点击';
  }
}

export function clickEventPatch(
  event: ClickEventKind,
  params?: Record<string, unknown>,
): Record<string, unknown> {
  if (event === 'long_press') {
    const rawDuration = Number(params?.duration_ms ?? 600);
    const duration_ms = Number.isFinite(rawDuration) && rawDuration >= 50 ? Math.round(rawDuration) : 600;
    return { event: 'long_press', duration_ms };
  }
  return { event };
}

export function clickTargetMode(params: Record<string, unknown> | undefined): ClickTargetMode {
  const by = coerceStr(params?.by);
  if (by === CLICK_BY_RECOGNIZER) {
    return 'recognizer';
  }
  if (by === CLICK_BY_REGION) {
    return 'region';
  }
  if (by === CLICK_BY_COORD) {
    return 'coord';
  }
  if (isNormRect(params?.rect)) {
    return 'region';
  }
  return coerceStr(params?.rec).trim() ? 'recognizer' : 'coord';
}

export function clickModePatch(mode: ClickTargetMode): Record<string, unknown> {
  if (mode === 'recognizer') {
    return { by: CLICK_BY_RECOGNIZER };
  }
  if (mode === 'region') {
    return { by: CLICK_BY_REGION, rec: '' };
  }
  return { by: CLICK_BY_COORD, rec: '' };
}

function centerFromRect(params: Record<string, unknown>): { x: number; y: number } | null {
  if (!isNormRect(params.rect)) {
    return null;
  }
  const [rx, ry, w, h] = params.rect;
  return { x: clampUnitCoord(rx + w / 2), y: clampUnitCoord(ry + h / 2) };
}

/** 切换点击方式时清掉其它方式的落点字段，避免引擎误用残留 x/y 或 rect */
export function mergeClickTargetParams(
  params: Record<string, unknown>,
  mode: ClickTargetMode,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params, ...clickModePatch(mode) };
  if (mode === 'region') {
    next.x = undefined;
    next.y = undefined;
    next.preview = undefined;
  } else if (mode === 'coord') {
    next.rect = undefined;
    next.screenAspect = undefined;
    next.preview = undefined;
    const center = centerFromRect(params);
    if (center) {
      next.x = center.x;
      next.y = center.y;
    } else if (next.x === undefined || next.y === undefined) {
      next.x = Number.isFinite(Number(next.x)) ? Number(next.x) : 0.5;
      next.y = Number.isFinite(Number(next.y)) ? Number(next.y) : 0.5;
    }
  } else {
    next.rect = undefined;
    next.screenAspect = undefined;
    next.x = undefined;
    next.y = undefined;
    next.preview = undefined;
  }
  return next;
}

export function formatClickCoordSummary(params: Record<string, unknown> | undefined): string {
  if (clickTargetMode(params) === 'region') {
    return formatClickRegionSummary(params);
  }
  return formatCoordPair(params?.x, params?.y);
}
