/**
 * 状态图画布（React Flow / xyflow）。
 *
 * 布局阶段目标：让「节点 = 界面、边 = 动作、红色虚线 = recovery 边」一眼可见，
 * 并且拖拽节点/点击边看属性已经能用。真正的编辑（拖出连线、改守卫）在 M5。
 *
 * 视觉：直角、1px 描边、无阴影（DESIGN.md §4.0）；React Flow 的控件一律不启用，
 * 只留 Background 点阵做参考。左下角的 "React Flow" 署名是 MIT 许可要求，保留。
 */
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { type ReactNode, useCallback, useMemo } from 'react';

import { EdgeEditor } from '@/features/graph/EdgeEditor';

import { GhostButton, PanelShell } from '@/layout/PanelShell';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';

interface StateNodeData extends Record<string, unknown> {
  label: string;
  sub: string;
  visits: number;
  active: boolean;
  pending: boolean;
}

type StateNodeType = Node<StateNodeData, 'state'>;

function StateNode({ data }: NodeProps<StateNodeType>): ReactNode {
  return (
    <div
      className={cn(
        'w-[132px] rounded-sm bg-panel px-2 py-1',
        data.active ? 'border border-brand' : 'border border-line',
        data.pending && 'border-dashed',
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-idle" />
      <div className="text-body">{data.label}</div>
      <div className="text-badge text-faint">
        {data.sub} · {data.visits} 次
      </div>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-idle" />
    </div>
  );
}

const nodeTypes: NodeTypes = { state: StateNode };

export function GraphPane(): ReactNode {
  const activeId = useDeviceStore((state) => state.activeId);
  const graph = useGraphStore((state) => state.graphs[activeId]);
  const moveNode = useGraphStore((state) => state.moveNode);
  const selectEdge = useGraphStore((state) => state.selectEdge);
  const selectedEdgeId = useGraphStore((state) => state.selectedEdgeId);

  const nodes = useMemo<StateNodeType[]>(
    () =>
      (graph?.nodes ?? []).map((node) => ({
        id: node.id,
        type: 'state' as const,
        position: { x: node.x, y: node.y },
        data: {
          label: node.name,
          sub: node.id,
          visits: node.visits,
          active: graph?.activeNodeId === node.id,
          pending: graph?.pendingNodeId === node.id,
        },
      })),
    [graph],
  );

  const edges = useMemo<Edge[]>(() => {
    const list = graph?.edges ?? [];
    return list
      .filter((edge) => !(edge.from === null || edge.to === null))
      .map((edge) => {
        const recovery = edge.kind === 'recovery';
        const color = recovery ? 'var(--state-recovery)' : 'var(--state-confirmed)';
        return {
          id: edge.id,
          source: edge.from ?? '',
          target: edge.to ?? '',
          type: 'smoothstep',
          label: `${recovery ? '⚡ ' : ''}${edge.when}`,
          animated: false,
          style: {
            stroke: color,
            strokeWidth: 1,
            strokeDasharray: recovery ? '4 3' : undefined,
          },
          labelStyle: { fill: color, fontSize: 11 },
          labelBgStyle: { fill: 'var(--bg-canvas)' },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        } satisfies Edge;
      });
  }, [graph]);

  const onNodeDragStop = useCallback(
    (_event: unknown, node: StateNodeType) => {
      moveNode(activeId, node.id, Math.round(node.position.x), Math.round(node.position.y));
    },
    [activeId, moveNode],
  );

  const selected = (graph?.edges ?? []).find((edge) => edge.id === selectedEdgeId) ?? null;
  const recoveries = (graph?.edges ?? []).filter((edge) => edge.kind === 'recovery');

  return (
    <PanelShell
      title="状态图"
      actions={
        <>
          <GhostButton>+ 节点</GhostButton>
          <GhostButton>自动布局</GhostButton>
          <GhostButton>验证</GhostButton>
          <GhostButton>JSON</GhostButton>
        </>
      }
      footer={
        selected ? (
          <EdgeEditor key={selected.id} deviceId={activeId} edge={selected} graph={graph} />
        ) : undefined
      }
    >
      <div className="relative h-full bg-canvas">
        {nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-badge text-faint">
            <span>这台设备还没有状态图</span>
            <span>先连接设备，然后在画面栏点「框选」，在画面上拖一个矩形即生成第一个节点</span>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeDragStop={onNodeDragStop}
            onEdgeClick={(_event, edge) => selectEdge(edge.id === selectedEdgeId ? null : edge.id)}
            onPaneClick={() => selectEdge(null)}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1.2 }}
            minZoom={0.3}
            maxZoom={1.6}
            nodesDraggable
            nodesConnectable={false}
            proOptions={{ hideAttribution: false }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#262b36" />
          </ReactFlow>
        )}

        {recoveries.length > 0 && (
          <div className="pointer-events-none absolute right-2 bottom-2 flex flex-col items-end gap-1">
            {recoveries.map((edge) => (
              <span
                key={edge.id}
                className="rounded-sm border border-dashed border-recovery px-1.5 py-0.5 text-badge text-recovery"
              >
                ⚡ {edge.id} · {edge.when} · 全局中断
              </span>
            ))}
          </div>
        )}
      </div>
    </PanelShell>
  );
}
