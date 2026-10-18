import { Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';

import {
  condGroupsFromParams,
  condMatchTimeoutMs,
  condModeFromParams,
  condParamsFromGroups,
  DEFAULT_COND_MATCH_MS,
  type CondGroup,
  type CondMode,
} from '@/features/graph/flow/flow-cond-params';
import { RecognizerPicker } from '@/features/recognizers/RecognizerPicker';
import { StepSearchScope } from '@/features/graph/flow/StepSearchScope';
import { cn } from '@/lib/utils';

/**
 * 将底层 `params` + `groups` 归一化为三种直观模式：
 *  - `single`：单个画面条件（只有 1 张图）
 *  - `all`：同时满足（「且」，所有图都出现在画面才算成立）
 *  - `any`：满足任一（「或」，任意一张图出现在画面就算成立）
 */
function parseModeAndItems(
  params: Record<string, unknown>,
  groups: readonly CondGroup[],
): { mode: CondMode; items: string[] } {
  const mode = condModeFromParams(params, groups);
  const flatItems = groups.flatMap((group) => (group.all.length > 0 ? group.all : ['']));
  if (mode === 'any' || mode === 'all') {
    return {
      mode,
      items: flatItems.length >= 2 ? flatItems : [flatItems[0] ?? '', ''],
    };
  }
  return { mode: 'single', items: [flatItems[0] ?? ''] };
}

function groupsFromModeAndItems(mode: CondMode, items: readonly string[]): CondGroup[] {
  if (mode === 'single') {
    return [{ all: [items[0] ?? ''] }];
  }
  if (mode === 'all') {
    const list = items.length >= 2 ? [...items] : [items[0] ?? '', ''];
    return [{ all: list }];
  }
  const list = items.length >= 2 ? [...items] : [items[0] ?? '', ''];
  return list.map((label) => ({ all: [label] }));
}

export function CondStepFields({
  params,
  recognizerLabels,
  flowStepId,
  onPatch,
  compact = false,
  previewSide = false,
  className,
}: {
  params: Record<string, unknown>;
  recognizerLabels: readonly string[];
  flowStepId?: string;
  onPatch: (nextParams: Record<string, unknown>) => void;
  compact?: boolean;
  /** 详情栏：图像预览放右侧 */
  previewSide?: boolean;
  className?: string;
}): ReactNode {
  const groups = useMemo(() => condGroupsFromParams(params), [params]);
  const { mode, items } = useMemo(() => parseModeAndItems(params, groups), [params, groups]);

  const commit = (nextMode: CondMode, nextItems: readonly string[]): void => {
    const nextGroups = groupsFromModeAndItems(nextMode, nextItems);
    onPatch({ ...params, ...condParamsFromGroups(nextGroups, nextMode) });
  };

  const handleModeChange = (nextMode: CondMode): void => {
    if (nextMode === mode) {
      return;
    }
    if (nextMode === 'single') {
      const firstNonEmpty = items.find((item) => item.trim().length > 0) ?? items[0] ?? '';
      commit('single', [firstNonEmpty]);
      return;
    }
    const nextItems = items.length >= 2 ? items : [items[0] ?? '', ''];
    commit(nextMode, nextItems);
  };

  const setItem = (index: number, label: string): void => {
    const next = [...items];
    next[index] = label;
    commit(mode, next);
  };

  const addItem = (): void => {
    if (mode === 'single') {
      commit('all', [items[0] ?? '', '']);
      return;
    }
    commit(mode, [...items, '']);
  };

  const removeItem = (index: number): void => {
    const next = items.filter((_, i) => i !== index);
    if (next.length <= 1) {
      commit('single', [next[0] ?? '']);
      return;
    }
    commit(mode, next);
  };

  const textSize = compact ? 'text-[10px]' : 'text-badge';
  const joinWord = compact
    ? mode === 'all'
      ? '且'
      : '或'
    : mode === 'all'
      ? '且（同时出现）'
      : '或（任一出现）';
  const timeoutValue = String(condMatchTimeoutMs(params));

  const modeTabs = compact
    ? ([
        { id: 'single', label: '单图' },
        { id: 'all', label: '且' },
        { id: 'any', label: '或' },
      ] as const)
    : ([
        { id: 'single', label: '单图' },
        { id: 'all', label: '且 (同时)' },
        { id: 'any', label: '或 (任一)' },
      ] as const);

  return (
    <div
      className={cn('nodrag nopan', compact ? 'space-y-1' : 'space-y-1.5', className)}
      onClick={(event) => event.stopPropagation()}
      data-testid="cond-step-fields"
    >
      <label
        className="flex items-center gap-1 text-dim"
        title="未命中时最多等这么久再走「不成立」；默认 100ms，0 为立即判断"
      >
        <span className={cn('shrink-0', textSize)}>匹配时间</span>
        <input
          type="number"
          min={0}
          max={600000}
          step={50}
          value={timeoutValue}
          data-testid="cond-match-timeout"
          onChange={(event) => {
            const raw = event.target.value.trim();
            if (!raw) {
              onPatch({ timeout_ms: DEFAULT_COND_MATCH_MS });
              return;
            }
            const parsed = Number(raw);
            if (Number.isFinite(parsed)) {
              onPatch({ timeout_ms: Math.max(0, Math.round(parsed)) });
            }
          }}
          className={cn(
            'min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1 font-mono text-fg focus:border-brand focus:outline-none',
            compact ? 'h-5 text-[10px]' : 'h-6 px-1.5 text-badge',
          )}
          aria-label="匹配时间（毫秒）"
        />
        <span className="shrink-0 text-[10px] text-faint">ms</span>
      </label>
      {!compact ? (
        <p className="text-[10px] leading-snug text-faint">
          未命中时最多等这么久再走「不成立」；默认 100ms，0 为立即判断
        </p>
      ) : null}

      {/* 顶部模式切换：单条件 / 全部满足(且) / 满足任一(或) */}
      <div className="flex items-center justify-between gap-1">
        <span className={cn('shrink-0 text-dim', textSize)}>判断</span>
        <div className="grid flex-1 grid-cols-3 gap-0.5 rounded-sm border border-line bg-canvas p-0.5">
          {modeTabs.map((tab) => {
            const active = mode === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  handleModeChange(tab.id);
                }}
                className={cn(
                  'nodrag nopan rounded-sm py-0.5 text-center transition-colors',
                  compact ? 'text-[10px]' : 'text-badge',
                  active
                    ? 'bg-brand/20 font-medium text-brand ring-1 ring-inset ring-brand/50'
                    : 'text-dim hover:bg-raised hover:text-fg',
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {!compact ? (
        <p className="text-[10px] leading-snug text-faint">
          {mode === 'single'
            ? '画面中出现下方图像 → 走「成立」，否则走「不成立」'
            : mode === 'all'
              ? `以下 ${items.length} 张图全部同时出现 → 走「成立」，缺任意一张走「不成立」`
              : `以下 ${items.length} 张图出现任意一张 → 走「成立」，全部未出现走「不成立」`}
        </p>
      ) : null}

      {/* 条件列表 */}
      <div className={compact ? 'space-y-1' : 'space-y-1.5'}>
        {items.map((label, index) => {
          const slot =
            mode === 'any' ? { groupIndex: index, rowIndex: 0 } : { groupIndex: 0, rowIndex: index };
          return (
            <div key={`cond-item-${index}`} className="space-y-1">
              {index > 0 ? (
                <div className="flex items-center gap-1.5 py-0.5">
                  <span className="h-px flex-1 bg-line" />
                  <span
                    className={cn(
                      'rounded-sm px-1.5 py-0.5 font-medium',
                      compact ? 'text-[9px]' : 'text-[10px]',
                      mode === 'all' ? 'bg-ok/15 text-ok' : 'bg-brand/15 text-brand',
                    )}
                  >
                    {joinWord}
                  </span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              ) : null}

              <div className={cn('rounded-sm border border-line/80 bg-canvas/40', compact ? 'p-1' : 'p-1.5')}>
                {items.length > 1 ? (
                  <div className={cn('flex items-center justify-between', compact ? 'mb-0.5' : 'mb-1')}>
                    <span className="text-[10px] text-dim">#{index + 1}</span>
                    <button
                      type="button"
                      title="删除此条件"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        removeItem(index);
                      }}
                      className="nodrag nopan inline-flex items-center rounded-sm p-0.5 text-faint hover:bg-raised hover:text-failed"
                      aria-label={`删除条件 ${index + 1}`}
                    >
                      <Trash2 className="size-3" strokeWidth={2} />
                    </button>
                  </div>
                ) : null}

                <RecognizerPicker
                  value={label}
                  labels={recognizerLabels}
                  flowStepId={flowStepId}
                  flowRecSlot={slot}
                  compact={compact}
                  previewMaxHeight={compact ? 52 : undefined}
                  previewSide={previewSide}
                  onChange={(next) => setItem(index, next)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {items.every((item) => item.trim().length === 0) ? (
        <p className={cn('text-failed', compact ? 'text-[10px]' : 'text-badge')}>
          还没选识别器，运行会被拦下
        </p>
      ) : null}

      <button
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          addItem();
        }}
        className={cn(
          'nodrag nopan flex w-full items-center justify-center gap-1 rounded-sm border border-dashed border-line text-dim hover:border-brand/50 hover:text-brand',
          compact ? 'py-0.5' : 'py-1',
          textSize,
        )}
      >
        <Plus className="size-3" strokeWidth={2} />
        {compact
          ? '加图'
          : mode === 'single'
            ? '添加一张图像条件'
            : `添加一张「${mode === 'all' ? '且' : '或'}」图像条件`}
      </button>

      {!compact ? (
        <StepSearchScope
          value={params.search}
          onChange={(search) => onPatch({ ...params, search: search === 'auto' ? undefined : search })}
        />
      ) : null}
    </div>
  );
}
