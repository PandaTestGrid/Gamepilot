/**
 * 日志 store：环形缓冲 + 级别过滤，给底部抽屉的「日志」Tab 用。
 *
 * 两条来源汇进同一个列表（混排顺序按 id，稳定）：
 *   - 引擎：`engine.log` 通知（Python 侧 logging → notify，见 rpc/logs.py）
 *   - 界面：`devLog()` → lib/log-bus.ts
 *
 * 只留最近 N 条：日志是用来"看刚才发生了什么"的，不是审计。
 */
import { create } from 'zustand';

import { nextLogId, onUiLog, type LogEntry, type LogLevel, type LogSource } from '@/lib/log-bus';

const CAPACITY = 500;

export interface LogState {
  readonly entries: readonly LogEntry[];
  /** 低于这个级别的不显示（默认 info：debug 太吵） */
  readonly minLevel: LogLevel;
  readonly append: (entry: Omit<LogEntry, 'id'>) => void;
  readonly appendEngine: (params: Record<string, unknown>) => void;
  readonly setMinLevel: (level: LogLevel) => void;
  readonly clear: () => void;
  /** 订阅界面日志（devLog）；返回取消订阅函数 */
  readonly subscribeUi: () => () => void;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };

/** 只把字符串当字符串用：从 RPC 通知里来的值可能是对象，别让它变成 "[object Object]"。 */
function asText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
}

/** 引擎日志的 level 可能是 "WARNING"/"warning"/数字：统一收窄。 */
function toLevel(value: unknown): LogLevel {
  const text = asText(value, 'info').toLowerCase();
  if (text.startsWith('debug') || text === '10') {
    return 'debug';
  }
  if (text.startsWith('warn') || text === '30') {
    return 'warning';
  }
  if (text.startsWith('err') || text.startsWith('crit') || text === '40' || text === '50') {
    return 'error';
  }
  return 'info';
}

export const useLogStore = create<LogState>()((set, get) => ({
  entries: [],
  minLevel: 'debug',

  append: (entry) =>
    set((state) => {
      const next = [...state.entries, { ...entry, id: nextLogId() }];
      // 超容量就从头砍（保留最近的 CAPACITY 条）
      return { entries: next.length > CAPACITY ? next.slice(next.length - CAPACITY) : next };
    }),

  appendEngine: (params) =>
    get().append({
      ts: typeof params.ts === 'number' ? params.ts : Date.now() / 1000,
      level: toLevel(params.level),
      source: 'engine',
      logger: asText(params.logger, 'engine'),
      message: asText(params.message, ''),
    }),

  setMinLevel: (minLevel) => set({ minLevel }),
  clear: () => set({ entries: [] }),

  subscribeUi: () =>
    onUiLog((entry) => {
      get().append({
        ts: entry.ts,
        level: entry.level,
        source: entry.source,
        logger: entry.logger,
        message: entry.message,
      });
    }),
}));

/** 按级别过滤（抽屉里用）；导出成纯函数便于单测。 */
export function filterLogs(entries: readonly LogEntry[], minLevel: LogLevel): LogEntry[] {
  return entries.filter((entry) => ORDER[entry.level] >= ORDER[minLevel]);
}

/** 级别的显示色（走语义色 token，不写死颜色）。 */
export function levelTone(level: LogLevel): string {
  switch (level) {
    case 'error':
      return 'text-failed';
    case 'warning':
      return 'text-pending';
    case 'debug':
      return 'text-faint';
    default:
      return 'text-dim';
  }
}

export function sourceLabel(source: LogSource): string {
  return source === 'engine' ? '引擎' : '界面';
}
