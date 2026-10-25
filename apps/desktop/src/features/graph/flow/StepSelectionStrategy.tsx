/**
 * 步骤级「多目标」选择：同一识别器一帧命中多个时，点哪一个。
 *
 * 只在按识别器定位（图像点击 / 长按 / 等待 / 条件）时出现。默认 `auto`：
 * 只有一个目标就点，多个同分就报错 —— 和老行为一致，不会悄悄猜。
 */
import { type ReactNode } from 'react';

import {
  SELECTION_OPTIONS,
  selectionIndex,
  selectionPatch,
  selectionStrategy,
} from '@/features/graph/flow/flow-selection';
import { cn } from '@/lib/utils';

export function StepSelectionStrategy({
  value,
  index,
  onChange,
  compact = false,
}: {
  value: unknown;
  index?: unknown;
  onChange: (patch: Record<string, unknown>) => void;
  compact?: boolean;
}): ReactNode {
  const current = selectionStrategy(value);
  const hint = SELECTION_OPTIONS.find((item) => item.id === current)?.hint ?? '';
  return (
    <div className={cn('space-y-0.5', compact && 'text-[11px]')} data-testid="step-selection-strategy">
      <div className="flex items-center gap-1">
        <span className="shrink-0 text-faint">多目标</span>
        <select
          data-testid="step-selection-select"
          title={hint}
          className={cn(
            'nodrag nopan min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1 text-fg focus:border-brand focus:outline-none',
            compact ? 'h-5 text-[11px]' : 'h-5 text-badge',
          )}
          value={current}
          onChange={(event) => {
            const next = selectionStrategy(event.target.value);
            onChange(selectionPatch(next, index));
          }}
        >
          {SELECTION_OPTIONS.map((option) => (
            <option key={option.id} value={option.id} title={option.hint}>
              {option.label}
            </option>
          ))}
        </select>
        {current === 'nth' ? (
          <label
            className="flex items-center gap-0.5 text-faint"
            title="按从上到下、从左到右的顺序，从 1 开始"
          >
            <input
              type="number"
              min={1}
              step={1}
              data-testid="step-selection-index"
              className={cn(
                'nodrag nopan rounded-sm border border-line bg-canvas px-1 text-center text-fg focus:border-brand focus:outline-none',
                compact ? 'h-5 w-9 text-[11px]' : 'h-5 w-10 text-badge',
              )}
              value={selectionIndex(index)}
              onChange={(event) =>
                onChange({ strategy: 'nth', index: Math.max(1, Math.floor(Number(event.target.value) || 1)) })
              }
            />
            个
          </label>
        ) : null}
      </div>
      {compact ? null : <div className="pl-8 text-[10px] leading-tight text-faint">{hint}</div>}
    </div>
  );
}
