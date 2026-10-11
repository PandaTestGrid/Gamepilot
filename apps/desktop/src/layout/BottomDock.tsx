/**
 * 底栏 + 调试抽屉。
 *
 * 两种状态共用同一条 28px 状态行（所以收起时不浪费空间）：
 *   收起：`node/tick/link/fps/capture/run` + 四个 Tab 按钮 + 「⌃ 抽屉」
 *   展开：状态行下面多出内容区（DebugDrawer），高度由外面那道横线拖（DOCK_LAYOUT 记忆）
 *
 * 点同一个 Tab = 收起（和"再点一次关掉"的直觉一致）；面板的展开/收起是命令式的
 * （`Panel` 的 collapse/expand），所以这里拿 `usePanelRef` 控制自己那一格的尺寸。
 */
import { ChevronDown, ChevronUp } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { type PanelImperativeHandle } from 'react-resizable-panels';

import { DebugDrawer } from '@/features/debug/DebugDrawer';
import { DOCK_TABS } from '@/features/debug/tabs';
import { StatusBar } from '@/layout/StatusBar';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui.store';

/** 收起态高度：与 StatusBar 的 h-6 对齐（见 layout-specs 里 dock 的 collapsedSize） */
export const DOCK_COLLAPSED_PX = 28;
/** 展开态的最小高度：再矮就只剩一条标题了 */
export const DOCK_MIN_PX = 140;

export function BottomDock({
  panelRef,
}: {
  panelRef: React.RefObject<PanelImperativeHandle | null>;
}): ReactNode {
  const tab = useUiStore((state) => state.dockTab);
  const open = useUiStore((state) => state.dockOpen);
  const toggleDock = useUiStore((state) => state.toggleDock);
  const closeDock = useUiStore((state) => state.closeDock);

  // ui.store 是抽屉的唯一状态源；面板尺寸跟着它走
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    if (open) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [open, panelRef]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-7 shrink-0 items-center gap-1 border-t border-line pl-3">
        <StatusBar />

        <span className="flex-1" />

        {DOCK_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            title={item.hint}
            onClick={() => toggleDock(item.id)}
            className={cn(
              'flex h-5 items-center gap-1 rounded-sm px-1.5 text-badge whitespace-nowrap',
              open && tab === item.id ? 'bg-active text-fg' : 'text-dim hover:bg-raised hover:text-fg',
            )}
          >
            {item.label}
          </button>
        ))}

        <button
          type="button"
          onClick={() => (open ? closeDock() : toggleDock(tab))}
          title={
            open ? '收起调试抽屉（也可以拖上面的横线）' : '展开调试抽屉（事件流 / 日志 / 控制台 / 时间轴）'
          }
          className="mr-2 flex h-5 items-center gap-1 rounded-sm px-1.5 text-badge text-dim hover:bg-raised hover:text-fg"
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
          {open ? '收起' : '抽屉'}
        </button>
      </div>

      {/* 收起时这块被 Panel 裁掉（collapsedSize=28px），内容不必卸载：
          事件/日志要保持订阅，卸载再挂会丢最近的状态 */}
      <div className="min-h-0 flex-1 border-t border-line">
        <DebugDrawer />
      </div>
    </section>
  );
}
