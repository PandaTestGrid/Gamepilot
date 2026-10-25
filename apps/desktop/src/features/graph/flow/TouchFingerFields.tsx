import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { useTouchCapability } from '@/features/graph/flow/use-touch-capability';

export function TouchFingerFields({ params, onPatch, required = false, compact = false, className }: {
  params: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
  required?: boolean;
  compact?: boolean;
  className?: string;
}): ReactNode {
  const capability = useTouchCapability();
  const raw = Number(params.finger);
  const finger = params.finger !== undefined && params.finger !== '' && Number.isInteger(raw) && raw >= 1 && raw <= 10
    ? raw : required ? 1 : '';
  const overLimit = finger !== '' && capability.known && finger > capability.max;
  return (
    <div className={cn('space-y-0.5', className)}>
      <label className={cn('flex items-center gap-1 text-dim', compact ? 'text-[11px]' : 'text-badge')}>
        手指
        <select
          aria-label="触摸手指"
          value={finger}
          onChange={(event) => onPatch({ finger: event.target.value === '' ? undefined : Number(event.target.value) })}
          className="nodrag nopan h-5 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1 text-fg focus:border-brand focus:outline-none"
        >
          {!required && <option value="">自动（所属分支）</option>}
          {Array.from({ length: capability.max }, (_, index) => <option key={index + 1} value={index + 1}>手指 {index + 1}</option>)}
          {overLimit && <option value={finger} disabled>手指 {finger}（超出设备上限）</option>}
        </select>
      </label>
      <p className={cn('text-[10px] leading-snug', capability.unsupported ? 'text-pending' : 'text-dim')}>{capability.hint}</p>
      {overLimit && <p role="alert" className="text-[10px] leading-snug text-pending">手指 {finger} 超出当前设备上限 {capability.max}，已有配置未修改。</p>}
      {!compact && <p className="text-[10px] leading-snug text-dim">
        {required ? '同一手指按下、移动、抬起需使用同一编号。' : '未指定时自动使用所属分支的手指；可显式指定 1–10。'}
      </p>}
    </div>
  );
}
