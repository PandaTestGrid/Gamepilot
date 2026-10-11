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
    // h-full 是关键：没有确定高度时，flex-1 的内容区在自动高度容器里会塌成 0
    // （内容区全是绝对定位元素，撑不起高度）——画面栏"只剩一条边框线"就是这么来的
    <section className={cn('flex h-full min-h-0 flex-col bg-panel', className)}>
      {/*
        头部必须能换行：面板拖窄时按钮不换行就会被挤成一列竖排文字
        （截图里「框选/点选/多开」被压成"框 选"两行就是这个原因）。
        min-h-7 保证窄的时候长高，宽的时候还是 28px。
      */}
      <div className="flex min-h-7 shrink-0 flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-line px-2 py-0.5">
        <span className="shrink-0 text-panelhead font-medium">{title}</span>
        <div className="min-w-2 flex-1" />
        {actions}
      </div>
      {/*
        内容区必须同时有 flex-1 + min-h-0：画面栏里全是绝对定位元素（img absolute inset-0），
        它的"内容最小高度"是 0，只给 flex-1 会被 flex 压缩到 0 高度——用户看到的就是一条边框线。
        再套一层 h-full，保证子元素的 h-full 有确定的参照高度。
      */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="h-full min-h-0">{children}</div>
      </div>
      {footer}
    </section>
  );
}

export function GhostButton({
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
        'flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-badge whitespace-nowrap text-dim hover:bg-raised hover:text-fg',
        active && 'bg-active text-fg',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-dim',
      )}
    >
      {children}
    </button>
  );
}

/**
 * 运行/停止按钮：顶栏与状态图头部共用同一个组件 + 同一份 `useRunControl`。
 *
 * 为什么允许出现在两处：运行是**设备会话**的开关（不是状态图的一部分，见 lib/useRunControl.ts），
 * 顶栏那处在任何布局下都在、还能解释"为什么不能跑"；图栏头那处是"就近"——
 * 图栏被双击弹成独立窗口时（?pane=graph）也能直接跑。
 * 两处只共用一个开关，不存在第二份状态。
 */
export function RunButton({ size = 'normal' }: { size?: 'normal' | 'compact' }): ReactNode {
  const run = useRunControl();
  const label = run.running ? '停止' : '运行';
  const title = run.blocker
    ? run.blocker
    : run.running
      ? `停止运行（${run.deviceName ?? '当前设备'}）`
      : `让 ${run.deviceName ?? '当前设备'} 按状态图跑（不运行时也在识别，只是不发动作）`;

  return (
    <GhostButton active={run.running} disabled={Boolean(run.blocker)} onClick={run.toggle} title={title}>
      {run.running ? (
        <Square className={size === 'compact' ? 'size-3' : 'size-3.5'} />
      ) : (
        <CirclePlay className={size === 'compact' ? 'size-3' : 'size-3.5'} />
      )}
      {label}
    </GhostButton>
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
