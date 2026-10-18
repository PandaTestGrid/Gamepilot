/**
 * 模块级设置（Automa 式）：存在 `step.params.settings`，与动作参数字段并列。
 * 引擎逐步消费；未实现的项会先落盘并在界面生效（如连线样式）。
 */
import { coerceStr } from '@/lib/coerce';

export type OnErrorMode = 'throw' | 'continue' | 'fallback' | 'insertData';

export type LineSegmentKind = 'next' | 'back';

export interface FlowStepGeneralSettings {
  readonly debug?: boolean;
  /** 单步覆盖：模板匹配最大等待时间（ms）；null/undefined 表示跟随全局默认（20000ms） */
  readonly matchTimeoutMs?: number | null;
  /** 单步覆盖：动作前延迟（ms）；null/undefined 表示跟随全局默认 */
  readonly preDelayMs?: number | null;
  /** 单步覆盖：动作后延迟（ms）；null/undefined 表示跟随全局默认 */
  readonly postDelayMs?: number | null;
}

export interface FlowStepInsertDataSettings {
  readonly target?: 'table' | 'variable';
  readonly key?: string;
  readonly value?: string;
}

export interface FlowStepOnErrorSettings {
  readonly enabled?: boolean;
  readonly retry?: boolean;
  readonly retryTimes?: number;
  readonly mode?: OnErrorMode;
  readonly fallbackStepId?: string;
  readonly insertData?: FlowStepInsertDataSettings;
}

export interface FlowStepLineSettings {
  readonly segment?: LineSegmentKind;
  readonly label?: string;
  readonly animated?: boolean;
  readonly color?: string;
}

export interface FlowStepSettings {
  readonly general?: FlowStepGeneralSettings;
  readonly onError?: FlowStepOnErrorSettings;
  readonly line?: FlowStepLineSettings;
}

/** 支持「调试模式」说明的步骤（浏览器 CSP 类模块；桌面端先作标记） */
export const DEBUG_CAPABLE_STEP_TYPES = new Set(['click', 'hold', 'swipe', 'key', 'text']);

export function readStepSettings(params: Record<string, unknown> | undefined): FlowStepSettings {
  const raw = params?.settings;
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  return raw;
}

export function mergeStepSettings(
  current: FlowStepSettings,
  patch: Partial<{
    general: Partial<FlowStepGeneralSettings>;
    onError: Partial<FlowStepOnErrorSettings>;
    line: Partial<FlowStepLineSettings>;
  }>,
): FlowStepSettings {
  return {
    general: patch.general ? { ...current.general, ...patch.general } : current.general,
    onError: patch.onError
      ? {
          ...current.onError,
          ...patch.onError,
          insertData: patch.onError.insertData
            ? { ...current.onError?.insertData, ...patch.onError.insertData }
            : current.onError?.insertData,
        }
      : current.onError,
    line: patch.line ? { ...current.line, ...patch.line } : current.line,
  };
}

export function settingsToParams(
  params: Record<string, unknown>,
  settings: FlowStepSettings,
): Record<string, unknown> {
  const hasContent =
    (settings.general && Object.keys(settings.general).length > 0) ||
    (settings.onError && Object.keys(settings.onError).length > 0) ||
    (settings.line && Object.keys(settings.line).length > 0);
  if (!hasContent) {
    const rest = { ...params };
    delete rest.settings;
    return rest;
  }
  return { ...params, settings };
}

export interface FlowLineVisual {
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly strokeDasharray?: string;
  readonly animated?: boolean;
  readonly label?: string;
}

export function lineStyleForStep(
  step: { params?: Record<string, unknown> } | undefined,
  segment: LineSegmentKind,
): FlowLineVisual {
  const line = readStepSettings(step?.params).line;
  const defaults: FlowLineVisual = { stroke: 'var(--fg-dim)', strokeWidth: 1.5 };
  if (!line || (line.segment ?? 'next') !== segment) {
    return defaults;
  }
  const color = coerceStr(line.color).trim();
  const animated = line.animated ?? defaults.animated;
  return {
    stroke: color || defaults.stroke,
    strokeWidth: defaults.strokeWidth,
    animated,
    ...(line.label?.trim() ? { label: line.label.trim() } : {}),
  };
}
