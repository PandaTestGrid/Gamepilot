/**
 * 画布右下角的视图控制：`居中` / `−` / 百分比 / `+`。
 *
 * 为什么必须有"居中"：坐标是界面私有的，节点被拖远或引擎回包重排后，
 * 没有参照物时看起来就是"节点消失了"（用户反馈）。小地图给出全局，这个按钮一键回到全部节点。
 *
 * 挂在 `<ReactFlow>` 里（和小地图一样在 Provider 内），用 `useStore` 读缩放，
 * 这样滚轮缩放时百分比也会跟着变。
 */
import { useStore } from '@xyflow/react';
import type { Edge, ReactFlowInstance } from '@xyflow/react';
import type { ReactNode, RefObject } from 'react';

import type { StateNodeType } from '@/features/graph/StateNode';

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.6;

export function ViewportControls({
  flow,
}: {
  flow: RefObject<ReactFlowInstance<StateNodeType, Edge> | null>;
}): ReactNode {
  const zoom = useStore((state) => state.transform[2]);

  const fitAll = (): void => {
    void flow.current?.fitView({ duration: 260, padding: 0.2, maxZoom: 1.2 });
  };

  const nudge = (factor: number): void => {
    const instance = flow.current;
    if (!instance) {
      return;
    }
    const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, instance.getZoom() * factor));
    void instance.zoomTo(target, { duration: 160 });
  };

  return (
    <div className="absolute right-2 bottom-2 z-10 flex items-center gap-0.5 rounded-sm border border-line bg-panel/90 px-0.5 py-0.5">
      <button
        type="button"
        onClick={fitAll}
        title="居中：把所有节点收进视野"
        className="rounded-sm px-1 text-badge text-dim hover:bg-raised hover:text-fg"
      >
        居中
      </button>
      <button
        type="button"
        onClick={() => nudge(1 / 1.2)}
        title="缩小"
        className="rounded-sm px-1 text-badge text-dim hover:bg-raised hover:text-fg"
      >
        −
      </button>
      <button
        type="button"
        onClick={fitAll}
        title="点一下把所有节点收进视野"
        className="min-w-9 rounded-sm px-1 text-badge text-faint hover:bg-raised"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        onClick={() => nudge(1.2)}
        title="放大"
        className="rounded-sm px-1 text-badge text-dim hover:bg-raised hover:text-fg"
      >
        +
      </button>
    </div>
  );
}
