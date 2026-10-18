/**
 * 步骤级搜索范围：搜索范围是「这一步怎么执行」的能力，不是模板的固有属性。
 *
 * - `auto`：跟随模板默认（录制时 / 识别器面板里设的值）
 * - `region`：这一步只在模板的 roi（录制框选区域）里找
 * - `full`：这一步整帧找 —— 目标可能出现在屏幕任意位置（较慢）
 *
 * 引擎里由 `FlowEngine._step_search_overrides()` 读取，覆盖模板默认值。
 */
import { type ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type StepSearchScopeValue = 'auto' | 'region' | 'full';

const OPTIONS: ReadonlyArray<{ id: StepSearchScopeValue; label: string; title: string }> = [
  { id: 'auto', label: '跟随模板', title: '使用模板默认的搜索范围' },
  { id: 'region', label: '原区域', title: '这一步只在录制时框选的区域里找' },
  { id: 'full', label: '全屏', title: '这一步整帧找：目标出现在屏幕任意位置都能命中（较慢）' },
];

export function parseStepSearchScope(value: unknown): StepSearchScopeValue {
  return value === 'region' || value === 'full' ? value : 'auto';
}

export function StepSearchScope({
  value,
  onChange,
  compact = false,
}: {
  value: unknown;
  onChange: (next: StepSearchScopeValue) => void;
  compact?: boolean;
}): ReactNode {
  const current = parseStepSearchScope(value);
  return (
    <div
      className={cn('flex items-center gap-1 pt-0.5', compact ? 'text-[10px]' : 'text-badge')}
      data-testid="step-search-scope"
    >
      <span className="shrink-0 text-faint">搜索</span>
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          title={option.title}
          data-testid={`step-search-${option.id}`}
          aria-pressed={current === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            'nodrag nopan rounded-sm px-1.5 py-0.5 transition-colors',
            current === option.id
              ? 'bg-brand/20 font-medium text-brand'
              : 'text-dim hover:bg-raised hover:text-fg',
          )}
        >
          {option.label}
        </button>
      ))}
      <span className="ml-auto truncate text-[10px] text-faint">
        {current === 'full' ? '整帧搜索' : current === 'region' ? '只在框选区' : '模板默认'}
      </span>
    </div>
  );
}
