/**
 * 脚本库里的一行：一张状态图的概览 + 一行操作。
 *
 * 左边点一下 = 切到这张图（引擎会热重载所有已连接设备的状态图，运行中的不丢当前节点）；
 * 右边悬停出现「复制 / 重命名 / 删除」。删除是移到 `.trash/`，所以文案用「移除」而不是「删除」。
 */
import { Check, Copy, Pencil, Trash2 } from 'lucide-react';
import { type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import type { ProjectSummary } from '@/lib/rpc';

export function ScriptRow({
  item,
  current,
  busy,
  onSwitch,
  onDuplicate,
  onRename,
  onRemove,
}: {
  item: ProjectSummary;
  current: boolean;
  busy: boolean;
  onSwitch: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onRemove: () => void;
}): ReactNode {
  return (
    <div
      className={cn(
        'group flex h-9 items-center gap-1.5 px-2',
        current ? 'bg-active' : 'hover:bg-raised',
        busy && 'opacity-50',
      )}
    >
      <button
        type="button"
        onClick={onSwitch}
        disabled={busy || current}
        title={current ? '当前脚本（正在编辑/运行的就是它）' : `切到 ${item.name}（会热重载设备状态图）`}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
      >
        <span className={cn('size-1.5 shrink-0 rounded-full', current ? 'bg-brand' : 'bg-idle')} />
        <span className="min-w-0 flex-1 truncate text-body">{item.name}</span>
        <span className="shrink-0 text-badge text-faint">
          {item.nodes} 界面 · {item.edges} 步 · {item.recognizers} 识别器
        </span>
        {current && <Check className="size-3 shrink-0 text-brand" />}
      </button>

      <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <RowAction title="复制这张图（含模板）为新脚本" onClick={onDuplicate} disabled={busy}>
          <Copy className="size-3" />
        </RowAction>
        <RowAction title="重命名" onClick={onRename} disabled={busy}>
          <Pencil className="size-3" />
        </RowAction>
        <RowAction title="移除到库根 .trash/（可恢复，不是真删除）" onClick={onRemove} disabled={busy} danger>
          <Trash2 className="size-3" />
        </RowAction>
      </span>
    </div>
  );
}

function RowAction({
  title,
  onClick,
  disabled,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex size-5 items-center justify-center rounded-sm text-dim hover:bg-raised focus-visible:opacity-100',
        danger ? 'hover:text-failed' : 'hover:text-fg',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {children}
    </button>
  );
}
