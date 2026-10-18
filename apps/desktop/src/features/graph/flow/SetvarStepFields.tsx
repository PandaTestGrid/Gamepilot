/**
 * 赋值模块（`setvar`）：给变量写一个值，引擎侧 `_perform_setvar` 执行。
 *
 * 值可以是字面量（`0` / `阿黄`）、`$变量名`，或 `$表达式`（如 `$次数 + 1`，可用于累加）。
 * 之前只有底部详情栏有这两格参数，画布节点上什么都没有 —— 拖进画布后看不出要配什么，
 * 所以抽成共用组件：节点上 compact、详情栏用完整版。
 */
import { type ReactNode } from 'react';

import { coerceStr } from '@/lib/coerce';
import { cn } from '@/lib/utils';

export function SetvarStepFields({
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
  const inputClass = cn(
    'nodrag nopan min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1 text-fg placeholder:text-faint/70 focus:border-brand focus:outline-none',
    compact ? 'h-5 text-[11px]' : 'h-6 text-badge',
  );
  const labelClass = cn('shrink-0 text-faint', compact ? 'w-9 text-[10px]' : 'w-10 text-badge');

  return (
    <div
      className={cn('nodrag nopan space-y-1', className)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      data-testid="setvar-step-fields"
    >
      <label className="flex items-center gap-1">
        <span className={labelClass}>变量名</span>
        <input
          className={inputClass}
          data-testid="setvar-name"
          placeholder="如 次数"
          value={coerceStr(params.name)}
          onChange={(event) => onPatch({ name: event.target.value })}
        />
      </label>
      <label className="flex items-center gap-1">
        <span className={labelClass}>值</span>
        <input
          className={inputClass}
          data-testid="setvar-value"
          placeholder="0 或 $次数 + 1"
          value={coerceStr(params.value)}
          onChange={(event) => onPatch({ value: event.target.value })}
        />
      </label>
      {compact ? null : (
        <p className="text-[10px] leading-snug text-faint">
          值可写字面量、<code>$变量名</code> 或 <code>$表达式</code>（如 <code>$次数 + 1</code>）
        </p>
      )}
    </div>
  );
}
