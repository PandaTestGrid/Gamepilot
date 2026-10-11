/**
 * 中间区域的状态图标签条（IDE 编辑器那样的"打开一个是一个"）。
 *
 * 模型：**引擎同一时刻只加载一个任务目录**（`session.switchProject` 会热重载所有设备的状态图），
 * 所以这里不是"同时打开多份图"，而是"记住打开过哪几张"：
 *   - 点右栏的一张状态图 → 引擎切过去（外面负责），这里被同步加进标签条；
 *   - 点标签 → 切到那张（已经是当前那张就不重复切，免得白白触发一次热重载）；
 *   - ✕ → 只从标签条里移除，**不删文件**；关掉的正好是当前那张时切到相邻那张
 *     （关掉最后一个就什么都不切 —— 中间显示"没有打开的状态图"空态，见 GraphPane）。
 *
 * 标签条的宽度归 PanelShell 的 `tabs` 槽：标签多了横向滚动，绝不换行、不压缩标题。
 */
import { X } from 'lucide-react';
import { type ReactNode } from 'react';

import { taskName } from '@/features/graph/task-name';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

export function GraphTabs(): ReactNode {
  const openGraphs = useUiStore((state) => state.openGraphs);
  const closeGraph = useUiStore((state) => state.closeGraph);
  const currentRoot = useSessionStore((state) => state.project?.root ?? '');
  const switchProject = useSessionStore((state) => state.switchProject);

  if (openGraphs.length === 0) {
    return null;
  }

  const close = (root: string): void => {
    const index = openGraphs.indexOf(root);
    // 关掉当前这张 → 接上右边那个；右边没有就退到左边那个（IDE 的常规行为）
    const neighbour = openGraphs[index + 1] ?? openGraphs[index - 1];
    closeGraph(root);
    if (root === currentRoot && neighbour) {
      void switchProject(neighbour);
    }
  };

  return (
    <>
      {openGraphs.map((root) => {
        const active = root === currentRoot;
        return (
          <span
            key={root}
            className={cn(
              'group/tab flex h-5 shrink-0 items-center rounded-sm',
              active ? 'bg-active text-fg' : 'text-dim hover:bg-raised hover:text-fg',
            )}
          >
            <button
              type="button"
              title={root}
              onClick={() => {
                if (!active) {
                  void switchProject(root);
                }
              }}
              className="flex min-w-0 items-center pr-1 pl-2 text-badge whitespace-nowrap"
            >
              <span className="max-w-[10rem] truncate">{taskName(root)}</span>
            </button>
            <button
              type="button"
              title="关闭这个标签（只是关掉界面，文件还在）"
              onClick={() => close(root)}
              className={cn(
                'mr-0.5 rounded-sm px-0.5 hover:bg-raised hover:text-fg',
                // 当前那个常显，其余的悬停才出现 —— 和右栏树里的行内操作一个规矩
                active ? 'text-dim' : 'text-faint opacity-0 group-hover/tab:opacity-100',
              )}
            >
              <X className="size-3" />
            </button>
          </span>
        );
      })}
    </>
  );
}
