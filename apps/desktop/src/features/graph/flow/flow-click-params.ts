import { clampUnitCoord, formatCoordPair } from '@/features/graph/flow/flow-coord-utils';
import {
  CLICK_BY_REGION,
  formatClickRegionSummary,
  isNormRect,
} from '@/features/graph/flow/flow-click-region';
import { coerceStr } from '@/lib/coerce';

/** 点击定位协议值；展示文案由 CLICK_TARGET_MODE_OPTIONS 单独提供。 */
export const CLICK_BY_COORD = 'coord';
export const CLICK_BY_RECOGNIZER = 'recognizer';
export { CLICK_BY_REGION };

export type ClickTargetMode = 'coord' | 'recognizer' | 'region';

/** 识别类点击的细分：图像（模板/颜色/文字识别器） vs AI（YOLO 识别器）。 */
export type ClickTargetKind = 'image' | 'ai';

export type ClickEventKind = 'click' | 'double_click' | 'long_press';

export const CLICK_EVENT_OPTIONS: ReadonlyArray<{
  readonly id: ClickEventKind;
  readonly label: string;
}> = [
  { id: 'click', label: '点击' },
  { id: 'double_click', label: '双击' },
  { id: 'long_press', label: '长按' },
];

/**
 * 点击方式下拉项：识别类在这里拆成两项，用户不用先猜类别。
 *
 * 协议上两者都是 `by: "recognizer"`；细分只落在 `params.ai`（界面提示），
 * 引擎不读它，也不会影响旧图的执行。`image` 缺省就不写这个字段。
 */
export const CLICK_TARGET_MODE_OPTIONS: ReadonlyArray<{
  readonly value: ClickTargetKind | 'coord' | 'region';
  readonly label: string;
}> = [
  { value: 'image', label: '图像识别' },
  { value: 'ai', label: 'AI 识别' },
  { value: 'coord', label: '坐标点' },
  { value: 'region', label: '范围内随机' },
];

/** 识别类点击的细分：显式 `ai` 优先，其次看选中的识别器类型。 */
export function clickTargetKind(
  params: Record<string, unknown> | undefined,
  recognizerType?: string,
): ClickTargetKind {
  if (params?.ai === true) {
    return 'ai';
  }
  return recognizerType === 'yolo' ? 'ai' : 'image';
}

/** 下拉框当前值（识别类返回细分，其余返回协议值；非法 by 返回 null）。 */
export function clickSelectValue(
  params: Record<string, unknown> | undefined,
  recognizerType?: string,
): ClickTargetKind | 'coord' | 'region' | null {
  const mode = clickTargetMode(params);
  if (mode === null) {
    return null;
  }
  return mode === 'recognizer' ? clickTargetKind(params, recognizerType) : mode;
}


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

/** 显式未知协议值返回 null，不能再按残留字段推断，避免旧值被静默当成可执行目标。 */
export function clickTargetMode(params: Record<string, unknown> | undefined): ClickTargetMode | null {
  const by = params?.by;
  if (by === CLICK_BY_RECOGNIZER) {
    return 'recognizer';
  }
  if (by === CLICK_BY_REGION) {
    return 'region';
  }
  if (by === CLICK_BY_COORD) {
    return 'coord';
  }
  if (by !== undefined) {
    return null;
  }
  if (coerceStr(params?.rec).trim()) {
    return 'recognizer';
  }
  return isNormRect(params?.rect) ? 'region' : 'coord';
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
  kind: ClickTargetKind = 'image',
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params, ...clickModePatch(mode) };
  if (mode === 'recognizer') {
    next.ai = kind === 'ai' ? true : undefined;
    next.rect = undefined;
    next.screenAspect = undefined;
    next.x = undefined;
    next.y = undefined;
    next.preview = undefined;
    return next;
  }
  next.ai = undefined;
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
  const mode = clickTargetMode(params);
  if (mode === null) {
    return '无效点击方式';
  }
  if (mode === 'region') {
    return formatClickRegionSummary(params);
  }
  return formatCoordPair(params?.x, params?.y);
}
