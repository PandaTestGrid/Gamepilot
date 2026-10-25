import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { useTouchCapability } from '@/features/graph/flow/use-touch-capability';

export function ParallelStepFields({ params, onPatch, compact = false, className }: {
  params: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
  compact?: boolean;
  className?: string;
}): ReactNode {
  const capability = useTouchCapability();
  const inputClass = 'nodrag nopan h-5 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1 text-fg focus:border-brand focus:outline-none';
  const raw = Number(params.branches ?? 2);
  const branches = Number.isFinite(raw) ? Math.min(4, Math.max(2, Math.floor(raw))) : 2;
  return (
    <div className={cn('nodrag nopan space-y-1 text-dim', compact ? 'text-[11px]' : 'text-badge', className)} onClick={(event) => event.stopPropagation()}>
      <label className="flex items-center gap-1">
        完成条件
        <select aria-label="并行完成条件" className={inputClass} value={params.mode === 'any' ? 'any' : 'all'} onChange={(event) => onPatch({ mode: event.target.value })}>
          <option value="all">全部分支完成</option>
          <option value="any">任一分支完成</option>
        </select>
      </label>
      <label className="flex items-center gap-1">
        分支数量
        <select aria-label="并行分支数量" className={inputClass} value={branches} onChange={(event) => onPatch({ branches: Number(event.target.value) })}>
          {[2, 3, 4].map((count) => <option key={count} value={count}>{count} 个分支</option>)}
        </select>
      </label>
      <p className={cn('text-[10px] leading-snug', capability.unsupported ? 'text-pending' : 'text-dim')}>{capability.hint}；并行触摸受此设备能力限制。</p>
      {!compact && <div className="space-y-0.5 text-[10px] leading-snug text-dim">
        <p>{params.mode === 'any' ? '任一分支完成后取消其余分支，再继续下一步。' : '等待全部分支完成，再继续下一步。'}</p>
        <p>手指默认按分支自动分配；变量共享，后写入的值覆盖先写入的值。</p>
      </div>}
    </div>
  );
}
