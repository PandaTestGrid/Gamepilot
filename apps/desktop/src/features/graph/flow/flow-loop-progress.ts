/**
 * 引擎循环栈进度：事件 extra.loops 里的 current/total，给循环节点头部画「2 / 12」。
 */
export interface LoopProgress {
  readonly current: number;
  readonly total: number;
}

function asPositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) {
    return null;
  }
  return Math.floor(n);
}

export function loopProgressMapFromExtra(
  extra: { readonly loops?: unknown } | null | undefined,
): Readonly<Record<string, LoopProgress>> | null {
  const raw = extra?.loops;
  if (!Array.isArray(raw)) {
    return null;
  }
  const next: Record<string, LoopProgress> = {};
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const row = item as { stepId?: unknown; current?: unknown; total?: unknown };
    const stepId = typeof row.stepId === 'string' ? row.stepId : '';
    const current = asPositiveInt(row.current);
    const total = asPositiveInt(row.total);
    if (!stepId || current === null || total === null) {
      continue;
    }
    next[stepId] = { current: Math.min(current, total), total };
  }
  return next;
}

export function flowLoopRunningTitle(progress: LoopProgress): string {
  return `循环 · ${progress.current} / ${progress.total}`;
}
