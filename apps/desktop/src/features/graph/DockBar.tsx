/**
 * 编辑坞（画布下方"详情"区）的控制条（参考 DevTools：左侧工具图标 + Tab，右侧状态与收起图标）。
 *
 * 为什么要它：坞的展开原来只有两个隐式入口 —— 选中节点/边（自动展开）、拖上面那道横线。
 * 详情坞显式展开/收起控制条。
 *
 * 行为：
 *   - 左侧 `tabs`（配置 / 控制台）；录制工具已搬到画面栏「素材区」头部，这里不再有工具图标
 *   - 右侧显示当前"在编辑什么"（哪个节点/边），收起时也能一眼看到选中项
 *   - 最右是收起/展开**图标按钮**（不用文字按钮样式）：收起后仍留 28px 提示条，横线还能抓
 *     （展开高度由 Panel 自己记着 —— 不在这里读 ref，渲染期读 ref 是 React 的禁忌）
 *   - 选中项变化时坞会自动展开（原有行为保留），这里只补显式开关
 */
import { ChevronDown, ChevronUp } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useState } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';

import { cn } from '@/lib/utils';

export function DockBar({
  panelRef,
  title,
  subtitle,
  onToggle,
  tabs,
}: {
  panelRef: RefObject<PanelImperativeHandle | null>;
  /** 收起时也显示：当前在编辑什么（节点名/边名） */
  title: string;
  subtitle?: string;
  onToggle?: (open: boolean) => void;
  /** Tab 条（配置 / 控制台） */
  tabs?: ReactNode;
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

  const label = open ? '收起详情' : '展开详情';
  const Icon = open ? ChevronDown : ChevronUp;

  return (
    <div className="flex h-[28px] shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
      {tabs}
      <span
        className="ml-auto min-w-0 truncate text-badge text-faint"
        title={`${title}${subtitle ? ` · ${subtitle}` : ''}`}
      >
        {title}
        {subtitle ? ` · ${subtitle}` : ''}
      </span>
      <button
        type="button"
        aria-label={label}
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
          'flex size-5 shrink-0 items-center justify-center rounded-sm',
          'text-dim hover:bg-raised hover:text-fg',
        )}
      >
        <Icon className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}
