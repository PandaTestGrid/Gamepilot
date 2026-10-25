/**
 * 同一识别器在一帧里命中多个目标时，点哪一个。
 *
 * 和引擎 `core/selection.py` 保持同口径：`auto` 只在「同分歧义」时拒绝，
 * 其它策略按阅读顺序 / 屏幕坐标 / 录制位置挑一个；`all` 依次点完全部候选。
 */
import { coerceStr } from '@/lib/coerce';

export type SelectionStrategy =
  | 'auto'
  | 'nearest'
  | 'first'
  | 'last'
  | 'nth'
  | 'leftmost'
  | 'rightmost'
  | 'topmost'
  | 'bottommost'
  | 'random'
  | 'all';

export const SELECTION_OPTIONS: ReadonlyArray<{
  readonly id: SelectionStrategy;
  readonly label: string;
  readonly hint: string;
}> = [
  { id: 'auto', label: '自动', hint: '只有一个就点；多个同分时报错，不猜' },
  { id: 'nearest', label: '最近', hint: '离录制时框选位置最近的那个' },
  { id: 'first', label: '第一个', hint: '按从上到下、从左到右的第一个' },
  { id: 'last', label: '最后一个', hint: '按从上到下、从左到右的最后一个' },
  { id: 'nth', label: '第 N 个', hint: '按阅读顺序取第 N 个（从 1 开始）' },
  { id: 'leftmost', label: '最左', hint: '屏幕坐标最靠左的那个' },
  { id: 'rightmost', label: '最右', hint: '屏幕坐标最靠右的那个' },
  { id: 'topmost', label: '最上', hint: '屏幕坐标最靠上的那个' },
  { id: 'bottommost', label: '最下', hint: '屏幕坐标最靠下的那个' },
  { id: 'random', label: '随机', hint: '每次从候选里随机挑一个' },
  { id: 'all', label: '全部', hint: '依次点击这一帧的全部候选；点完会消失/重排的界面请改用循环 + 最近' },
];

const STRATEGIES = new Set(SELECTION_OPTIONS.map((item) => item.id));

export function selectionStrategy(value: unknown): SelectionStrategy {
  const raw = coerceStr(value).trim().toLowerCase();
  return STRATEGIES.has(raw as SelectionStrategy) ? (raw as SelectionStrategy) : 'auto';
}

export function selectionIndex(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

/** 切换策略：`auto` 时把 index 一并删掉，避免旧值残留 */
export function selectionPatch(strategy: SelectionStrategy, index?: unknown): Record<string, unknown> {
  if (strategy === 'auto') {
    return { strategy: undefined, index: undefined };
  }
  if (strategy === 'nth') {
    return { strategy, index: selectionIndex(index) };
  }
  return { strategy, index: undefined };
}

export function selectionSummary(strategy: unknown, index?: unknown): string {
  const mode = selectionStrategy(strategy);
  if (mode === 'auto') {
    return '';
  }
  if (mode === 'nth') {
    return `第 ${selectionIndex(index)} 个`;
  }
  return SELECTION_OPTIONS.find((item) => item.id === mode)?.label ?? mode;
}
