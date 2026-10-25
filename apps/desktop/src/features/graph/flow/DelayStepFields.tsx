/**
 * 延时模块：节点内可直接点选常用延时预设，或手动输入毫秒值（画布节点与详情栏共用）。
 *
 * 打开「随机」后改为范围等待：每次进入这一步在最短/最长之间抽一个毫秒数，
 * 引擎只在进入时抽一次，事件里能看到实际等了多少。
 */
import { type ReactNode, useState } from 'react';

import {
  DELAY_PRESETS,
  defaultRandomRange,
  delayIsRandom,
  delayMsOf,
  MAX_DELAY_MS,
  normalizeDelayMs,
  randomDelayPatch,
  randomDelayRangeOf,
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
  const random = delayIsRandom(params);
  const range = randomDelayRangeOf(params);
  const [edit, setEdit] = useState<{ base: number; text: string } | null>(null);
  // 随机模式下同一次编辑会连续 patch 两个字段；输入框在失焦前保留本地草稿。
  const [rangeEdit, setRangeEdit] = useState<{ key: string; text: string } | null>(null);
  const draft = edit && edit.base === savedMs ? edit.text : String(savedMs);
  const setDraft = (text: string): void => setEdit({ base: savedMs, text });
  const rangeKey = `${range.min}:${range.max}`;
  const rangeText = rangeEdit && rangeEdit.key === rangeKey ? rangeEdit.text : null;

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

  const commitRange = (field: 'minMs' | 'maxMs', raw: unknown): void => {
    const next = normalizeDelayMs(raw);
    setRangeEdit(null);
    const patch = { [field]: next };
    const merged = { ...range, ...(field === 'minMs' ? { min: next } : { max: next }) };
    if (merged.min > merged.max) {
      // 上下限写反了就地换回来，避免配置成永远选不到的范围
      onPatch({ minMs: Math.min(merged.min, merged.max), maxMs: Math.max(merged.min, merged.max) });
      return;
    }
    onPatch(patch);
  };

  const toggleRandom = (): void => {
    setEdit(null);
    setRangeEdit(null);
    onPatch(randomDelayPatch(params, !random));
  };

  return (
    <div
      className={cn('nodrag nopan space-y-1 text-badge', className)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      data-testid="delay-step-fields"
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-dim">{random ? '随机等待' : '固定等待'}</span>
        <button
          type="button"
          role="switch"
          aria-checked={random}
          aria-label="随机等待范围"
          data-testid="delay-random-toggle"
          title={
            random
              ? '关闭随机：恢复固定延时'
              : `打开随机：每次进入在范围内随机（默认 ${defaultRandomRange(params).min}~${defaultRandomRange(params).max}ms）`
          }
          onClick={toggleRandom}
          className={cn(
            'nodrag nopan rounded-sm border px-1.5 py-0.5 text-[10px] transition-colors',
            random
              ? 'border-brand bg-active text-brand'
              : 'border-line bg-canvas text-dim hover:border-brand/50 hover:bg-raised',
          )}
        >
          随机
        </button>
      </div>

      {random ? (
        <div className={cn('flex flex-wrap items-center gap-1 text-dim', compact && 'text-[11px]')}>
          <label className="flex items-center gap-1">
            最短
            <input
              type="number"
              min={0}
              max={MAX_DELAY_MS}
              step={50}
              inputMode="numeric"
              data-testid="delay-min-input"
              className={inputClass}
              value={rangeText ?? String(range.min)}
              onChange={(event) => {
                const text = event.target.value;
                setRangeEdit({ key: rangeKey, text });
                const parsed = Number(text.trim());
                if (text.trim() !== '' && Number.isFinite(parsed) && parsed >= 0) {
                  const next = Math.min(MAX_DELAY_MS, Math.round(parsed));
                  onPatch(next > range.max ? { minMs: next, maxMs: next } : { minMs: next });
                }
              }}
              onBlur={() => commitRange('minMs', rangeText ?? range.min)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
          <span className="text-faint">~</span>
          <label className="flex items-center gap-1">
            最长
            <input
              type="number"
              min={0}
              max={MAX_DELAY_MS}
              step={50}
              inputMode="numeric"
              data-testid="delay-max-input"
              className={inputClass}
              value={rangeText ?? String(range.max)}
              onChange={(event) => {
                const text = event.target.value;
                setRangeEdit({ key: rangeKey, text });
                const parsed = Number(text.trim());
                if (text.trim() !== '' && Number.isFinite(parsed) && parsed >= 0) {
                  const next = Math.min(MAX_DELAY_MS, Math.round(parsed));
                  onPatch(next < range.min ? { minMs: next, maxMs: next } : { maxMs: next });
                }
              }}
              onBlur={() => commitRange('maxMs', rangeText ?? range.max)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur();
                }
              }}
            />
            <span className="text-faint">ms</span>
          </label>
        </div>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
