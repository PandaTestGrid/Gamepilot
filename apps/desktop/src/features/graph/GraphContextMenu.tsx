/**
 * 画布右键菜单：把"加东西"从顶部按钮挪到鼠标所在的位置。
 *
 * 三种目标各有各的菜单（这才是右键该有的样子）：
 *   - 空白画布：新建界面节点（加在鼠标位置）
 *   - 节点：加一步操作 / 加分支 / 重命名 / 挂识别器（滚到详情）/ 删除
 *   - 边：改这一步（滚到动作区）/ 删除这条边
 *
 * 只做**入口与删除**这类不可能误操作的项：真正的参数编辑仍然在下方详情面板里，
 * 免得菜单里塞一堆输入框（右键菜单一多就没人用）。
 */
import { type ReactNode, useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

export interface MenuItem {
  readonly label: string;
  readonly hint?: string;
  readonly onSelect: () => void;
  readonly danger?: boolean;
  /** 分隔线：在这一项之前画一条 */
  readonly divider?: boolean;
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

export function GraphContextMenu({
  anchor,
  onClose,
}: {
  anchor: MenuAnchor;
  onClose: () => void;
}): ReactNode {
  const root = useRef<HTMLDivElement>(null);

  // 点别处 / Esc / 滚轮都关掉（右键菜单不该黏在屏幕上）
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
  const width = 208;
  const height = 34 + anchor.items.length * 26;
  const left = Math.min(anchor.screen.x, window.innerWidth - width - 8);
  const top = Math.min(anchor.screen.y, window.innerHeight - height - 8);

  return (
    <div
      ref={root}
      data-testid="graph-context-menu"
      className="fixed z-50 w-52 rounded-sm border border-line bg-panel py-1 shadow-lg"
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="truncate px-2 py-0.5 text-badge text-faint">{anchor.title}</div>
      {anchor.items.map((item) => (
        <div key={item.label}>
          {item.divider && <div className="my-1 h-px bg-line" />}
          <button
            type="button"
            onClick={() => {
              item.onSelect();
              onClose();
            }}
            className={cn(
              'flex w-full items-center gap-2 px-2 py-1 text-left text-body hover:bg-raised',
              item.danger ? 'text-failed' : 'text-fg',
            )}
          >
            <span className="flex-1 truncate">{item.label}</span>
            {item.hint && <span className="shrink-0 text-badge text-faint">{item.hint}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}
