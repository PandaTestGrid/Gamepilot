import { type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** 面板壳：28px 面板头 + 内容区。扁平化——1px 描边分层，不用卡片、不用阴影。 */
export function PanelShell({
  title,
  actions,
  children,
  footer,
  className,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section className={cn('flex min-h-0 flex-col bg-panel', className)}>
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="text-panel font-medium">{title}</span>
        <div className="flex-1" />
        {actions}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      {footer}
    </section>
  );
}

export function GhostButton({
  children,
  onClick,
  active,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  title?: string;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-5 items-center gap-1 rounded-sm px-1.5 text-badge text-dim hover:bg-raised hover:text-fg',
        active && 'bg-active text-fg',
      )}
    >
      {children}
    </button>
  );
}

export type DotTone = 'confirmed' | 'pending' | 'failed' | 'idle';

const TONE_CLASS: Record<DotTone, string> = {
  confirmed: 'bg-confirmed',
  pending: 'bg-pending',
  failed: 'bg-failed',
  idle: 'bg-idle',
};

/** 状态一律用 6px 色点表达，禁止彩色背景块（DESIGN.md §4.0）。 */
export function StatusDot({ tone, className }: { tone: DotTone; className?: string }): ReactNode {
  return <span className={cn('size-1.5 shrink-0 rounded-full', TONE_CLASS[tone], className)} />;
}

export function ToolbarButton({
  children,
  onClick,
  active,
  title,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  title?: string;
  disabled?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        'flex h-6 items-center gap-1.5 rounded-sm px-2 hover:bg-raised',
        active && 'bg-raised text-brand',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
      )}
    >
      {children}
    </button>
  );
}

export function VDivider(): ReactNode {
  return <span className="mx-1 h-4 w-px shrink-0 bg-line" />;
}
