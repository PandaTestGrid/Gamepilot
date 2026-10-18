/**
 * 延时模块：节点内可直接点选常用延时预设，或手动输入毫秒值（画布节点与详情栏共用）。
 */
import { type ReactNode, useState } from 'react';

import {
  DELAY_PRESETS,
  delayMsOf,
  MAX_DELAY_MS,
  normalizeDelayMs,
} from '@/features/graph/flow/flow-delay-params';
import { cn } from '@/lib/utils';

export function DelayStepFields({
  params,
  onPatch,
  compact = false,
  className,
}: {
  params: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
  compact?: boolean;
  className?: string;
}): ReactNode {
  const savedMs = delayMsOf(params);
  const [edit, setEdit] = useState<{ base: number; text: string } | null>(null);
  const draft = edit && edit.base === savedMs ? edit.text : String(savedMs);
  const setDraft = (text: string): void => setEdit({ base: savedMs, text });

  const inputClass = cn(
    'nodrag nopan rounded-sm border border-line bg-canvas px-1 text-fg focus:border-brand focus:outline-none',
    compact ? 'h-5 w-16 text-[11px]' : 'h-5 w-24 text-badge',
  );

  const commitMs = (raw: unknown): void => {
    const next = normalizeDelayMs(raw);
    setEdit(null);
    if (next !== savedMs || params.ms !== next) {
      onPatch({ ms: next });
    }
  };

  return (
    <div
      className={cn('nodrag nopan space-y-1 text-badge', className)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      data-testid="delay-step-fields"
    >
      <div
        className={cn('flex flex-wrap gap-0.5', compact && 'text-[10px]')}
        role="group"
        aria-label="常用延时"
      >
        {DELAY_PRESETS.map((preset) => (
          <button
            key={preset.ms}
            type="button"
            data-testid={`delay-preset-${preset.ms}`}
            onClick={() => {
              setEdit(null);
              onPatch({ ms: preset.ms });
            }}
            className={cn(
              'nodrag nopan rounded-sm border px-1 py-0.5 transition-colors hover:border-brand/50 hover:bg-raised',
              savedMs === preset.ms ? 'border-brand bg-active text-brand' : 'border-line bg-canvas text-dim',
            )}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <label className={cn('flex items-center gap-1 text-dim', compact && 'text-[11px]')}>
        延时
        <input
          type="number"
          min={0}
          max={MAX_DELAY_MS}
          step={100}
          inputMode="numeric"
          data-testid="delay-ms-input"
          className={inputClass}
          value={draft}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            const parsed = Number(text.trim());
            if (text.trim() !== '' && Number.isFinite(parsed) && parsed >= 0) {
              onPatch({ ms: Math.min(MAX_DELAY_MS, Math.round(parsed)) });
            }
          }}
          onBlur={() => commitMs(draft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
        />
        <span className="text-faint">ms</span>
      </label>
    </div>
  );
}
