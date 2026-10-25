/**
 * 「多开」连体按钮：左半格切网格，右半格点开分列菜单。
 *
 * 为什么并成一颗：分列原来在网格上方单独占一行（「分列 自动(2) / 1列 / 2列 / 3列」），
 * 那条横条本身就把画面顶掉了几十像素 —— 而它只在多开时才有意义，
 * 挂在「多开」按钮上正好：不占额外高度，且和它控制的东西在同一处。
 *
 * 左半格仍然是原来的开关（点击 → 进/出多开网格），右半格（▾）只负责弹菜单；
 * 点菜单里的列数会顺手切到多开（否则"点了没反应"）。
 */
import { ChevronDown, Grid2x2 } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { GRID_COLUMN_CHOICES, useUiStore } from '@/stores/ui.store';

export function GridSplitButton({
  active,
  connectedCount,
  deviceCount,
  autoColumns,
  onToggle,
}: {
  /** 当前是不是多开网格 */
  active: boolean;
  connectedCount: number;
  deviceCount: number;
  /** 自动模式下算出来的列数（显示成「自动（2）」） */
  autoColumns: number;
  onToggle: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const preference = useUiStore((state) => state.gridColumns);
  const setColumns = useUiStore((state) => state.setGridColumns);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={root} className="relative flex shrink-0 items-center" data-testid="grid-split-button">
      {/* 左半：开关多开。和右半共用一条边框，视觉上是一颗连体按钮 */}
      <button
        type="button"
        data-testid="grid-toggle"
        aria-pressed={active}
        onClick={onToggle}
        title={`多开网格（当前 ${connectedCount} 台已连接 / 共 ${deviceCount} 台设备）`}
        className={cn(
          'flex h-5 items-center gap-1 rounded-l-sm border border-r-0 border-transparent px-1.5 text-badge whitespace-nowrap text-dim hover:bg-raised hover:text-fg',
          active && 'bg-active text-fg',
        )}
      >
        <Grid2x2 className="size-3" />
        多开{connectedCount > 0 ? ` ${connectedCount}` : ''}
      </button>
      {/* 右半：只弹分列菜单（不切网格，避免"想改列数却把网格关了"） */}
      <button
        type="button"
        data-testid="grid-columns-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="分列方式：自动 / 1~3 列"
        className={cn(
          'flex h-5 items-center rounded-r-sm border border-transparent px-1 text-dim hover:bg-raised hover:text-fg',
          (open || active) && 'text-fg',
          active && 'bg-active',
        )}
      >
        <ChevronDown className="size-3" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-6 left-0 z-30 w-[168px] rounded-sm border border-line bg-panel p-1 shadow-lg"
        >
          <div className="px-1.5 py-1 text-badge text-faint">分列（点一下记住）</div>
          {GRID_COLUMN_CHOICES.map((choice) => {
            const selected = preference === choice;
            return (
              <button
                key={String(choice)}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                data-testid={`grid-columns-${String(choice)}`}
                onClick={() => {
                  setColumns(choice);
                  // 选了列数就顺手进多开：否则看不出任何变化
                  if (!active) {
                    onToggle();
                  }
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-body hover:bg-raised',
                  selected && 'text-brand',
                )}
              >
                <span className="flex size-3 items-center justify-center">{selected ? '✓' : ''}</span>
                {choice === 'auto' ? (
                  <span className="flex-1">自动（{autoColumns}）</span>
                ) : (
                  <span className="flex-1">{choice} 列</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
