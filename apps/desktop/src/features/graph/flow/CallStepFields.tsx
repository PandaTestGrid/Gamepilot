/**
 * 调用工作流模块：在画布节点上直接选择同工作区的目标工作流（与详情栏共用）。
 */
import { type ReactNode, useMemo } from 'react';

import { formatTriggerSummary } from '@/features/graph/flow/flow-trigger-params';
import { coerceStr } from '@/lib/coerce';
import { cn } from '@/lib/utils';
import type { WorkflowTrigger } from '@/lib/rpc';

export function CallStepFields({
  params,
  workflows,
  currentName,
  onPatch,
  compact = false,
  className,
}: {
  params: Record<string, unknown>;
  workflows: readonly { readonly name: string; readonly trigger?: WorkflowTrigger | null }[];
  /** 当前正在编辑的工作流名：调用自己没有意义，列表里去掉，但已选中的仍显示。 */
  currentName?: string;
  onPatch: (patch: Record<string, unknown>) => void;
  compact?: boolean;
  className?: string;
}): ReactNode {
  const selected = coerceStr(params.name);
  const options = useMemo(() => {
    const names = workflows.map((item) => item.name).filter(Boolean);
    const unique = [...new Set(names)];
    return unique.filter((name) => name !== currentName || name === selected);
  }, [workflows, currentName, selected]);
  const known = options.includes(selected);
  const empty = options.length === 0 && !selected;
  const selectedWorkflow = workflows.find((item) => item.name === selected);
  const triggerSummary = selectedWorkflow?.trigger
    ? formatTriggerSummary(selectedWorkflow.trigger.type, selectedWorkflow.trigger.params)
    : '';

  return (
    <label
      className={cn('nodrag nopan block space-y-0.5 text-badge', className)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      data-testid="call-step-fields"
    >
      {compact ? null : <span className="text-faint">目标工作流</span>}
      <select
        aria-label="目标工作流"
        data-testid="call-workflow-select"
        value={selected}
        onChange={(event) => onPatch({ name: event.target.value })}
        className={cn(
          'nodrag nopan w-full rounded-sm border border-line bg-canvas px-1.5 text-fg focus:border-brand focus:outline-none',
          compact ? 'h-6 text-[11px]' : 'h-6 text-badge',
        )}
      >
        <option value="">{empty ? '（当前工作区没有可调用的工作流）' : '（选择工作流）'}</option>
        {selected && !known ? <option value={selected}>{selected}（不在列表中）</option> : null}
        {options.map((name) => (
          <option key={name} value={name}>
            {name === currentName ? `${name}（当前）` : name}
          </option>
        ))}
      </select>
      {triggerSummary ? (
        <span
          className="block truncate text-[10px] leading-tight text-faint"
          data-testid="call-target-trigger"
          title={`目标工作流触发条件：${triggerSummary}`}
        >
          触发：{triggerSummary}
        </span>
      ) : null}
    </label>
  );
}
