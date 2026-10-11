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
  ConnectionMode,
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
import { type ReactNode, useCallback, useEffect, useMemo } from 'react';

import { EdgeEditor } from '@/features/graph/EdgeEditor';
import { NodeEditor } from '@/features/graph/NodeEditor';

import { GhostButton, PanelShell } from '@/layout/PanelShell';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { toGraphData } from '@/lib/graph-adapter';
import { devLog, graphGet, graphSave } from '@/lib/rpc';
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
      {/* 圆点做大一点（原来 6px，很难抓住），并加一圈描边方便对准 */}
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2.5 !border-2 !border-canvas !bg-idle hover:!bg-brand"
      />
      <div className="text-body">{data.label}</div>
      <div className="text-badge text-faint">
        {data.sub} · {data.visits} 次
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!size-2.5 !border-2 !border-canvas !bg-idle hover:!bg-brand"
      />
    </div>
  );
}

const nodeTypes: NodeTypes = { state: StateNode };

export function GraphPane(): ReactNode {
  const activeId = useDeviceStore((state) => state.activeId);
  const graph = useGraphStore((state) => state.graphs[activeId]);
  const moveNode = useGraphStore((state) => state.moveNode);
  const selectEdge = useGraphStore((state) => state.selectEdge);
  const connectNodes = useGraphStore((state) => state.connectNodes);
  const selectedEdgeId = useGraphStore((state) => state.selectedEdgeId);
  const selectedNodeId = useGraphStore((state) => state.selectedNodeId);
  const selectNode = useGraphStore((state) => state.selectNode);
  const createNode = useGraphStore((state) => state.createNode);

  // 关键：节点数组只在"位置/名字/识别器/激活态"变化时重建。
  // 直接用 [graph] 当依赖的话，每帧的实时分数更新都会造出一批新节点对象，
  // React Flow 是被控模式，拖动过程中会被新 props 按回旧坐标 —— 表现就是"拖不动/不跟手"。
  const nodeSignature = (graph?.nodes ?? [])
    .map((node) => `${node.id}:${node.x},${node.y},${node.name},${node.enter.join('|')}`)
    .join(';')
    .concat(`|${graph?.activeNodeId ?? ''}|${graph?.pendingNodeId ?? ''}`);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 用签名代替 graph 整体：实时分数不该触发重建
    [nodeSignature],
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
  const selectedNode = (graph?.nodes ?? []).find((node) => node.id === selectedNodeId) ?? null;
  // 没有 from 的边在画布上画不出来（React Flow 需要两端），运行时也不会被触发 —— 让它们可见并可清理
  const orphanEdges = (graph?.edges ?? []).filter((edge) => !edge.from);
  const cleanOrphans = useCallback(async () => {
    const raw = useGraphStore.getState().raws[activeId];
    if (!raw) {
      return;
    }
    const kept = (raw.edges ?? []).filter((edge: Record<string, unknown>) => Boolean(edge.from));
    await graphSave(activeId, { ...raw, edges: kept });
    const saved = await graphGet(activeId);
    useGraphStore.getState().setGraph(activeId, toGraphData(activeId, saved, undefined), saved);
  }, [activeId]);

  // 诊断：节点数组只在"真正变化"时重建（每帧重建会导致拖动被 props 抢位置）
  useEffect(() => {
    devLog(`状态图: 重建 ${nodes.length} 个节点（拖不动就是这里刷太频）`);
  }, [nodes]);
  const recoveries = (graph?.edges ?? []).filter((edge) => edge.kind === 'recovery');

  return (
    <PanelShell
      title="状态图"
      actions={
        <>
          <GhostButton
            onClick={() => {
              void createNode(activeId, `界面${(graph?.nodes.length ?? 0) + 1}`).then((nodeId) => {
                if (nodeId) {
                  selectNode(nodeId);
                }
              });
            }}
            title="新建一个空节点（界面），然后给它挂识别器"
          >
            + 节点
          </GhostButton>
          <GhostButton
            onClick={() => {
              // 重新按网格布局（引擎不存坐标，坐标是界面私有的）
              const raw = useGraphStore.getState().raws[activeId];
              if (raw) {
                useGraphStore.getState().setGraph(activeId, toGraphData(activeId, raw, undefined), raw);
              }
            }}
            title="按网格重新排列节点"
          >
            重新布局
          </GhostButton>
        </>
      }
      footer={
        selected ? (
          <EdgeEditor key={selected.id} deviceId={activeId} edge={selected} graph={graph} />
        ) : selectedNode ? (
          <NodeEditor key={selectedNode.id} deviceId={activeId} node={selectedNode} graph={graph} />
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
            onNodeClick={(_event, node) => selectNode(node.id === selectedNodeId ? null : node.id)}
            onConnect={(connection) => {
              if (connection.source && connection.target) {
                void connectNodes(activeId, connection.source, connection.target);
              }
            }}
            onPaneClick={() => {
              selectEdge(null);
              selectNode(null);
            }}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1.2 }}
            minZoom={0.3}
            maxZoom={1.6}
            nodesDraggable
            nodesConnectable
            // 允许从任意一侧的圆点连（Loose）：用户不用记住"左边是入、右边是出"
            connectionMode={ConnectionMode.Loose}
            connectionLineStyle={{ stroke: 'var(--brand, #6ea8fe)', strokeWidth: 2 }}
            proOptions={{ hideAttribution: false }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#262b36" />
          </ReactFlow>
        )}

        {/* 图例 + 孤立步骤清理：第一次打开的人要能知道节点/边是干什么的 */}
        <div className="absolute top-1 left-2 flex max-w-[70%] flex-col items-start gap-0.5 text-badge text-faint">
          <span className="pointer-events-none">
            节点 = 一个界面（由识别器判定）· 边 = 一个动作（条件成立才走）
          </span>
          <span className="pointer-events-none">
            拖节点右侧圆点连到另一个节点 = 连一条边；点节点/边可在下方编辑
          </span>
          {orphanEdges.length > 0 && (
            <button
              type="button"
              onClick={() => void cleanOrphans()}
              className="pointer-events-auto rounded-sm border border-failed/60 px-1 text-failed hover:bg-raised"
              title="这些步骤没有挂在任何界面上：画布上不显示、运行时也不会被触发"
            >
              有 {orphanEdges.length} 个未挂界面的录制步骤 · 点这里清理
            </button>
          )}
        </div>

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
