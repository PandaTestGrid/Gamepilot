/**
 * 右栏：Tab 容器（脚本库 / 识别器）。
 *
 * 为什么 Tab 化而不是继续上下分三段：右栏在 800px 高的窗口里只有 ~700px，
 * 三段每段两百多 px，列表全变成"看两行滚一屏"；而"看脚本库"和"调识别器阈值"
 * 很少同时进行。Tab 头 28px，选中项记在 ui.store（切面板不丢）。
 *
 * Tab 列表就是下面这个数组：加一个 Tab = 加一行（内容组件自己不带面板头，
 * 面板头统一由这里画，避免"Tab 头 + 面板头"两层标题）。
 */
import { type ReactNode } from 'react';

import { ScriptLibraryPane } from '@/features/library/ScriptLibraryPane';
import { RecognizerPane } from '@/features/recognizers/RecognizerPane';
import { cn } from '@/lib/utils';
import { useGraphStore } from '@/stores/graph.store';
import { useDeviceStore } from '@/stores/device.store';
import { useUiStore } from '@/stores/ui.store';
import type { RightTab } from '@/types';

const TABS: ReadonlyArray<{ id: RightTab; label: string; hint: string }> = [
  {
    id: 'library',
    label: '工作区',
    hint: '多张状态图（一个目录 = 一张图）：切换 / 新建 / 复制 / 重命名 / 移除',
  },
  { id: 'identifiers', label: '识别器', hint: '模板/颜色识别器的实时分数与阈值滑块' },
];

export function RightColumn(): ReactNode {
  const tab = useUiStore((state) => state.rightTab);
  const setTab = useUiStore((state) => state.setRightTab);
  const activeId = useDeviceStore((state) => state.activeId);
  const recognizerCount = useGraphStore((state) => state.graphs[activeId]?.recognizers.length ?? 0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            title={item.hint}
            className={cn(
              'flex h-5 items-center gap-1 rounded-sm px-1.5 text-badge whitespace-nowrap',
              tab === item.id ? 'bg-active text-fg' : 'text-dim hover:bg-raised hover:text-fg',
            )}
          >
            {item.label}
            {item.id === 'identifiers' && <span className="text-faint">{recognizerCount}</span>}
          </button>
        ))}
        <span className="flex-1" />
        <span className="truncate text-badge text-faint">
          {tab === 'library' ? '一个目录 = 一张状态图' : '拖动滑块即时重算'}
        </span>
      </div>

      <div className="min-h-0 flex-1">{tab === 'library' ? <ScriptLibraryPane /> : <RecognizerPane />}</div>
    </div>
  );
}
