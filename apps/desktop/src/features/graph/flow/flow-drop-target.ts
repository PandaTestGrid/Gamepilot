/** 画布 / 模块栏：拖放落点命中（DOM + 目标结构）。 */
import { isBranchSourceHandle, type FlowSourceHandleId } from '@/features/graph/flow/flow-step-ports';

function stackElementsAtPoint(clientX: number, clientY: number): Element[] {
  const hit =
    typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(clientX, clientY)
      : [document.elementFromPoint(clientX, clientY)].filter(Boolean);
  return hit as Element[];
}

const FLOW_SURFACE_SELECTORS = [
  '[data-testid="flow-canvas"]',
  '[data-testid="flow-canvas-wrap"]',
  '.react-flow',
] as const;

function isOnFlowDropSurface(el: Element): boolean {
  return FLOW_SURFACE_SELECTORS.some((selector) => el.closest(selector));
}

// --- 模块栏拖入 ---

export interface ModuleDropTarget {
  readonly onCanvas: boolean;
  readonly anchorStepId: string | null;
  readonly placement: 'append' | 'after' | 'before';
  readonly onOutputHandle: boolean;
  readonly onInputHandle: boolean;
  readonly handleId?: FlowSourceHandleId;
}

export function resolveModuleDropTarget(clientX: number, clientY: number): ModuleDropTarget {
  const stack = stackElementsAtPoint(clientX, clientY);

  let onCanvas = false;
  let anchorStepId: string | null = null;
  let placement: ModuleDropTarget['placement'] = 'append';
  let onOutputHandle = false;
  let onInputHandle = false;
  let outputHandle: FlowSourceHandleId | undefined;

  for (const el of stack) {
    if (isOnFlowDropSurface(el)) {
      onCanvas = true;
    }

    const handleEl = el.closest('.react-flow__handle');
    if (handleEl) {
      const handleId = handleEl.getAttribute('data-handleid') ?? '';
      const isSource =
        handleEl.classList.contains('source') ||
        handleEl.getAttribute('data-handlepos') === 'right' ||
        handleId === 'out' ||
        handleId === 'then' ||
        handleId === 'else' ||
        handleId === 'body';
      const isTarget =
        handleEl.classList.contains('target') ||
        handleEl.getAttribute('data-handlepos') === 'left' ||
        handleId === 'in' ||
        handleId === 'back';
      const host = handleEl.closest('[data-flow-step-id]') ?? handleEl.closest('.react-flow__node');
      const hostId =
        host?.getAttribute('data-flow-step-id') ??
        host?.getAttribute('data-id') ??
        host?.getAttribute('data-nodeid') ??
        null;
      if (hostId) {
        anchorStepId = hostId;
        onCanvas = true;
        if (isSource) {
          onOutputHandle = true;
          if (isBranchSourceHandle(handleId)) {
            outputHandle = handleId;
          }
          placement = 'after';
        } else if (isTarget) {
          onInputHandle = true;
          placement = 'before';
        }
        break;
      }
    }

    const stepEl =
      el.closest('[data-flow-step-id]') ??
      (el.classList.contains('react-flow__node') ? el : el.closest('.react-flow__node'));
    if (stepEl) {
      const id =
        stepEl.getAttribute('data-flow-step-id') ??
        stepEl.getAttribute('data-id') ??
        stepEl.getAttribute('data-nodeid');
      if (id) {
        anchorStepId = id;
        placement = 'after';
        onCanvas = true;
        break;
      }
    }
  }

  return {
    onCanvas,
    anchorStepId,
    placement,
    onOutputHandle,
    onInputHandle,
    ...(outputHandle ? { handleId: outputHandle } : {}),
  };
}

export function resolveInsertAfterStepId(
  steps: readonly { id: string }[],
  target: ModuleDropTarget,
): string | null {
  if (!target.onCanvas || target.placement === 'append' || !target.anchorStepId) {
    return null;
  }
  if (target.placement === 'after') {
    return target.anchorStepId;
  }
  const index = steps.findIndex((step) => step.id === target.anchorStepId);
  if (index <= 0) {
    return null;
  }
  return steps[index - 1]?.id ?? null;
}
