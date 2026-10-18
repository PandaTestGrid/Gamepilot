import { Loader2 } from 'lucide-react';
import { type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** 「运行中」前面的转圈：切工作流 / 工作区时表示还在交接，不是已经停了。 */
export function RunBusySpinner({ className }: { className?: string }): ReactNode {
  return (
    <Loader2
      data-testid="run-busy-spinner"
      className={cn('size-3 shrink-0 animate-spin', className)}
      strokeWidth={2}
      aria-hidden
    />
  );
}

/** 稳定运行中的标记：实心点，不要转圈（转圈会被当成还在 loading）。 */
export function RunLiveDot({ className }: { className?: string }): ReactNode {
  return (
    <span
      data-testid="run-live-dot"
      className={cn('size-1.5 shrink-0 rounded-full bg-brand', className)}
      aria-hidden
    />
  );
}
