/**
 * 左栏模块 → 画布：指针拖放（Tauri/WebView2 下 HTML5 DnD 常被原生层禁掉，见 use-workspace-drop 注释）。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { resolveModuleDropTarget, type ModuleDropTarget } from '@/features/graph/flow/flow-drop-target';
import { setDraggingModule } from '@/features/graph/flow/module-drag';
import type { PaletteModule } from '@/features/graph/flow/flow-step-meta';
import { devLog } from '@/lib/rpc';

const DRAG_THRESHOLD_PX = 4;
const BODY_DRAG_CLASS = 'flow-module-pointer-dragging';

type DropHandler = (
  module: PaletteModule,
  target: ModuleDropTarget,
  clientX: number,
  clientY: number,
) => void;

export interface FlowModulePointerDragContextValue {
  readonly hoverStepId: string | null;
  readonly dropTarget: ModuleDropTarget | null;
  readonly isDraggingModule: boolean;
  beginModulePointerDrag: (module: PaletteModule, event: React.PointerEvent) => void;
  registerModuleDropHandler: (handler: DropHandler | null) => void;
}

const FlowModulePointerDragContext = createContext<FlowModulePointerDragContextValue | null>(null);

export function useFlowModulePointerDrag(): FlowModulePointerDragContextValue {
  const value = useContext(FlowModulePointerDragContext);
  if (!value) {
    throw new Error('useFlowModulePointerDrag 必须在 FlowModulePointerDragProvider 内使用');
  }
  return value;
}

export function FlowModulePointerDragProvider({ children }: { children: ReactNode }): ReactNode {
  const dropHandlerRef = useRef<DropHandler | null>(null);
  const pendingRef = useRef<{
    module: PaletteModule;
    startX: number;
    startY: number;
    pointerId: number;
  } | null>(null);
  const captureElRef = useRef<HTMLElement | null>(null);
  const draggingRef = useRef(false);
  const dragModuleRef = useRef<PaletteModule | null>(null);
  const [ghost, setGhost] = useState<{ module: PaletteModule; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<ModuleDropTarget | null>(null);
  const hoverStepId = dropTarget?.anchorStepId ?? null;

  const registerModuleDropHandler = useCallback((handler: DropHandler | null) => {
    dropHandlerRef.current = handler;
  }, []);

  const beginModulePointerDrag = useCallback((module: PaletteModule, event: React.PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    captureElRef.current = target;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      /* 部分环境不支持 */
    }
    pendingRef.current = {
      module,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
    };
    draggingRef.current = false;
    setDraggingModule(module);
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const pending = pendingRef.current;
      if (pending && event.pointerId !== pending.pointerId) {
        return;
      }
      // pointerup 可能没送到（切窗口 / WebView 失焦 / 原生层吞掉）：鼠标键已经松开就按取消收尾。
      // 否则 pending / ghost 一直挂着 —— 表现为悬停节点时节点跟着闪、下一次点击莫名插入模块。
      if ((pending || draggingRef.current) && event.buttons === 0) {
        pendingRef.current = null;
        draggingRef.current = false;
        dragModuleRef.current = null;
        captureElRef.current = null;
        document.body.classList.remove(BODY_DRAG_CLASS);
        setGhost(null);
        setDropTarget(null);
        setDraggingModule(null);
        return;
      }
      if (pending && !draggingRef.current) {
        const dx = event.clientX - pending.startX;
        const dy = event.clientY - pending.startY;
        if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
          draggingRef.current = true;
          dragModuleRef.current = pending.module;
          document.body.classList.add(BODY_DRAG_CLASS);
          setGhost({ module: pending.module, x: event.clientX, y: event.clientY });
        }
      }
      if (draggingRef.current) {
        // 只有**真正拖起来之后**才更新落点：单击（还没过阈值）不该让整个画布跟着每次移动重渲染。
        // 同一个落点直接返回原对象，免得 pointermove 每帧都 setState → 悬停节点时文字抖动。
        const next = resolveModuleDropTarget(event.clientX, event.clientY);
        setDropTarget((current) => {
          if (
            current &&
            current.anchorStepId === next.anchorStepId &&
            current.placement === next.placement &&
            current.onInputHandle === next.onInputHandle &&
            current.onOutputHandle === next.onOutputHandle &&
            current.handleId === next.handleId
          ) {
            return current;
          }
          devLog(`模块拖拽落点: ${next.anchorStepId ?? '画布'} (${next.placement})`);
          return next;
        });
        setGhost((current) => (current ? { ...current, x: event.clientX, y: event.clientY } : current));
      }
    };

    const finish = (event: PointerEvent): void => {
      const pending = pendingRef.current;
      if (pending && event.pointerId !== pending.pointerId) {
        return;
      }
      const wasDragging = draggingRef.current;
      const module = dragModuleRef.current;
      pendingRef.current = null;
      draggingRef.current = false;
      dragModuleRef.current = null;
      document.body.classList.remove(BODY_DRAG_CLASS);
      setGhost(null);
      setDropTarget(null);
      setDraggingModule(null);

      const captureEl = captureElRef.current;
      captureElRef.current = null;
      if (captureEl) {
        try {
          captureEl.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
      }

      if (!wasDragging || !module || !dropHandlerRef.current) {
        return;
      }
      const target = resolveModuleDropTarget(event.clientX, event.clientY);
      if (target.onCanvas) {
        dropHandlerRef.current(module, target, event.clientX, event.clientY);
      }
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      document.body.classList.remove(BODY_DRAG_CLASS);
    };
  }, []);

  const value: FlowModulePointerDragContextValue = {
    hoverStepId,
    dropTarget,
    isDraggingModule: ghost !== null,
    beginModulePointerDrag,
    registerModuleDropHandler,
  };

  return (
    <FlowModulePointerDragContext.Provider value={value}>
      {children}
      {ghost &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[9999] -translate-x-1/2 -translate-y-1/2 rounded-sm border border-brand bg-panel px-2 py-1 text-badge text-brand shadow-none"
            style={{ left: ghost.x, top: ghost.y }}
          >
            {ghost.module.label}
          </div>,
          document.body,
        )}
    </FlowModulePointerDragContext.Provider>
  );
}
