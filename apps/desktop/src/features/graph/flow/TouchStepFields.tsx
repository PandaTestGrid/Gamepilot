import type { ReactNode } from 'react';

import { TouchFingerFields } from '@/features/graph/flow/TouchFingerFields';
import { clampUnitCoord } from '@/features/graph/flow/flow-coord-utils';
import { cn } from '@/lib/utils';

export function TouchStepFields({ params, onPatch, compact = false, className }: {
  params: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
  compact?: boolean;
  className?: string;
}): ReactNode {
  const phase = params.phase === 'move' || params.phase === 'up' ? params.phase : 'down';
  const inputClass = 'nodrag nopan h-5 min-w-0 rounded-sm border border-line bg-canvas px-1 text-fg focus:border-brand focus:outline-none';
  const duration = Number(params.duration_ms);
  return (
    <div className={cn('nodrag nopan space-y-1 text-dim', compact ? 'text-[11px]' : 'text-badge', className)} onClick={(event) => event.stopPropagation()}>
      <label className="flex items-center gap-1">
        阶段
        <select aria-label="触摸阶段" className={cn(inputClass, 'flex-1')} value={phase} onChange={(event) => onPatch({ phase: event.target.value })}>
          <option value="down">按下</option><option value="move">移动</option><option value="up">抬起</option>
        </select>
      </label>
      <TouchFingerFields params={params} onPatch={onPatch} required compact={compact} />
      <div className="flex flex-wrap items-center gap-1">
        <span>归一化</span>
        {(['x', 'y'] as const).map((axis) => <label key={axis} className="flex min-w-0 items-center gap-0.5">
          {axis.toUpperCase()}
          <input aria-label={`触摸 ${axis.toUpperCase()}`} type="number" min={0} max={1} step={0.01}
            className={cn(inputClass, compact ? 'w-12' : 'w-16')}
            value={clampUnitCoord(Number(params[axis] ?? 0.5))}
            onChange={(event) => onPatch({ [axis]: clampUnitCoord(Number(event.target.value)) })} />
        </label>)}
      </div>
      {phase === 'move' && <label className="flex items-center gap-1">
        移动时长
        <input aria-label="触摸移动时长" type="number" min={0} step={50} placeholder="立即"
          value={params.duration_ms === undefined || params.duration_ms === '' || !Number.isFinite(duration) ? '' : duration}
          className={cn(inputClass, 'w-16')}
          onChange={(event) => onPatch({ duration_ms: event.target.value === '' ? undefined : Math.max(0, Math.round(Number(event.target.value) || 0)) })} />
        <span>ms</span>
      </label>}
      {!compact && <p className="text-[10px] leading-snug text-dim">移动前需在同一分支先按下同一手指。按下后在本分支接延迟或循环保持，直到抬起；分支完成或取消时自动释放。</p>}
    </div>
  );
}
