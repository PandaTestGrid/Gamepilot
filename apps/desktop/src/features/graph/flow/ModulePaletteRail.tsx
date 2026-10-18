/**
 * 工作流画布左侧模块栏：可拖宽、可收起（与画面栏素材区同一套 Panel 模式）。
 *
 * 模块栏按像素宽，父栏（画面|画布）变宽时保持像素不变，多出来的宽度给画布。
 * 只有拖模块栏自己右侧的竖线才会改它的宽度。
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useState } from 'react';
import { Group, Panel, Separator, type PanelImperativeHandle } from 'react-resizable-panels';

import { ModulePalette } from '@/features/graph/flow/ModulePalette';
import { GRAPH_PALETTE_LAYOUT } from '@/layout/layout-specs';
import { useLayoutGroup } from '@/layout/useLayoutGroup';
import { cn } from '@/lib/utils';

const PALETTE_COLLAPSED_PX = 36;
const PALETTE_MIN_PX = 152;
const PALETTE_DEFAULT_PX = 168;
const PALETTE_MAX_PX = 280;

export function ModulePaletteRail({
  paletteRef,
  paletteOpen,
  setPaletteOpen,
  children,
}: {
  paletteRef: RefObject<PanelImperativeHandle | null>;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  children: ReactNode;
}): ReactNode {
  const layout = useLayoutGroup(GRAPH_PALETTE_LAYOUT);
  /** 宽度尚在 min 以下但面板尚未 snap 收起时，先切磁贴窄栏 UI，避免拖宽过程中仍渲染双列+搜索 */
  const [paletteCompact, setPaletteCompact] = useState(false);

  useEffect(() => {
    const panel = paletteRef.current;
    if (!panel) {
      return;
    }
    if (paletteOpen) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [paletteOpen, paletteRef]);

  return (
    <Group
      id={GRAPH_PALETTE_LAYOUT.id}
      orientation="horizontal"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      groupRef={layout.groupRef}
      className="h-full min-h-0"
    >
      <Panel
        id="palette"
        defaultSize={`${PALETTE_DEFAULT_PX}px`}
        minSize={`${PALETTE_MIN_PX}px`}
        maxSize={`${PALETTE_MAX_PX}px`}
        groupResizeBehavior="preserve-pixel-size"
        collapsible
        collapsedSize={`${PALETTE_COLLAPSED_PX}px`}
        panelRef={paletteRef}
        onResize={(size) => {
          const collapsed = paletteRef.current?.isCollapsed() ?? false;
          if (paletteOpen !== !collapsed) {
            setPaletteOpen(!collapsed);
          }
          const compact = collapsed || size.inPixels < PALETTE_MIN_PX - 1;
          setPaletteCompact((prev) => (prev === compact ? prev : compact));
        }}
        style={{ overflow: 'hidden' }}
      >
        <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-panel">
          <div
            className={cn(
              'flex h-[26px] shrink-0 items-center gap-1 border-b border-line px-1 py-0.5',
              paletteOpen ? '' : 'justify-center',
            )}
          >
            <button
              type="button"
              onClick={() => setPaletteOpen(!paletteOpen)}
              title={
                paletteOpen ? '收起模块栏（也可把右侧竖线拖到底）' : '展开模块栏（拖模块到画布 · 双击追加）'
              }
              className="flex items-center gap-0.5 rounded-sm px-1 text-badge text-dim hover:bg-raised hover:text-fg"
            >
              {paletteOpen ? <ChevronLeft className="size-3" /> : <ChevronRight className="size-3" />}
              {paletteOpen ? <span>模块</span> : null}
            </button>
          </div>
          <ModulePalette
            collapsed={!paletteOpen || paletteCompact}
            className="min-h-0 w-full flex-1 border-r-0"
          />
        </div>
      </Panel>
      <Separator className="w-px bg-line transition-colors hover:bg-brand" title="拖动改模块栏宽度" />
      <Panel
        id="workspace"
        minSize="120px"
        groupResizeBehavior="preserve-relative-size"
        style={{ overflow: 'hidden' }}
      >
        {children}
      </Panel>
    </Group>
  );
}
