import { coerceStr } from '@/lib/coerce';

export type ScheduleMode = 'daily' | 'once' | 'weekly' | 'monthly';
export type IntervalUnit = 'seconds' | 'minutes' | 'hours';

export const WEEKDAY_OPTIONS: ReadonlyArray<{ readonly value: number; readonly label: string }> = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 7, label: '日' },
];

export function scheduleModeOf(params: Record<string, unknown>): ScheduleMode {
  const raw = coerceStr(params.mode).trim().toLowerCase();
  if (raw === 'once' || raw === 'date') {
    return 'once';
  }
  if (raw === 'weekly') {
    return 'weekly';
  }
  if (raw === 'monthly') {
    return 'monthly';
  }
  return 'daily';
}

export function scheduleAtOf(params: Record<string, unknown>): string {
  const at = coerceStr(params.at).trim();
  return at || '09:00';
}

export function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function scheduleDateOf(params: Record<string, unknown>): string {
  const date = coerceStr(params.date).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayYmd();
}

export function scheduleWeekdaysOf(params: Record<string, unknown>): number[] {
  const raw = params.weekdays;
  if (!Array.isArray(raw)) {
    return [1, 2, 3, 4, 5];
  }
  const days = raw.map((item) => Number(item)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  return days.length > 0 ? [...new Set(days)].sort((a, b) => a - b) : [1];
}

export function scheduleDayOfMonthOf(params: Record<string, unknown>): number {
  const num = Number(params.dayOfMonth);
  if (!Number.isFinite(num)) {
    return 1;
  }
  return Math.min(31, Math.max(1, Math.round(num)));
}

export function intervalEveryOf(params: Record<string, unknown>): number {
  const num = Number(params.every);
  if (!Number.isFinite(num) || num < 1) {
    return 30;
  }
  return Math.max(1, Math.round(num));
}

export function intervalUnitOf(params: Record<string, unknown>): IntervalUnit {
  const raw = coerceStr(params.unit).trim().toLowerCase();
  if (raw === 'seconds' || raw === 'hours') {
    return raw;
  }
  return 'minutes';
}

export function formatTriggerSummary(type: string, params: Record<string, unknown>): string {
  if (type === 'manual') {
    return '手动触发';
  }
  if (type === 'interval') {
    const every = intervalEveryOf(params);
    const unit = intervalUnitOf(params);
    const unitLabel = unit === 'seconds' ? '秒' : unit === 'hours' ? '小时' : '分钟';
    return `间隔触发 · 每 ${every} ${unitLabel}`;
  }
  if (type === 'schedule') {
    const mode = scheduleModeOf(params);
    const at = scheduleAtOf(params);
    if (mode === 'once') {
      const date = coerceStr(params.date).trim();
      return date ? `定时 · ${date} ${at}` : `定时 · 单次 ${at}`;
    }
    if (mode === 'weekly') {
      const days = scheduleWeekdaysOf(params);
      if (days.length === 7) {
        return `定时 · 每天 ${at}`;
      }
      const names = days
        .map((d) => WEEKDAY_OPTIONS.find((opt) => opt.value === d)?.label ?? String(d))
        .join('');
      return `定时 · 周${names} ${at}`;
    }
    if (mode === 'monthly') {
      const day = scheduleDayOfMonthOf(params);
      return `定时 · 每月${day}日 ${at}`;
    }
    return `定时触发 · ${at}`;
  }
  return type;
}
