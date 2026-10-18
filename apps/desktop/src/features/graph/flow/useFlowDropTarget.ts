import { useContext } from 'react';

import { FlowDropContext } from '@/features/graph/flow/flow-drop-context';

export function useFlowDropTarget(): {
  readonly dropTargetId: string | null;
  readonly setDropTargetId: (id: string | null) => void;
} {
  const value = useContext(FlowDropContext);
  if (!value) {
    throw new Error('useFlowDropTarget 必须在 FlowDropProvider 内使用');
  }
  return value;
}
