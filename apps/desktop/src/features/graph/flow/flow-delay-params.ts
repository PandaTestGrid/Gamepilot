export const DEFAULT_DELAY_MS = 500;
export const MAX_DELAY_MS = 600_000;

export interface DelayPreset {
  readonly ms: number;
  readonly label: string;
}

export const DELAY_PRESETS: readonly DelayPreset[] = [
  { ms: 200, label: '200ms' },
  { ms: 500, label: '500ms' },
  { ms: 1000, label: '1s' },
  { ms: 2000, label: '2s' },
  { ms: 5000, label: '5s' },
];

export function normalizeDelayMs(raw: unknown): number {
  if (raw === '' || raw === null || raw === undefined) {
    return DEFAULT_DELAY_MS;
  }
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(num)) {
    return DEFAULT_DELAY_MS;
  }
  if (num < 0) {
    return 0;
  }
  return Math.min(MAX_DELAY_MS, Math.round(num));
}

export function delayMsOf(params: Record<string, unknown> | undefined): number {
  return normalizeDelayMs(params?.ms);
}

/** 随机等待范围：`random` 为真时每次进入步骤从 [min, max] 里抽一个毫秒值。 */
export interface RandomDelayRange {
  readonly random: boolean;
  readonly min: number;
  readonly max: number;
}

export const RANDOM_DELAY_DEFAULT_MIN = 300;
export const RANDOM_DELAY_DEFAULT_MAX = 1200;

export function delayIsRandom(params: Record<string, unknown> | undefined): boolean {
  return params?.random === true;
}

/** 读配置范围：缺字段回退到固定 ms，并保证 min <= max。 */
export function randomDelayRangeOf(params: Record<string, unknown> | undefined): RandomDelayRange {
  const fallback = delayMsOf(params);
  const min = isUnset(params?.minMs) ? fallback : normalizeDelayMs(params?.minMs);
  const max = isUnset(params?.maxMs) ? fallback : normalizeDelayMs(params?.maxMs);
  return { random: delayIsRandom(params), min: Math.min(min, max), max: Math.max(min, max) };
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** 打开随机时的默认范围：以当前固定延时为下限，上限至少翻倍（方便直接微调）。 */
export function defaultRandomRange(params: Record<string, unknown> | undefined): { min: number; max: number } {
  const base = delayMsOf(params);
  return { min: base, max: Math.min(MAX_DELAY_MS, Math.max(base + 500, base * 2, RANDOM_DELAY_DEFAULT_MAX)) };
}

/** 写入随机参数：`enabled=false` 时保留范围字段，只关随机，切回固定延时仍用原 ms。 */
export function randomDelayPatch(
  params: Record<string, unknown> | undefined,
  enabled: boolean,
): Record<string, unknown> {
  if (!enabled) {
    return { random: false };
  }
  const current = randomDelayRangeOf(params);
  const range = params?.minMs === undefined || params?.maxMs === undefined
    ? defaultRandomRange(params)
    : { min: current.min, max: current.max };
  return { random: true, minMs: range.min, maxMs: range.max };
}
