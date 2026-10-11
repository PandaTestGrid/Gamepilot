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
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

import { EdgeEditor } from '@/features/graph/EdgeEditor';
import { NodeEditor } from '@/features/graph/NodeEditor';
import { ScriptStepsView } from '@/features/graph/ScriptStepsView';

import { GRAPH_LAYOUT, defaultPanelShare } from '@/layout/layout-specs';
import { useLayoutGroup } from '@/layout/useLayoutGroup';
import { GhostButton, PanelShell } from '@/layout/PanelShell';
import { RunButton } from '@/layout/RunButton';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { toGraphData } from '@/lib/graph-adapter';
import { type EdgeStatus, evaluateEdge, markShadowed } from '@/lib/edge-status';
import { edgeLabel } from '@/lib/graph-logic';
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

/** 编辑坞收起时的高度：收到 0 的话分隔线会压在底栏上，鼠标抓不到（实测踩过） */
const EDITOR_COLLAPSED_PX = 28;
/** 编辑坞展开态的最小高度；小于它的尺寸都是"正在往收起过渡"，不记 */
const EDITOR_MIN_PX = 72;

export function GraphPane(): ReactNode {
  // 状态图 / 脚本：同一份数据的两种看法（一个看结构、一个看执行顺序）
  const [view, setView] = useState<'graph' | 'script'>('graph');
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

  /*
   * 拖动过程中的实时坐标。
   *
   * 被控模式（传了 nodes）下 React Flow **不会**自己落位置：内核里
   * `triggerNodeChanges` 只在非受控时才 `applyNodeChanges`，受控时只是回调 `onNodesChange`
   * —— 官方示例都接了 `onNodesChange`（useNodesState 那一套），我们没接，
   * 于是"按住拖动画面不动、松手才跳过去"。
   *
   * 这里接住回调，但只把坐标记在本地：状态图 store 仍是唯一真源，落盘依旧走
   * `onNodeDragStop`（一次写图 + 通知引擎），不会每移动一像素就写一次盘。
   */
  const [dragging, setDragging] = useState<Record<string, XYPosition>>({});
  const onNodesChange = useCallback((changes: NodeChange<StateNodeType>[]) => {
    setDragging((current) => {
      let next = current;
      for (const change of changes) {
        if (change.type !== 'position') {
          continue; // 选中/尺寸之类的变化本项目自有一套（store 里的 selectedNodeId），这里不掺和
        }
        next = { ...(next === current ? current : next) };
        if (change.dragging && change.position) {
          next[change.id] = change.position;
        } else {
          delete next[change.id]; // 松手：交回 store 的坐标（onNodeDragStop 已写进去）
        }
      }
      return next;
    });
  }, []);

  const nodes = useMemo<StateNodeType[]>(
    () =>
      (graph?.nodes ?? []).map((node) => ({
        id: node.id,
        type: 'state' as const,
        position: dragging[node.id] ?? { x: node.x, y: node.y },
        data: {
          label: node.name,
          sub: node.id,
          visits: node.visits,
          active: graph?.activeNodeId === node.id,
          pending: graph?.pendingNodeId === node.id,
        },
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 用签名代替 graph 整体：实时分数不该触发重建
    [nodeSignature, dragging],
  );

  // 每条边"现在走不走得通"：调试脚本时一眼看出卡在哪（纯逻辑在 lib/edge-status.ts）
  const statuses = useMemo(() => {
    if (!graph) {
      return new Map<string, EdgeStatus>();
    }
    const detections = graph.recognizers.map((item) => ({
      label: item.label,
      score: item.score,
      state: item.state,
    }));
    const raw = new Map(
      (graph.edges ?? []).map(
        (edge) => [edge.id, evaluateEdge(edge, detections, graph.activeNodeId)] as const,
      ),
    );
    return markShadowed(graph.edges ?? [], raw);
  }, [graph]);

  const edges = useMemo<Edge[]>(() => {
    const list = graph?.edges ?? [];
    return list
      .filter((edge) => !(edge.from === null || edge.to === null))
      .map((edge) => {
        const recovery = edge.kind === 'recovery';
        // 调试用：运行中按"这条边现在走不走得通"上色（逻辑见 lib/edge-status.ts）
        const status = statuses.get(edge.id);
        const color =
          status?.kind === 'matched'
            ? 'var(--state-confirmed)'
            : status?.kind === 'blocked'
              ? 'var(--state-failed, #ef6b6b)'
              : recovery
                ? 'var(--state-recovery)'
                : 'var(--state-idle, #4b5563)';
        return {
          id: edge.id,
          source: edge.from ?? '',
          target: edge.to ?? '',
          type: 'smoothstep',
          // 标签先显示"这一步做什么"，比只显示识别器标签直观得多
          label: edgeLabel(edge, graph),
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
    // 上色跟着实时状态走，否则运行时边的颜色不会变
  }, [graph, statuses]);

  const onNodeDragStop = useCallback(
    (_event: unknown, node: StateNodeType) => {
      moveNode(activeId, node.id, Math.round(node.position.x), Math.round(node.position.y));
    },
    [activeId, moveNode],
  );

  const selected = (graph?.edges ?? []).find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedNode = (graph?.nodes ?? []).find((node) => node.id === selectedNodeId) ?? null;
  // 画布 / 编辑区 上下可拖；没选中节点或边时编辑区自动收起成提示条，画布回到满高（拖那道横线也能拉开）
  const layout = useLayoutGroup(GRAPH_LAYOUT);
  const editorRef = usePanelRef();
  // 展开态的高度：库只在"命令式收起"时记尺寸，用户手动拖到收起不会记 —— 不自己记的话，
  // 下次选中节点只会展开到 minSize（72px，刚够露出一行）。
  // 记的时机很关键：拖动过程中会经过一堆小尺寸，只在"尺寸稳定下来"时记一笔。
  const editorHeight = useRef(0);
  const heightTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (heightTimer.current !== null) {
        window.clearTimeout(heightTimer.current);
      }
    },
    [],
  );
  const rememberEditorHeight = (pixels: number): void => {
    if (heightTimer.current !== null) {
      window.clearTimeout(heightTimer.current);
      heightTimer.current = null;
    }
    if (pixels < EDITOR_MIN_PX) {
      return; // 收起态 / 正在收起：丢掉待提交值，别把"越收越小"记下来
    }
    heightTimer.current = window.setTimeout(() => {
      editorHeight.current = pixels;
    }, 150);
  };
  // 没记到过高度时（首次启动）用布局记忆 / 默认比例展开
  const editorOpenPercent = Math.min(
    60,
    Math.max(15, layout.defaultLayout?.editor ?? defaultPanelShare(GRAPH_LAYOUT, 'editor')),
  );
  const hasEditor = Boolean(selected || selectedNode);
  useEffect(() => {
    const panel = editorRef.current;
    if (!panel) {
      return;
    }
    if (hasEditor) {
      panel.expand();
      panel.resize(
        editorHeight.current >= EDITOR_MIN_PX ? Math.round(editorHeight.current) : `${editorOpenPercent}%`,
      );
    } else {
      panel.collapse();
    }
  }, [hasEditor, editorRef, editorOpenPercent]);
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
          {/*
            就近的运行/停止：和图是同一件事的两面（图=脚本，运行=让当前设备按它跑）。
            和顶栏那个是**同一个开关**（lib/useRunControl.ts），不是第二份状态；
            图栏被双击弹成独立窗口时，这里就是那个窗口里唯一能跑的地方。
          */}
          <RunButton size="compact" />
          <span className="mx-0.5 h-3 w-px bg-line" />
          <GhostButton
            active={view === 'graph'}
            onClick={() => setView('graph')}
            title="看结构：界面与操作怎么连"
          >
            状态图
          </GhostButton>
          <GhostButton
            active={view === 'script'}
            onClick={() => setView('script')}
            title="看执行顺序：第一步做什么、第二步做什么"
          >
            脚本
          </GhostButton>
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
    >
      <Group
        id={GRAPH_LAYOUT.id}
        orientation="vertical"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        groupRef={layout.groupRef}
        className="h-full"
      >
        <Panel id="canvas" defaultSize="68%" minSize="30%" style={{ overflow: 'hidden' }}>
          <div className="relative h-full bg-canvas">
            {nodes.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-badge text-faint">
                <span>这台设备还没有状态图</span>
                <span>先连接设备，然后在画面栏点「框选」，在画面上拖一个矩形即生成第一个节点</span>
              </div>
            ) : view === 'script' ? (
              <ScriptStepsView graph={graph} />
            ) : (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
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
        </Panel>
        <Separator
          className="h-px bg-line transition-colors hover:bg-brand"
          title="拖动改高度 · 双击恢复默认"
        />
        {/*
          编辑区是一块常驻的"坞"：有选中就展开（回到上次的高度），没选中就收成一条 28px 的提示条。
          以前它是 footer，高度写死且不能拖 —— 识别器一多，条件按钮就会被挤到看不见。
          收起来时**不能收到 0**：那样分隔线会正好压在底栏上边，鼠标点不到，
          想手动拉开反而拉不动（实测踩过），留一条 28px 的提示条既好抓又告诉用户"这里还有个编辑器"。
        */}
        <Panel
          id="editor"
          defaultSize="32%"
          minSize={`${EDITOR_MIN_PX}px`}
          collapsible
          collapsedSize={`${EDITOR_COLLAPSED_PX}px`}
          panelRef={editorRef}
          onResize={(size) => rememberEditorHeight(size.inPixels)}
          style={{ overflow: 'hidden' }}
        >
          <div className="h-full overflow-auto bg-panel">
            {selected ? (
              <EdgeEditor key={selected.id} deviceId={activeId} edge={selected} graph={graph} />
            ) : selectedNode ? (
              <NodeEditor key={selectedNode.id} deviceId={activeId} node={selectedNode} graph={graph} />
            ) : (
              <div
                className="truncate px-2 py-1 text-badge text-faint"
                title="点画布上的节点或边，编辑区在这里展开；拖上面那道横线也能拉开/收起"
              >
                点画布上的节点或边，编辑区在这里展开（拖上面那道横线也能拉开/收起）
              </div>
            )}
          </div>
        </Panel>
      </Group>
    </PanelShell>
  );
}
