/**
 * 画布拖模块时的「插入目标」节点（松手插在该步之后）。
 */
import { type ReactNode } from 'react';

import { FlowDropContext, type FlowDropContextValue } from '@/features/graph/flow/flow-drop-context';

export function FlowDropProvider({
  dropTargetId,
  setDropTargetId,
  children,
}: FlowDropContextValue & { children: ReactNode }): ReactNode {
  return (
    <FlowDropContext.Provider value={{ dropTargetId, setDropTargetId }}>{children}</FlowDropContext.Provider>
  );
}
