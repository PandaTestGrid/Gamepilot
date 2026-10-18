/**
 * 左侧模块列表（Automa 式：搜索 + 分组折叠 + 双列磁贴；拖到画布 / 双击追加）。
 */
import { type ReactNode, useMemo, useState } from 'react';

import { FlowStepIcon } from './flow-step-icons';
import { useFlowModulePointerDrag } from '@/features/graph/flow/flow-module-pointer-drag';
import { setDraggingModule } from '@/features/graph/flow/module-drag';
import { flowModuleGroupsForDevice, type PaletteModule } from '@/features/graph/flow/flow-step-meta';
import { useCurrentWorkflowLive } from '@/lib/useLiveWorkflow';
import { activeDevice, useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';
import { cn } from '@/lib/utils';

function ModuleTile({
  item,
  collapsed = false,
  onPointerDown,
  onDoubleClick,
}: {
  item: PaletteModule;
  collapsed?: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onDoubleClick: () => void;
}): ReactNode {
  return (
    <div
      title={`${item.label}：${item.hint}（拖到画布 / 双击追加）`}
      onPointerDown={onPointerDown}
      onPointerUp={() => setDraggingModule(null)}
      onDoubleClick={onDoubleClick}
      className={cn(
        'flex touch-none cursor-grab items-center justify-center rounded-sm border border-line bg-canvas text-center active:cursor-grabbing hover:border-brand/50 hover:bg-raised',
        collapsed ? 'size-7 p-0 hover:text-fg' : 'flex-col gap-0.5 px-1 py-1.5',
      )}
    >
      <FlowStepIcon
        type={item.type}
        className={cn('shrink-0 text-dim', collapsed ? 'size-3.5' : 'size-4')}
        strokeWidth={1.75}
      />
      {collapsed ? null : (
        <span className="w-full text-[10px] leading-tight text-dim line-clamp-2">{item.label}</span>
      )}
    </div>
  );
}

export function ModulePalette({
  collapsed: railCollapsed = false,
  className,
}: {
  collapsed?: boolean;
  className?: string;
}): ReactNode {
  const { beginModulePointerDrag } = useFlowModulePointerDrag();
  const appendFlowModule = useGraphStore((state) => state.appendFlowModule);
  const selectNode = useGraphStore((state) => state.selectNode);
  const lockEdits = useCurrentWorkflowLive();
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const deviceKind = activeDevice(devices, activeId)?.kind;
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const addModule = (item: PaletteModule): void => {
    if (lockEdits) {
      return;
    }
    void appendFlowModule(item).then((id) => {
      if (id) {
        selectNode(id);
      }
    });
  };

  const normalizedQuery = railCollapsed ? '' : query.trim().toLowerCase();

  const groups = useMemo(() => {
    return flowModuleGroupsForDevice(deviceKind)
      .map((group) => {
        const items = group.items.filter((item) => {
          if (!normalizedQuery) {
            return true;
          }
          return (
            item.label.toLowerCase().includes(normalizedQuery) ||
            item.type.toLowerCase().includes(normalizedQuery) ||
            item.hint.toLowerCase().includes(normalizedQuery)
          );
        });
        return { ...group, items };
      })
      .filter((group) => group.items.length > 0);
  }, [deviceKind, normalizedQuery]);

  if (railCollapsed) {
    return (
      <aside
        data-testid="module-palette-collapsed"
        className={cn(
          'flex h-full min-w-0 flex-1 flex-col items-center border-r border-line bg-panel',
          className,
        )}
      >
        <div
          className={cn(
            'flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto py-1.5',
            lockEdits && 'pointer-events-none opacity-40',
          )}
        >
          {groups.map((group, groupIndex) => (
            <div key={group.label} className="flex w-full flex-col items-center gap-1">
              {groupIndex > 0 ? <div className="my-0.5 h-px w-4 bg-line" /> : null}
              {group.items.map((item) => (
                <ModuleTile
                  key={item.type}
                  item={item}
                  collapsed
                  onPointerDown={(event) => {
                    if (!lockEdits) {
                      beginModulePointerDrag(item, event);
                    }
                  }}
                  onDoubleClick={() => addModule(item)}
                />
              ))}
            </div>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside
      data-testid="module-palette"
      className={cn(
        'flex h-full min-h-0 min-w-0 w-full flex-1 flex-col border-r border-line bg-panel',
        className,
      )}
    >
      <div className="border-b border-line p-1.5">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模块…"
          className="h-6 w-full rounded-sm border border-line bg-canvas px-2 text-badge text-fg placeholder:text-faint focus:border-brand focus:outline-none"
        />
      </div>
      <div className={cn('min-h-0 flex-1 overflow-auto py-1', lockEdits && 'pointer-events-none opacity-40')}>
        {groups.length === 0 ? (
          <p className="px-2 py-2 text-badge text-faint">没有匹配的模块</p>
        ) : (
          groups.map((group) => {
            const open = collapsed[group.label] !== true;
            return (
              <div key={group.label} className="mb-1">
                <button
                  type="button"
                  onClick={() => setCollapsed((state) => ({ ...state, [group.label]: open ? true : false }))}
                  className="flex w-full items-center justify-start gap-1 px-2 py-0.5 text-left text-[11px] text-dim hover:bg-raised/50"
                  title={group.label}
                >
                  <span className={cn('text-faint', open ? 'rotate-90' : '')}>▸</span>
                  <span className="font-medium">{group.label}</span>
                </button>
                {open ? (
                  <div className="grid grid-cols-2 gap-1 px-1.5 pb-1">
                    {group.items.map((item) => (
                      <ModuleTile
                        key={item.type}
                        item={item}
                        onPointerDown={(event) => {
                          if (!lockEdits) {
                            beginModulePointerDrag(item, event);
                          }
                        }}
                        onDoubleClick={() => addModule(item)}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      <div className="border-t border-line px-2 py-1 text-[10px] leading-snug text-faint">
        拖到空白处 = 未接入 · 拖到模块的出口/入口/身上 = 自动接线 · 双击 = 追加到链尾
      </div>
    </aside>
  );
}
