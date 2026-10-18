import { type ReactNode } from 'react';

import { loopCountOf } from '@/features/graph/flow/flow-step-meta';

export function LoopStepFields({
  params,
  onPatch,
}: {
  params: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
}): ReactNode {
  const count = loopCountOf(params);
  return (
    <div className="space-y-1">
      <label className="block space-y-0.5 text-badge text-dim">
        <span>循环次数</span>
        <input
          type="number"
          min={1}
          step={1}
          className="h-6 w-full rounded-sm border border-line bg-canvas px-1.5 text-badge text-fg focus:border-brand focus:outline-none"
          value={count}
          onChange={(event) => {
            const raw = event.target.value.trim();
            const n = raw === '' ? 1 : Math.max(1, Math.floor(Number(raw) || 1));
            onPatch({ count: n });
          }}
        />
      </label>
      <p className="text-[10px] leading-snug text-faint">进入 → 要重复的步骤；下一步 → 重复完之后</p>
    </div>
  );
}
