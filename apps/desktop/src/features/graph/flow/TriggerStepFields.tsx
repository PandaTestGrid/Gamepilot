import { type ReactNode } from 'react';

import {
  intervalEveryOf,
  intervalUnitOf,
  scheduleAtOf,
  scheduleDateOf,
  scheduleDayOfMonthOf,
  scheduleModeOf,
  scheduleWeekdaysOf,
  todayYmd,
  WEEKDAY_OPTIONS,
  type IntervalUnit,
  type ScheduleMode,
} from '@/features/graph/flow/flow-trigger-params';
import type { TriggerType } from '@/features/graph/flow/flow-step-meta';
import { cn } from '@/lib/utils';

const SCHEDULE_MODES: ReadonlyArray<{ readonly id: ScheduleMode; readonly label: string }> = [
  { id: 'daily', label: '每天' },
  { id: 'once', label: '指定日期' },
  { id: 'weekly', label: '每周' },
  { id: 'monthly', label: '每月' },
];

const INTERVAL_PRESETS: ReadonlyArray<{
  readonly every: number;
  readonly unit: IntervalUnit;
  readonly label: string;
}> = [
  { every: 5, unit: 'minutes', label: '5分' },
  { every: 15, unit: 'minutes', label: '15分' },
  { every: 30, unit: 'minutes', label: '30分' },
  { every: 1, unit: 'hours', label: '1小时' },
];

