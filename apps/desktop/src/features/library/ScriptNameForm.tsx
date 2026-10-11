/**
 * 内联命名表单：「新建脚本」与「重命名」共用。
 *
 * 为什么不用 window.prompt：Tauri 的 WebView 里它是被禁的（点了没反应最难查），
 * 而且统一在这里做校验，错误信息能贴在输入框下面。
 */
import { type ReactNode, useState } from 'react';

import { scriptNameError } from '@/features/library/script-name';
import { cn } from '@/lib/utils';

export function ScriptNameForm({
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
  const problem = scriptNameError(name);

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
          placeholder="例如 日常任务"
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
