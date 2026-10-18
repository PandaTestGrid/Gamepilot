/**
 * IDE 式面板标签（Cursor / VS Code）：整条等高、竖线分隔，选中项与下方内容区同色并「盖住」头部分割线。
 */
import { X } from 'lucide-react';
import { type ReactNode } from 'react';

import { RunBusySpinner, RunLiveDot } from '@/features/graph/flow/RunBusySpinner';
import { cn } from '@/lib/utils';

export function PanelTabList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div
      role="tablist"
      className={cn(
        'flex h-7 min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PanelTab({
  active,
  label,
  fullTitle,
  onSelect,
  onClose,
  onCancelClose,
  closeTitle,
  busy = false,
  live = false,
  liveHint,
  confirming = false,
}: {
  active: boolean;
  label: string;
  fullTitle?: string;
  onSelect: () => void;
  onClose: () => void;
  onCancelClose?: () => void;
  closeTitle: string;
  /** 切工作流时当前标签转圈，和 Cursor 标签 loading 一样 */
  busy?: boolean;
  /** 这份工作流还在设备上跑（切走之后也要看得见） */
  live?: boolean;
  /** 运行提示（例如「运行中 · MuMu」）；缺省就是「运行中」 */
  liveHint?: string;
  /** 运行中关标签：先确认，再关 */
  confirming?: boolean;
}): ReactNode {
  const hint = [fullTitle ?? label, live ? (liveHint ?? '运行中') : null].filter(Boolean).join('\n');
  return (
    <div
      role="tab"
      aria-selected={active}
      aria-busy={busy || live || undefined}
      title={hint}
      className={cn(
        'group relative flex min-w-[4.5rem] shrink-0 items-stretch border-r border-line/70',
        confirming ? 'max-w-[16rem]' : 'max-w-[10rem]',
        active ? 'bg-canvas text-fg' : 'bg-panel text-dim hover:bg-raised/40 hover:text-fg',
      )}
    >
      {active ? (
        <span className="pointer-events-none absolute inset-x-0 -bottom-px z-10 h-px bg-canvas" aria-hidden />
      ) : null}
      <button
        type="button"
        role="presentation"
        tabIndex={-1}
        className="flex min-w-0 flex-1 items-center gap-1 px-2.5 py-0 text-left text-badge leading-7"
        onClick={onSelect}
      >
        {busy ? <RunBusySpinner className="text-faint" /> : live ? <RunLiveDot /> : null}
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {confirming ? (
        <div className="flex shrink-0 items-stretch text-badge">
          <button
            type="button"
            data-testid="workflow-tab-confirm-close"
            title="关闭标签（运行仍会继续）"
            aria-label="确认关闭运行中的标签"
            className="px-1.5 text-brand hover:bg-raised/80"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            关闭
          </button>
          <button
            type="button"
            data-testid="workflow-tab-cancel-close"
            title="取消"
            aria-label="取消关闭标签"
            className="px-1.5 text-dim hover:bg-raised/80 hover:text-fg"
            onClick={(event) => {
              event.stopPropagation();
              onCancelClose?.();
            }}
          >
            取消
          </button>
        </div>
      ) : (
        <button
          type="button"
          title={closeTitle}
          aria-label={closeTitle}
          className={cn(
            'flex w-6 shrink-0 items-center justify-center text-faint hover:bg-raised/80 hover:text-fg',
            active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <X className="size-3" strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
