/**
 * 布局菜单：预设 / 恢复默认。
 *
 * 加它的原因很直接：现在**横向纵向都能拖**（主壳三栏拖宽度，栏内拖高度），
 * 拖乱了必须有一步回到可用状态，否则用户只能去清 localStorage。
 * 菜单里那句提示也是新交互的说明书：哪条线能拖、往哪个方向拖。
 */
import { LayoutPanelLeft, RotateCcw } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { ToolbarButton } from '@/layout/PanelShell';
import { applyLayoutPreset, LAYOUT_PRESETS, resetLayouts } from '@/layout/layout-specs';
import { useUiStore } from '@/stores/ui.store';

export function LayoutMenu(): ReactNode {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // 这块弹层盖住右栏，点别处/Esc 要能收起来（不然会一直杵在界面上）
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
    <div ref={root} className="relative">
      <ToolbarButton
        active={open}
        onClick={() => setOpen((value) => !value)}
        title="布局：一键预设 / 恢复默认（区域之间的分隔线横向纵向都能拖）"
      >
        <LayoutPanelLeft className="size-3.5" />
        布局
      </ToolbarButton>

      {open && (
        <div className="absolute top-7 right-0 z-30 w-[280px] rounded-sm border border-line bg-panel p-1 shadow-lg">
          <div className="px-1.5 py-1 text-badge text-faint">预设（点一下立刻生效并记住）</div>
          {LAYOUT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                useUiStore.getState().setLeftPaneOpen(true);
                useUiStore.getState().setRightPaneOpen(true);
                applyLayoutPreset(preset);
              }}
              className="flex w-full flex-col rounded-sm px-1.5 py-1 text-left hover:bg-raised"
              title={preset.note}
            >
              <span className="text-body">{preset.name}</span>
              <span className="text-badge text-faint">{preset.note}</span>
            </button>
          ))}

          <div className="my-1 h-px bg-line" />

          <button
            type="button"
            onClick={() => {
              useUiStore.getState().setLeftPaneOpen(true);
              useUiStore.getState().setRightPaneOpen(true);
              resetLayouts();
              setOpen(false);
            }}
            className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-body hover:bg-raised"
          >
            <RotateCcw className="size-3" />
            恢复默认布局
          </button>

          <div className="px-1.5 py-1 text-badge text-faint">
            左右拖栏与栏之间的竖线改宽度；上下拖栏内的横线改高度（画面/素材区、事件/识别器、画布/编辑器）。
            双击横线或竖线 = 这一栏回到默认比例。
          </div>
        </div>
      )}
    </div>
  );
}
