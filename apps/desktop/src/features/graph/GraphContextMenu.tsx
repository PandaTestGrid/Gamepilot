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
 * 菜单 portal 到 `body`：节点在 React Flow 变换内时，`fixed` 定位会错位。
 */
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

export interface MenuField {
  readonly key: string;
  readonly placeholder: string;
  readonly defaultValue?: string;
}

/**
 * 菜单里的**内联输入行**：二级菜单不只有预设，还得能填具体值。
 *
 * 二级菜单内可填相对坐标等参数，不必跳转详情面板。
 */
export interface MenuInput {
  readonly fields: readonly MenuField[];
  readonly submitLabel: string;
  readonly onSubmit: (values: Record<string, string>) => void;
}

export interface MenuItem {
  readonly label: string;
  readonly hint?: string;
  /** 菜单项左侧图标 */
  readonly icon?: ReactNode;
  /** 内联输入行（有它时这一项不是按钮，而是一行小表单） */
  readonly input?: MenuInput;
  /** 输入行的说明（比如"相对坐标 0~1，也可以写 50%"） */
  readonly note?: string;
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

const ITEM_HEIGHT = 28;
const MENU_WIDTH = 248;
const HEADER_HEIGHT = 26;

function menuHeight(items: readonly MenuItem[]): number {
  return HEADER_HEIGHT + items.length * ITEM_HEIGHT + 10;
}

/** 菜单里的一行小表单：字段 + 提交（Enter 也能提交） */
function MenuInputRow({ item }: { item: MenuItem }): ReactNode {
  const input = item.input;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((input?.fields ?? []).map((field) => [field.key, field.defaultValue ?? ''])),
  );
  if (!input) {
    return null;
  }
  const submit = (): void => {
    input.onSubmit(values);
  };
  return (
    <div className="px-2 py-1" onMouseDown={(event) => event.stopPropagation()}>
      <div className="mb-1 text-badge text-faint">{item.label}</div>
      <div className="flex items-center gap-1">
        {input.fields.map((field) => (
          <input
            key={field.key}
            value={values[field.key] ?? ''}
            placeholder={field.placeholder}
            aria-label={field.placeholder}
            onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                submit();
              }
            }}
            className="h-6 w-12 rounded-sm border border-line bg-canvas px-1 text-center text-badge text-fg"
          />
        ))}
        <button
          type="button"
          onClick={submit}
          className="h-6 rounded-sm border border-brand px-1.5 text-badge text-brand hover:bg-raised"
        >
          {input.submitLabel}
        </button>
      </div>
      {item.note && <div className="mt-0.5 text-badge text-faint">{item.note}</div>}
    </div>
  );
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
      className="w-[248px] rounded-sm border border-line bg-panel py-1 shadow-lg"
    >
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`} onMouseEnter={() => onHoverItem?.(index)}>
          {item.divider && <div className="my-1 h-px bg-line" />}
          {item.input ? (
            <MenuInputRow item={item} />
          ) : (
            <button
              type="button"
              data-has-submenu={item.submenu ? 'true' : undefined}
              onClick={() => onPick(item)}
              title={item.hint ? `${item.label} · ${item.hint}` : item.label}
              className={cn(
                'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-body transition-colors hover:bg-raised',
                item.danger ? 'text-failed hover:bg-failed/10' : 'text-fg',
                openIndex === index && item.submenu && 'bg-raised',
              )}
            >
              {item.icon ? (
                <span
                  className={cn(
                    'flex size-3.5 shrink-0 items-center justify-center',
                    item.danger ? 'text-failed' : 'text-dim',
                  )}
                >
                  {item.icon}
                </span>
              ) : null}
              <span className="shrink-0 whitespace-nowrap font-medium">{item.label}</span>
              {item.hint && (
                <span className="ml-auto min-w-0 truncate pl-2 text-badge text-faint">{item.hint}</span>
              )}
              {item.submenu && <span className="ml-auto shrink-0 text-badge text-faint">›</span>}
            </button>
          )}
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
    if (item.input) {
      return; // 输入行自己有提交按钮
    }
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
          {anchor.title ? (
            <div className="mb-0.5 truncate px-2 py-0.5 text-badge text-faint">{anchor.title}</div>
          ) : null}
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
