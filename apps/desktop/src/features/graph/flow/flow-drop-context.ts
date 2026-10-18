import { createContext } from 'react';

export interface FlowDropContextValue {
  readonly dropTargetId: string | null;
  readonly setDropTargetId: (id: string | null) => void;
}

export const FlowDropContext = createContext<FlowDropContextValue | null>(null);