export function TriggerStepFields({
  stepType,
  params,
  compact = false,
  onChangeTypeAndParams,
  onPatchParams,
  className,
}: {
  stepType: string;
  params: Record<string, unknown>;
  compact?: boolean;
  onChangeTypeAndParams: (nextType: TriggerType, nextParams: Record<string, unknown>) => void;
  onPatchParams: (patch: Record<string, unknown>) => void;
  className?: string;
}): ReactNode {
  const currentType: TriggerType = stepType === 'schedule' || stepType === 'interval' ? stepType : 'manual';
  const scheduleMode = scheduleModeOf(params);
  const at = scheduleAtOf(params);
  const date = scheduleDateOf(params);
  const weekdays = scheduleWeekdaysOf(params);
  const dayOfMonth = scheduleDayOfMonthOf(params);
  const every = intervalEveryOf(params);
  const unit = intervalUnitOf(params);

  const textSize = compact ? 'text-[10px]' : 'text-badge';
  const inputCls = cn(
    'nodrag nopan rounded-sm border border-line bg-canvas px-1.5 text-fg focus:border-brand focus:outline-none',
    compact ? 'h-5 text-[10px]' : 'h-6 text-badge',
  );

  const handleSelectTriggerType = (nextType: TriggerType): void => {
    if (nextType === currentType) {
      return;
    }
    if (nextType === 'manual') {
      onChangeTypeAndParams('manual', {});
      return;
    }
    if (nextType === 'schedule') {
      onChangeTypeAndParams('schedule', {
        mode: scheduleMode,
        at,
        ...(scheduleMode === 'once' ? { date } : {}),
        ...(scheduleMode === 'weekly' ? { weekdays } : {}),
        ...(scheduleMode === 'monthly' ? { dayOfMonth } : {}),
      });
      return;
    }
    onChangeTypeAndParams('interval', {
      every,
      unit,
    });
  };

  const handleScheduleModeChange = (nextMode: ScheduleMode): void => {
    if (nextMode === 'daily') {
      onPatchParams({ mode: 'daily', at });
      return;
    }
    if (nextMode === 'once') {
      onPatchParams({ mode: 'once', date: params.date ? date : todayYmd(), at });
      return;
    }
    if (nextMode === 'weekly') {
      onPatchParams({ mode: 'weekly', weekdays, at });
      return;
    }
    onPatchParams({ mode: 'monthly', dayOfMonth, at });
  };

  const toggleWeekday = (day: number): void => {
    const exists = weekdays.includes(day);
    const next = exists ? weekdays.filter((d) => d !== day) : [...weekdays, day].sort((a, b) => a - b);
    if (next.length === 0) {
      return;
    }
    onPatchParams({ weekdays: next });
  };

  return (
    <div
      className={cn('nodrag nopan space-y-1.5', className)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      data-testid="trigger-step-fields"
    >
      {/* 触发方式切换 */}
      <div className="grid grid-cols-3 gap-0.5 rounded-sm border border-line bg-canvas p-0.5">
        {(
          [
            { id: 'manual', label: '手动触发' },
            { id: 'schedule', label: '定时/日期' },
            { id: 'interval', label: '间隔循环' },
          ] as const
        ).map((tab) => {
          const active = currentType === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                handleSelectTriggerType(tab.id);
              }}
              className={cn(
                'nodrag nopan rounded-sm py-0.5 text-center transition-colors',
                textSize,
                active
                  ? 'bg-brand/20 font-medium text-brand ring-1 ring-inset ring-brand/50'
                  : 'text-dim hover:bg-raised hover:text-fg',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 定时/日期详细设置 */}
      {currentType === 'schedule' ? (
        <div className="space-y-1.5">
          {/* 周期模式：每天 / 指定日期 / 每周 / 每月 */}
          <div className="grid grid-cols-4 gap-0.5 rounded-sm border border-line bg-canvas p-0.5">
            {SCHEDULE_MODES.map((m) => {
              const active = scheduleMode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleScheduleModeChange(m.id);
                  }}
                  className={cn(
                    'nodrag nopan rounded-sm py-0.5 text-center transition-colors',
                    compact ? 'text-[9px]' : 'text-[10px]',
                    active
                      ? 'bg-raised font-medium text-fg ring-1 ring-inset ring-line'
                      : 'text-faint hover:text-dim',
                  )}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          {/* 指定日期 */}
          {scheduleMode === 'once' ? (
            <div className="flex items-center justify-between gap-1.5">
              <span className={cn('shrink-0 text-faint', textSize)}>执行日期</span>
              <input
                type="date"
                value={date}
                onChange={(event) => onPatchParams({ mode: 'once', date: event.target.value })}
                className={cn(inputCls, 'flex-1 font-mono')}
              />
            </div>
          ) : null}

          {/* 每周几 */}
          {scheduleMode === 'weekly' ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-0.5">
                {WEEKDAY_OPTIONS.map((opt) => {
                  const selected = weekdays.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      title={`周${opt.label}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleWeekday(opt.value);
                      }}
                      className={cn(
                        'nodrag nopan flex-1 rounded-sm border py-0.5 text-center font-mono transition-colors',
                        compact ? 'text-[9px]' : 'text-[10px]',
                        selected
                          ? 'border-brand/60 bg-brand/20 font-medium text-brand'
                          : 'border-line bg-canvas text-faint hover:text-dim',
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* 每月几号 */}
          {scheduleMode === 'monthly' ? (
            <div className="flex items-center justify-between gap-1.5">
              <span className={cn('shrink-0 text-faint', textSize)}>每月日期</span>
              <div className="flex flex-1 items-center gap-1">
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={dayOfMonth}
                  onChange={(event) =>
                    onPatchParams({
                      mode: 'monthly',
                      dayOfMonth: Math.min(31, Math.max(1, Number(event.target.value) || 1)),
                    })
                  }
                  className={cn(inputCls, 'w-16 font-mono')}
                />
                <span className={cn('text-faint', textSize)}>号</span>
              </div>
            </div>
          ) : null}

          {/* 触发时间 HH:MM */}
          <div className="flex items-center justify-between gap-1.5">
            <span className={cn('shrink-0 text-faint', textSize)}>触发时间</span>
            <input
              type="time"
              value={at}
              onChange={(event) => onPatchParams({ at: event.target.value || '09:00' })}
              className={cn(inputCls, 'flex-1 font-mono')}
            />
          </div>
        </div>
      ) : null}

      {/* 间隔循环详细设置 */}
      {currentType === 'interval' ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <span className={cn('shrink-0 text-faint', textSize)}>每隔</span>
            <input
              type="number"
              min={1}
              value={every}
              onChange={(event) =>
                onPatchParams({ every: Math.max(1, Math.round(Number(event.target.value) || 1)) })
              }
              className={cn(inputCls, 'w-16 flex-1 font-mono')}
            />
            <select
              value={unit}
              onChange={(event) => onPatchParams({ unit: event.target.value })}
              className={cn(inputCls, 'w-18 shrink-0')}
            >
              <option value="seconds">秒</option>
              <option value="minutes">分钟</option>
              <option value="hours">小时</option>
            </select>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {INTERVAL_PRESETS.map((preset) => {
              const active = every === preset.every && unit === preset.unit;
              return (
                <button
                  key={preset.label}
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPatchParams({ every: preset.every, unit: preset.unit });
                  }}
                  className={cn(
                    'nodrag nopan rounded-sm border py-0.5 text-center font-mono transition-colors',
                    compact ? 'text-[9px]' : 'text-[10px]',
                    active
                      ? 'border-brand/50 bg-brand/15 text-brand'
                      : 'border-line bg-canvas text-faint hover:border-line-strong hover:text-dim',
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
