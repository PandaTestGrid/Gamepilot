/**
 * 画布右键菜单 / 节点里的「＋操作」菜单。
 *
 * 三种目标各有各的菜单：
 *   - 空白画布：新建界面节点（加在鼠标位置）
 *   - 节点：加一步操作（**二级菜单选类型与参数**）/ 加分支 / 重命名 / 删除
 *   - 边：改这一步 / 删除这条边
 *
 * **二级菜单**：菜单项可以带 `submenu`，悬停或点一下展开 ——
 * "加一步操作"这种"先选类型、再选参数"的流程，一级菜单塞不下也不该塞：
 * 一级是"要做什么"，二级是"具体怎么做"（哪个模板 / 等多久 / 按哪个键 / 给哪个变量赋值）。
 *
 * ⚠️ 必须 **portal 到 body**：菜单也会从节点卡片里弹出（"＋操作"），而卡片处在 React Flow
 * 的 `scale()/translate()` 变换里 —— `position: fixed` 会被这个变换劫持（坐标被缩放/平移），
 * 菜单会飞到视口外，点上去什么都不会发生（实测踩过：菜单落在 y=1307）。二级菜单同样在 portal 里。
 */
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

export interface MenuItem {
  readonly label: string;
  readonly hint?: string;
  /** 有子菜单时可以不传（点了只展开子菜单） */
  readonly onSelect?: () => void;
  readonly danger?: boolean;
  /** 分隔线：在这一项之前画一条 */
  readonly divider?: boolean;
  /** 二级菜单：悬停 / 点一下展开 */
  readonly submenu?: readonly MenuItem[];
}

export interface MenuAnchor {
  /** 画布坐标（xyflow 的 flow 坐标系） */
  readonly flow: { x: number; y: number };
  /** 屏幕坐标（菜单画在这里） */
  readonly screen: { x: number; y: number };
  readonly kind: 'pane' | 'node' | 'edge';
  readonly id?: string;
  readonly title: string;
  readonly items: readonly MenuItem[];
}

const ITEM_HEIGHT = 26;
const MENU_WIDTH = 216;
const HEADER_HEIGHT = 26;

function menuHeight(items: readonly MenuItem[]): number {
  return HEADER_HEIGHT + items.length * ITEM_HEIGHT + 10;
}

/** 菜单列表（一级和二级共用同样的行高与样式） */
function MenuList({
  items,
  onPick,
  onHoverItem,
  openIndex,
  style,
}: {
  items: readonly MenuItem[];
  onPick: (item: MenuItem) => void;
  onHoverItem?: (index: number) => void;
  openIndex?: number;
  style?: CSSProperties;
}): ReactNode {
  return (
    <div
      data-testid="graph-context-menu-list"
      style={style}
      className="w-54 rounded-sm border border-line bg-panel py-1 shadow-lg"
    >
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`} onMouseEnter={() => onHoverItem?.(index)}>
          {item.divider && <div className="my-1 h-px bg-line" />}
          <button
            type="button"
            data-has-submenu={item.submenu ? 'true' : undefined}
            onClick={() => onPick(item)}
            className={cn(
              'flex w-full items-center gap-2 px-2 py-1 text-left text-body hover:bg-raised',
              item.danger ? 'text-failed' : 'text-fg',
              openIndex === index && item.submenu && 'bg-raised',
            )}
          >
            <span className="flex-1 truncate">{item.label}</span>
            {item.hint && <span className="shrink-0 text-badge text-faint">{item.hint}</span>}
            {item.submenu && <span className="shrink-0 text-badge text-faint">›</span>}
          </button>
        </div>
      ))}
    </div>
  );
}

export function GraphContextMenu({
  anchor,
  onClose,
}: {
  anchor: MenuAnchor;
  onClose: () => void;
}): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  // 点别处 / Esc 都关掉（右键菜单不该黏在屏幕上）
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  // 贴边翻转：靠近右/下边缘时往回收，别画到窗口外
  const width = MENU_WIDTH;
  const height = menuHeight(anchor.items);
  const left = Math.max(8, Math.min(anchor.screen.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(anchor.screen.y, window.innerHeight - height - 8));

  const open = openIndex === null ? null : anchor.items[openIndex];
  const submenu = open?.submenu;
  const submenuHeight = submenu ? menuHeight(submenu) : 0;
  const submenuTop = Math.max(
    8,
    Math.min(top + HEADER_HEIGHT + (openIndex ?? 0) * ITEM_HEIGHT, window.innerHeight - submenuHeight - 8),
  );

  const pick = (item: MenuItem): void => {
    if (item.submenu) {
      // 一级项点了只展开二级（触屏没有 hover，点开更稳）
      setOpenIndex(anchor.items.indexOf(item));
      return;
    }
    item.onSelect?.();
    onClose();
  };

  return createPortal(
    <div
      ref={root}
      data-testid="graph-context-menu"
      className="fixed z-50"
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="flex flex-col gap-1">
        <div>
          <div className="px-2 py-0.5 text-badge text-faint">{anchor.title}</div>
          <MenuList
            items={anchor.items}
            onPick={pick}
            onHoverItem={setOpenIndex}
            openIndex={openIndex ?? undefined}
          />
        </div>

        {/*
          二级菜单：绝对定位在父菜单右边（右边放不下就翻到左边 + 缩到 8px 边距内），
          这样不用量 DOM 也能稳稳落在窗口里。
        */}
        {submenu && (
          <div
            className="fixed"
            style={{
              left: Math.max(8, left + width + 4),
              top: submenuTop,
            }}
          >
            <MenuList items={submenu} onPick={pick} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
