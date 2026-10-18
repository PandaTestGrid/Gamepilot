/** 条件模块：`groups` 之间为「或」，组内 `all` 为「且」。兼容旧版单字段 `rec`。 */
import { coerceStr } from '@/lib/coerce';

export type CondMode = 'single' | 'all' | 'any';

/** 条件未命中时默认再等这么久（ms），再走「不成立」 */
export const DEFAULT_COND_MATCH_MS = 100;

export function condMatchTimeoutMs(params: Record<string, unknown>): number {
  const raw = params.timeout_ms;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, Math.round(raw));
  }
  return DEFAULT_COND_MATCH_MS;
}

export interface CondGroup {
  readonly all: readonly string[];
}

export function condModeFromParams(
  params: Record<string, unknown>,
  groups: readonly CondGroup[] = condGroupsFromParams(params),
): CondMode {
  const rawMode = params.mode;
  if (rawMode === 'single' || rawMode === 'all' || rawMode === 'any') {
    return rawMode;
  }
  if (groups.length > 1) {
    return 'any';
  }
  if ((groups[0]?.all.length ?? 0) > 1) {
    return 'all';
  }
  return 'single';
}

export function condGroupsFromParams(params: Record<string, unknown>): CondGroup[] {
  const raw = params.groups;
  if (Array.isArray(raw) && raw.length > 0) {
    const parsed = raw.map(parseCondGroup).filter((group) => group.all.length > 0);
    if (parsed.length > 0) {
      return parsed;
    }
  }
  const rec = coerceStr(params.rec).trim();
  if (rec) {
    return [{ all: [rec] }];
  }
  return [{ all: [''] }];
}

function parseCondGroup(value: unknown): CondGroup {
  if (!value || typeof value !== 'object') {
    return { all: [] };
  }
  const all = (value as { all?: unknown }).all;
  if (!Array.isArray(all)) {
    return { all: [] };
  }
  return { all: all.map((item) => coerceStr(item).trim()) };
}

export function condParamsFromGroups(groups: readonly CondGroup[], mode?: CondMode): Record<string, unknown> {
  const normalized = groups
    .map((group) => ({
      all: group.all.map((label) => label.trim()),
    }))
    .filter((group) => group.all.length > 0);
  const effectiveGroups = normalized.length > 0 ? normalized : [{ all: [''] }];
  const firstLabel = effectiveGroups.flatMap((group) => group.all).find((label) => Boolean(label)) ?? '';
  const resolvedMode: CondMode =
    mode ??
    (effectiveGroups.length > 1 ? 'any' : (effectiveGroups[0]?.all.length ?? 0) > 1 ? 'all' : 'single');
  return {
    mode: resolvedMode,
    rec: firstLabel,
    groups: effectiveGroups,
  };
}

/**
 * 落盘前归一化条件参数：
 * 保留 `mode` 与 `groups` 中的空位占位符 `''`（引擎 `cond_recognizer_labels` 与 `_condition_ok`
 * 会自动忽略空字符串），避免切换「且 / 或」或新增条件槽位后被落盘回包抹掉。
 */
export function sanitizeCondParamsForSave(params: Record<string, unknown>): Record<string, unknown> {
  const raw = params.groups;
  if (!Array.isArray(raw)) {
    return params;
  }
  const groups = raw
    .map((group) => {
      if (!group || typeof group !== 'object') {
        return null;
      }
      const all = (group as { all?: unknown }).all;
      if (!Array.isArray(all)) {
        return null;
      }
      const labels = all.map((item) => coerceStr(item).trim());
      return labels.length > 0 ? { all: labels } : null;
    })
    .filter((group): group is { all: string[] } => group !== null);
  if (groups.length === 0) {
    const rec = coerceStr(params.rec).trim();
    return rec ? { ...params, rec, groups: [{ all: [rec] }] } : { ...params, rec: '', groups: [] };
  }
  const firstLabel = groups.flatMap((group) => group.all).find((label) => Boolean(label)) ?? '';
  return { ...params, rec: firstLabel, groups };
}

export function condSummaryFromParams(params: Record<string, unknown>): string {
  const groups = condGroupsFromParams(params).filter((group) => group.all.some(Boolean));
  if (groups.length === 0) {
    return '';
  }
  const parts = groups.map((group) => group.all.filter(Boolean).join(' 且 '));
  return parts.join(' 或 ');
}

export function condRecognizerLabels(params: Record<string, unknown>): string[] {
  const labels = new Set<string>();
  for (const group of condGroupsFromParams(params)) {
    for (const label of group.all) {
      if (label) {
        labels.add(label);
      }
    }
  }
  return [...labels];
}
