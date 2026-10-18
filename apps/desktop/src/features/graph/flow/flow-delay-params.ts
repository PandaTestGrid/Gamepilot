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
