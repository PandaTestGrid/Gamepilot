/**
 * 输入文字模块：在画布节点上直接改要发送的文本（与详情栏共用）。
 */
import { type ReactNode, useState } from 'react';

import { coerceStr } from '@/lib/coerce';
import { cn } from '@/lib/utils';

export function TextStepFields({
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
  const saved = coerceStr(params.value);
  const [edit, setEdit] = useState<{ base: string; text: string } | null>(null);
  const draft = edit && edit.base === saved ? edit.text : saved;
  const setDraft = (text: string): void => setEdit({ base: saved, text });

  const commit = (): void => {
    setEdit(null);
    if (draft !== saved) {
      onPatch({ value: draft });
    }
  };

  return (
    <label
      className={cn('nodrag nopan block space-y-0.5 text-badge', className)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      data-testid="text-step-fields"
    >
      {compact ? null : <span className="text-faint">输入内容</span>}
      <textarea
        data-testid="text-step-input"
        rows={compact ? 2 : 3}
        placeholder="输入要发送的文字"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        className={cn(
          'nodrag nopan nowheel w-full resize-y rounded-sm border border-line bg-canvas px-1.5 py-1 text-fg placeholder:text-faint focus:border-brand focus:outline-none',
          compact ? 'min-h-[2.5rem] text-[11px] leading-snug' : 'text-badge',
        )}
      />
    </label>
  );
}
