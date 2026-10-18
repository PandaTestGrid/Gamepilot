/** 画布编辑侧 effects（提示、模块拖入）。 */
import { useEffect } from 'react';

import { applyModuleDrop, type ModuleDropDeps } from '@/features/graph/flow/flow-mutations';
import type { FlowModulePointerDragContextValue } from '@/features/graph/flow/flow-module-pointer-drag';

export function useFlowNoticeAutoDismiss(
  flowNotice: { readonly id: number } | null,
  clearFlowNotice: (id?: number) => void,
  readOnly: boolean,
  ms = 4500,
): void {
  useEffect(() => {
    if (!flowNotice || readOnly) {
      return;
    }
    const timer = window.setTimeout(() => clearFlowNotice(flowNotice.id), ms);
    return () => window.clearTimeout(timer);
  }, [flowNotice, clearFlowNotice, readOnly, ms]);
}

export function useFlowModuleDropRegistration(
  readOnly: boolean,
  moduleDrag: FlowModulePointerDragContextValue | null,
  dropDeps: ModuleDropDeps,
  selectNode: (stepId: string) => void,
  flowPositionAt?: (clientX: number, clientY: number) => { x: number; y: number } | null,
): void {
  const registerModuleDropHandler = moduleDrag?.registerModuleDropHandler;

  useEffect(() => {
    if (!registerModuleDropHandler) {
      return;
    }
    if (readOnly) {
      registerModuleDropHandler(null);
      return;
    }
    registerModuleDropHandler((module, target, clientX, clientY) => {
      const position = flowPositionAt ? flowPositionAt(clientX, clientY) : null;
      void applyModuleDrop(target, module, position, dropDeps).then((newId) => {
        if (newId) {
          selectNode(newId);
        }
      });
    });
    return () => registerModuleDropHandler(null);
  }, [dropDeps, flowPositionAt, registerModuleDropHandler, readOnly, selectNode]);
}
