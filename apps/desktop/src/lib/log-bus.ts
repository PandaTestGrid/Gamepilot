/**
 * 界面日志总线：**devLog 与日志抽屉之间的唯一接口**，故意不做成 store。
 *
 * 为什么要单独一个模块：`lib/rpc.ts` 的 `devLog()` 要被 stores 引用（stores → lib 是允许的方向），
 * 如果让 rpc.ts 直接 import 某个 store，就变成 lib → stores 的反向依赖（CONVENTIONS §1）。
 * 所以这里放一个零依赖的小总线：写的人只管 push，听的人自己去订阅。
 */

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';
/** 日志来源：engine=Python 引擎（engine.log 通知），ui=界面自身（devLog） */
export type LogSource = 'engine' | 'ui';

export interface LogEntry {
  readonly id: number;
  readonly ts: number;
  readonly level: LogLevel;
  readonly source: LogSource;
  readonly logger: string;
  readonly message: string;
}

export type LogListener = (entry: LogEntry) => void;

const listeners = new Set<LogListener>();
let seq = 0;

/** 订阅界面日志；返回取消订阅函数（组件/hook 必须清理）。 */
export function onUiLog(listener: LogListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 记一条界面日志（devLog 走这里）。没有订阅者时几乎零成本。 */
export function pushUiLog(level: LogLevel, logger: string, message: string): void {
  if (listeners.size === 0) {
    return;
  }
  seq += 1;
  const entry: LogEntry = { id: seq, ts: Date.now() / 1000, level, source: 'ui', logger, message };
  for (const listener of listeners) {
    listener(entry);
  }
}

/** 引擎日志（engine.log 通知）也要走同一条序号线，保证两个来源混排时顺序稳定。 */
export function nextLogId(): number {
  seq += 1;
  return seq;
}
