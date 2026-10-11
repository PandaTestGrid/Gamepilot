/**
 * 编辑坞（画布下方"详情"区）的显式 展开/收起 控制条。
 *
 * 为什么要它：坞的展开原来只有两个隐式入口 —— 选中节点/边（自动展开）、拖上面那道横线。
 * 用户反馈"下方加一个展开和收起的区域"：隐式入口不够，得有一个看得见、点得到的开关。
 *
 * 行为：
 *   - `展开/收起` 按钮：切换（收起后仍留 28px 提示条，横线还能抓）
 *   - 右侧显示当前"在编辑什么"（哪个节点/哪条边），收起时也能一眼看到选中项
 *     （展开高度由 Panel 自己记着 —— 不在这里读 ref，渲染期读 ref 是 React 的禁忌）
 *   - 选中项变化时坞会自动展开（原有行为保留），这里只补显式开关
 */
import { type ReactNode, type RefObject, useEffect, useState } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';

import { cn } from '@/lib/utils';

export function DockBar({
  panelRef,
  title,
  subtitle,
  onToggle,
}: {
  panelRef: RefObject<PanelImperativeHandle | null>;
  /** 收起时也显示：当前在编辑什么（节点名/边名） */
  title: string;
  subtitle?: string;
  onToggle?: (open: boolean) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);

  /*
   * 面板也可能是被拖开/被选中自动展开的 —— 以它的真实状态为准。
   * PanelImperativeHandle 没有"订阅尺寸"的接口，所以用一个轻量轮询同步（160ms，只有坞变高变矮才 setState）。
   */
  useEffect(() => {
    const sync = (): void => {
      const panel = panelRef.current;
      if (panel) {
        setOpen(!panel.isCollapsed());
      }
    };
    sync();
    const timer = window.setInterval(sync, 160);
    return () => window.clearInterval(timer);
  }, [panelRef]);

  return (
    <div className="flex h-[28px] shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
      <button
        type="button"
        onClick={() => {
          const panel = panelRef.current;
          if (!panel) {
            return;
          }
          const next = !open;
          if (next) {
            panel.expand();
          } else {
            panel.collapse();
          }
          setOpen(next);
          onToggle?.(next);
        }}
        title={open ? '收起详情（画布回到全高）' : '展开详情（也可以拖上面那道横线）'}
        className={cn(
          'flex items-center gap-1 rounded-sm border border-line px-1.5 text-badge',
          'text-dim hover:bg-raised hover:text-fg',
        )}
      >
        <span className={cn('transition-transform duration-150', open ? 'rotate-90' : '')}>▸</span>
        {open ? '收起' : '展开'}
      </button>
      <span className="truncate text-badge text-faint" title={`${title}${subtitle ? ` · ${subtitle}` : ''}`}>
        {title}
        {subtitle ? ` · ${subtitle}` : ''}
      </span>
    </div>
  );
}
