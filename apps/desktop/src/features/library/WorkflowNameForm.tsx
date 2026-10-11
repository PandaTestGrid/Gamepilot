/**
 * 内联命名表单：新建 / 重命名 / 复制工作流共用（**新建也必须输名字**，v4 不许"点一下直接建"）。
 *
 * 为什么不用 原生 prompt：Tauri 的 WebView 里它是被禁的（点了没反应最难查），
 * 而且统一在这里做校验，错误信息能贴在输入框下面。
 */
import { type ReactNode, useState } from 'react';

import { workflowNameError } from '@/features/library/workflow-name';
import { cn } from '@/lib/utils';

export function WorkflowNameForm({
  title,
  initial = '',
  submitLabel,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [name, setName] = useState(initial);
  const problem = workflowNameError(name);

  const submit = (): void => {
    if (!problem) {
      onSubmit(name.trim());
    }
  };

  return (
    <form
      className="flex flex-col gap-1 border-b border-line bg-raised px-2 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="text-badge text-dim">{title}</div>
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          spellCheck={false}
          placeholder="例如 斗技"
          className={cn(
            'h-6 min-w-0 flex-1 rounded-sm border bg-canvas px-1.5 text-body text-fg',
            problem ? 'border-failed' : 'border-line',
          )}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              onCancel();
            }
          }}
        />
        <button
          type="submit"
          disabled={Boolean(problem)}
          className="h-6 shrink-0 rounded-sm bg-brand px-2 text-badge font-medium text-[#0b0d12] hover:opacity-90 disabled:opacity-50"
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-6 shrink-0 rounded-sm border border-line px-2 text-badge text-dim hover:bg-raised hover:text-fg"
        >
          取消
        </button>
      </div>
      {problem && <div className="text-badge text-failed">{problem}</div>}
    </form>
  );
}
