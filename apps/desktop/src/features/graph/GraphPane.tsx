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
  type ReactFlowInstance,
  MarkerType,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '@/features/graph/graph.css';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNodesState } from '@xyflow/react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

import { EdgeEditor } from '@/features/graph/EdgeEditor';
import { NodeEditor } from '@/features/graph/NodeEditor';
import { DockBar } from '@/features/graph/DockBar';
import { GraphContextMenu, type MenuAnchor } from '@/features/graph/GraphContextMenu';
import { RunStatusStrip } from '@/features/graph/RunStatusStrip';
import { StateNode, type StateNodeType } from '@/features/graph/StateNode';
import { ScriptStepsView } from '@/features/graph/ScriptStepsView';
import { TaskTabs } from '@/features/graph/TaskTabs';
import { VariablesPanel } from '@/features/graph/VariablesPanel';

import { GRAPH_LAYOUT, defaultPanelShare } from '@/layout/layout-specs';
import { useLayoutGroup } from '@/layout/useLayoutGroup';
import { GhostButton, PanelShell } from '@/layout/PanelShell';
import { RunButton } from '@/layout/RunButton';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import { NODE_SCALES, useUiStore, type NodeScale } from '@/stores/ui.store';
import type { EdgeAction } from '@/types';
import { toGraphData } from '@/lib/graph-adapter';
import { actionPins, summarizePins } from '@/lib/action-pins';
import { type EdgeStatus, evaluateEdge, markShadowed } from '@/lib/edge-status';
import { describeAction, edgeLabel } from '@/lib/graph-logic';
import { devLog, graphGet, graphSave } from '@/lib/rpc';
import { useGraphStore } from '@/stores/graph.store';

const nodeTypes: NodeTypes = { state: StateNode };

/** 编辑坞收起时的高度：收到 0 的话分隔线会压在底栏上，鼠标抓不到（实测踩过） */
const EDITOR_COLLAPSED_PX = 28;
/** 编辑坞展开态的最小高度；小于它的尺寸都是"正在往收起过渡"，不记 */
const EDITOR_MIN_PX = 72;

/** 节点大小档位的中文名（按钮上显示） */
const NODE_SCALE_LABEL: Record<NodeScale, string> = { sm: '小', md: '中', lg: '大' };

export function GraphPane(): ReactNode {
  // 状态图 / 脚本：同一份数据的两种看法（一个看结构、一个看执行顺序）
  const [view, setView] = useState<'graph' | 'script' | 'variables'>('graph');
  const activeId = useDeviceStore((state) => state.activeId);
  const nodeScale = useUiStore((state) => state.nodeScale);
  // 运行中（引擎在跑状态机）：条件边流动、当前节点呼吸、顶部显示当前状态
  const running = useSessionStore((state) => state.running[activeId] === true);
  const setNodeScale = useUiStore((state) => state.setNodeScale);
  /*
   * ReactFlow 实例：右键空白处要"在鼠标位置"建节点，需要 screen → flow 坐标换算。
   * 这里不能用 `useReactFlow()`：GraphPane 本身就是渲染 `<ReactFlow>` 的那个组件，
   * 外层没有 Provider，只能从 onInit 里把实例接过来。
   */
  const flowRef = useRef<ReactFlowInstance<StateNodeType, Edge> | null>(null);
  const graph = useGraphStore((state) => state.graphs[activeId]);
  const refreshGraph = useGraphStore((state) => state.refresh);

  const moveNode = useGraphStore((state) => state.moveNode);
  const selectEdge = useGraphStore((state) => state.selectEdge);
  const connectNodes = useGraphStore((state) => state.connectNodes);
  const removeEdge = useGraphStore((state) => state.removeEdge);
  const selectedEdgeId = useGraphStore((state) => state.selectedEdgeId);
  const selectedNodeId = useGraphStore((state) => state.selectedNodeId);
  const selectNode = useGraphStore((state) => state.selectNode);
  const createNode = useGraphStore((state) => state.createNode);
  const removeNode = useGraphStore((state) => state.removeNode);
  const addBranch = useGraphStore((state) => state.addBranch);

  // 切换设备（或切脚本）时对齐真相源：界面按设备各缓存一份图，另一台可能是旧的，
  // 表现就像"切设备把状态图改了"。graph.json 只有一份，重新拉一次即可。
  useEffect(() => {
    void refreshGraph(activeId);
  }, [activeId, refreshGraph]);

  // 关键：节点数组只在"位置/名字/识别器/激活态"变化时重建。
  // 直接用 [graph] 当依赖的话，每帧的实时分数更新都会造出一批新节点对象，
  // React Flow 是被控模式，拖动过程中会被新 props 按回旧坐标 —— 表现就是"拖不动/不跟手"。
  // 引脚内容也要进签名：改了动作参数或选中项，节点要重建
  const recognizerSignature = (graph?.recognizers ?? [])
    .map((item) => `${item.label}:${item.template ?? ''}:${item.type}`)
    .join(';');
  const templateSignature = recognizerSignature;
  const pinSignature = `${selectedNodeId ?? ''}|${(graph?.edges ?? [])
    .map((edge) => `${edge.id}:${JSON.stringify(edge.actionSpec)}`)
    .join(';')}`;
  /** 有模板截图的识别器（画布上只给这些画缩略图；颜色/OCR 识别器没有图） */
  const templateLabels = useMemo(
    () =>
      new Set(
        (graph?.recognizers ?? [])
          .filter((item) => item.type === 'template' && item.template)
          .map((item) => item.label),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 用签名代替：识别器数组每帧都会换新对象
    [recognizerSignature],
  );

  /** 动作的目标识别器（有模板的话，画布上给这一步配张截图） */
  const actionTargetTemplate = useCallback(
    (action: EdgeAction | undefined): string | undefined => {
      const target = action?.target;
      return target && templateLabels.has(target) ? target : undefined;
    },
    [templateLabels],
  );

  /*
   * 画布上**框选**出来的界面（多选）。
   *
   * 为什么不并进 `selectedNodeId`：那个是"下方编辑器正在编辑哪一个"，永远只有一个；
   * 框选是画布上的临时状态，可以有一串。两者取并集画边框。
   * 也不放进 store：它不该跨设备/跨面板活着（换图就该清掉）。
   */
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);

  // 选中态也算进签名：点节点要给"正在编辑的是哪个"画出边框（点击不会发生在拖拽中，安全）；
  // 框选出来的那一串同理 —— 它变了就要重建节点，否则边框不会跟着亮/灭
  const nodeSignature = (graph?.nodes ?? [])
    .map((node) => `${node.id}:${node.x},${node.y},${node.name},${node.enter.join('|')}`)
    .join(';')
    .concat(
      `|${graph?.activeNodeId ?? ''}|${graph?.pendingNodeId ?? ''}|${selectedNodeId ?? ''}|${selectedIds.join(',')}`,
    );

  /*
   * 节点状态用**官方的 useNodesState**（等价于 `const [nodes, setNodes, onNodesChange]`）。
   *
   * 之前这里是自己维护的 dragging / measured 两张表，问题一堆：
   *   - 受控模式不回填 `dimensions` → React Flow 每次重建节点都会清掉 `measured`
   *     （小地图画不出节点、nodesInitialized 反复 false）；
   *   - 拖动靠自定义 map 兜住，等于把官方状态机拆了一半自己拼。
   * 官方的做法：`useNodesState` 内部用 `applyNodeChanges` 处理**所有**变化
   * （position/dimensions/select…），我们只负责"什么时候把 store 的新数据同步进来"，
   * 而同步时保留本地已有的坐标与尺寸（那是用户拖的、React Flow 量到的）。
   */
  const [rfNodes, setRfNodes, applyNodeChanges] = useNodesState<StateNodeType>([]);
  // 鼠标停在哪条边上：边的线宽是**内联样式**（每条边按状态上色），CSS 的 :hover 盖不住，
  // 所以悬停反馈只能走 React 状态（顺带能在单测里断言）
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  // 右键菜单：空白 / 节点 / 边 三种目标各一套（内容见 openPaneMenu/openNodeMenu/openEdgeMenu）
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

  /**
   * store 的图 → React Flow 节点。
   *
   * 分工（官方模式）：
   *   - **坐标**：不在拖动中的节点以 store 为准（持久真源，`lib/node-positions.ts` 负责不被
   *     引擎回包冲掉）；**正在拖动**的节点（React Flow 会在本地状态上打 `dragging`）以本地为准 ——
   *     拖动期间引擎每帧都在推送实时分数/激活态，一旦同步用 store 的旧坐标覆盖，
   *     画面就是"抖一下、松手回到原位"（真踩过）。松手由 `onNodeDragStop` 写回 store，值相同 → 不跳。
   *   - **尺寸**（`measured`）由 React Flow 量出来、交给我们保管，重建时要带回去，否则又要重新测量。
   *   - `data` 一律重建：激活态/引脚/模板截图都是活的。
   */
  const buildNodes = useCallback(
    (previous: StateNodeType[]): StateNodeType[] => {
      const known = new Map(previous.map((node) => [node.id, node] as const));
      return (graph?.nodes ?? []).map((node) => {
        const local = known.get(node.id);
        return {
          id: node.id,
          type: 'state' as const,
          // 选中态 = "编辑器里那个" ∪ "框选出来的"。必须显式喂给 React Flow：
          // 每次同步（引擎每帧推数据）都会重建节点，不带上选中态的话，框选结果下一次同步就没了
          selected: node.id === selectedNodeId || selectedIds.includes(node.id),
          // 正在拖的节点：位置归 React Flow（本地跟手）；其余以 store 为准（"重新布局"才生效）
          position: local?.dragging === true ? local.position : { x: node.x, y: node.y },
          /*
           * ⚠️ `dragging` 必须一起带回去。
           * 它是 React Flow 打在本地状态上的"正在拖动"标记；重建时丢掉它，
           * 下一次同步就会拿 store 的坐标覆盖正在拖的节点 —— 表现正是"抖一下/像回到原位"（真踩过）。
           * 拖完 React Flow 会把标记清掉，所以这里照抄本地值不会把节点永久锁在拖动态。
           */
          dragging: local?.dragging === true ? true : undefined,
          // 尺寸由 React Flow 量出来并交给我们保管，重建时要带回去（否则又要重新测量）
          measured: local?.measured,
          data: {
            label: node.name,
            sub: node.id,
            deviceId: activeId,
            expanded: node.id === selectedNodeId,
            // 这个界面靠哪些模板认出来（画布上直接显示缩略图："主界面这样"）
            enterTemplates: node.enter.filter((label) => templateLabels.has(label)),
            // 图里所有有截图的模板：节点上就地挂/摘"进入识别器"
            allTemplates: [...templateLabels],
            pins: (graph?.edges ?? [])
              .filter((edge) => edge.from === node.id)
              .map((edge) => ({
                key: edge.id,
                title: describeAction(edge.actionSpec, true),
                action: edge.actionSpec,
                // 这一步点的是哪个模板（有截图就直接画在画布上，不用去翻识别器面板）
                template: actionTargetTemplate(edge.actionSpec),
                pins: summarizePins(actionPins(edge.actionSpec)),
              })),
            visits: node.visits,
            active: graph?.activeNodeId === node.id,
            pending: graph?.pendingNodeId === node.id,
          },
        };
      });
    },
    [graph, activeId, selectedNodeId, selectedIds, templateLabels, actionTargetTemplate],
  );

  // 只有"图的结构/内容/激活态"变了才同步（用签名当依赖，避免每帧重建节点）
  useEffect(() => {
    setRfNodes((previous) => buildNodes(previous));
    // 用签名当依赖：实时分数每帧都在变，直接依赖 graph 会把节点每帧重建一遍
  }, [nodeSignature, pinSignature, templateSignature, buildNodes, setRfNodes]);

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
        // 逐条判断"是不是正在编辑的那条"：以前这里误用了外层那个 selected 对象，
        // 结果是"只要选中了任意一条边，所有边都变粗"
        const selectedEdge = edge.id === selectedEdgeId;
        const hovered = edge.id === hoveredEdge;
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
          selected: selectedEdge,
          source: edge.from ?? '',
          target: edge.to ?? '',
          type: 'smoothstep',
          // 标签先显示"这一步做什么"，比只显示识别器标签直观得多
          label: edgeLabel(edge, graph),
          /*
           * 运行中的"条件边动画"：
           *   - 可以走（matched）→ 流动，一眼看出下一步会走哪条
           *   - 当前界面的出边正在等条件（waiting）→ 也流动，表示"正在盯着这条"
           *   - 被排除条件挡住（blocked）→ 不动（它本来就走不了）
           */
          animated:
            running &&
            (status?.kind === 'matched' || (status?.kind === 'waiting' && edge.from === graph?.activeNodeId)),
          style: {
            stroke: color,
            // 选中（正在编辑）> 悬停（鼠标指到）> 默认，三级粗细
            strokeWidth: selectedEdge ? 2.5 : hovered ? 2 : 1,
            strokeDasharray: recovery ? '4 3' : undefined,
          },
          labelStyle: { fill: color, fontSize: 11 },
          labelBgStyle: { fill: 'var(--bg-canvas)' },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        } satisfies Edge;
      });
    // 上色/流动跟着实时状态走，否则运行时边的颜色与动画不会变；选中态也要跟着（编辑器换了一条边）
  }, [graph, statuses, selectedEdgeId, hoveredEdge, running]);

  /**
   * 把全部节点收进视野（= 右下角「居中」）。
   *
   * 为什么要在"建节点/加分支"之后自动做一次：引擎回包会重排、详情坞展开会让画布变矮，
   * 节点很容易落到可视区外 —— 没有参照物时用户看到的就是"节点消失了"。
   */
  const centerAll = useCallback(() => {
    void flowRef.current?.fitView({ duration: 280, padding: 0.22, maxZoom: 1.2 });
  }, []);

  /** 让底部边编辑器把"动作"区滚进视野（双击边时用）。 */
  const focusEdgeAction = useCallback(() => {
    window.setTimeout(() => {
      document.querySelector('[data-edge-action]')?.scrollIntoView({ block: 'nearest' });
    }, 60);
  }, []);

  /** 空白画布右键：在鼠标处新建界面节点。 */
  const openPaneMenu = useCallback(
    (event: React.MouseEvent | MouseEvent, flow: { x: number; y: number }) => {
      setMenu({
        kind: 'pane',
        flow,
        screen: { x: event.clientX, y: event.clientY },
        title: '空白处',
        items: [
          {
            label: '新建界面节点',
            hint: '在这里',
            onSelect: () => {
              void createNode(activeId, `界面${(graph?.nodes.length ?? 0) + 1}`).then((nodeId) => {
                if (nodeId) {
                  moveNode(activeId, nodeId, Math.round(flow.x), Math.round(flow.y));
                  selectNode(nodeId);
                  // 引擎回包会重排（位置记忆已保）—— 但详情坞展开会让画布变矮，
                  // 所以等布局稳定后再居中一次：**所有**节点都进视野，老节点也不会被挤出画面
                  window.setTimeout(centerAll, 260);
                }
              });
            },
          },
          {
            label: '新建界面节点并挂上第一个模板',
            hint: '省一步',
            onSelect: () => {
              const first = (graph?.recognizers ?? []).find(
                (item) => item.type === 'template' && item.template,
              );
              if (!first) {
                useSessionStore.setState({ error: '还没有模板：先在画面栏「框选」录一个界面元素' });
                return;
              }
              void createNode(activeId, `界面${(graph?.nodes.length ?? 0) + 1}`, [first.label]).then(
                (nodeId) => {
                  if (nodeId) {
                    moveNode(activeId, nodeId, Math.round(flow.x), Math.round(flow.y));
                    selectNode(nodeId);
                  }
                },
              );
            },
          },
        ],
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只用到节点数量与识别器列表，用长度/签名当依赖避免每帧重建
    [activeId, createNode, graph?.nodes.length, recognizerSignature, moveNode, selectNode],
  );

  /** 节点右键：加操作 / 加分支 / 重命名 / 删除（参数编辑仍在下方详情里）。 */
  const openNodeMenu = useCallback(
    (event: React.MouseEvent | MouseEvent, nodeId: string, label: string) => {
      setMenu({
        kind: 'node',
        id: nodeId,
        flow: { x: 0, y: 0 },
        screen: { x: event.clientX, y: event.clientY },
        title: `节点 ${label}`,
        items: [
          {
            label: '加一步操作',
            hint: '原地动作',
            onSelect: () => {
              void connectNodes(activeId, nodeId, nodeId).then(() => {
                const edges = useGraphStore.getState().graphs[activeId]?.edges ?? [];
                const created = edges.filter((edge) => edge.from === nodeId).at(-1);
                if (created) {
                  selectEdge(created.id);
                }
              });
            },
          },
          {
            label: '加分支（出现 → A，不出现 → B）',
            onSelect: () => {
              const other = (graph?.nodes ?? []).find((item) => item.id !== nodeId)?.id;
              const recognizer = (graph?.recognizers ?? [])[0]?.label;
              if (!other || !recognizer) {
                useSessionStore.setState({ error: '加分支需要：至少两个界面 + 一个识别器' });
                return;
              }
              void addBranch(activeId, nodeId, recognizer, other, nodeId);
            },
          },
          {
            label: '重命名（也可以双击节点）',
            onSelect: () => selectNode(nodeId),
          },
          {
            label: '跳到详情面板',
            divider: true,
            onSelect: () => selectNode(nodeId),
          },
          {
            label: '删除这个界面',
            danger: true,
            onSelect: () => {
              void removeNode(activeId, nodeId);
              selectNode(null);
            },
          },
        ],
      });
    },
    [activeId, addBranch, connectNodes, graph?.nodes, graph?.recognizers, removeNode, selectEdge, selectNode],
  );

  /** 边右键：改这一步（滚到动作区）/ 删除这条边。 */
  const openEdgeMenu = useCallback(
    (event: React.MouseEvent | MouseEvent, edgeId: string, label: string) => {
      setMenu({
        kind: 'edge',
        id: edgeId,
        flow: { x: 0, y: 0 },
        screen: { x: event.clientX, y: event.clientY },
        title: `步骤 ${label}`,
        items: [
          {
            label: '改这一步的参数',
            hint: '详情面板',
            onSelect: () => {
              selectEdge(edgeId);
              focusEdgeAction();
            },
          },
          {
            label: '删除这一步',
            danger: true,
            onSelect: () => {
              void removeEdge(activeId, edgeId);
            },
          },
        ],
      });
    },
    [activeId, focusEdgeAction, removeEdge, selectEdge],
  );

  /*
   * 写回坐标时**以本地节点状态为准**，不用回调参数里的 `node.position`。
   *
   * 原因：`onNodeDragStop` 的 `node` 参数可能落后一帧（它来自 React Flow 内部快照），
   * 而 `applyNodeChanges` 维护的本地数组一定是最新的 —— 拿旧值写回 store，
   * 下一次同步就会把节点按回起始位置，表现就是"停下来抖一下、像回到原位"。
   * 这里用 ref 镜像本地数组（事件回调里读 ref 是安全的，渲染期不读）。
   */
  const nodesRef = useRef<StateNodeType[]>([]);
  useEffect(() => {
    nodesRef.current = rfNodes;
  }, [rfNodes]);

  const persistPositions = useCallback(
    (ids: readonly string[]) => {
      const current = new Map(nodesRef.current.map((node) => [node.id, node.position] as const));
      for (const id of ids) {
        const position = current.get(id);
        if (position) {
          moveNode(activeId, id, Math.round(position.x), Math.round(position.y));
        }
      }
    },
    [activeId, moveNode],
  );

  /**
   * 拖动中把坐标**节流**写回 store。
   *
   * 只在松手时写的话，松手那一瞬间只要有一次重建（实时推送/选中变化），
   * 节点就会被 store 里的旧坐标按回去 —— 抖动就是这么来的。节流 90ms 兜底即可，
   * 画面跟手仍然完全由 React Flow 本地负责。
   */
  const lastDragWrite = useRef(0);
  const onNodeDrag = useCallback(
    (_event: unknown, node: StateNodeType) => {
      const now = performance.now();
      if (now - lastDragWrite.current < 90) {
        return;
      }
      lastDragWrite.current = now;
      persistPositions([node.id]);
    },
    [persistPositions],
  );

  /** 松手：React Flow 会把这次一起移动的节点都报上来（多选拖动），一个都不能漏 */
  const onNodeDragStop = useCallback(
    (_event: unknown, node: StateNodeType, nodes?: StateNodeType[]) => {
      const moved = nodes && nodes.length > 0 ? nodes : [node];
      persistPositions(moved.map((item) => item.id));
      lastDragWrite.current = 0;
    },
    [persistPositions],
  );

  /** 选中集合变了（框选 / 点节点 / shift 加选 / 点空白清空）——React Flow 是"真源"，这里只镜像一份给删除按钮用 */
  const onSelectionChange = useCallback((params: { nodes: Array<{ id: string }> }): void => {
    const ids = params.nodes.map((node) => node.id);
    setSelectedIds((current) =>
      current.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids,
    );
  }, []);

  /**
   * 删除一组界面（Delete 键 / 框选后的「删除选中」都走这里）。
   *
   * - **逐个删**：引擎每个节点一次 `graph.node.remove`（它会把连着的边一并删掉，见
   *   `session.py: graph_node_remove`），所以这里不用自己先删边；
   * - 先清选中态再发请求：否则删到一半时被删的节点还亮着边框，看着像卡住；
   * - 正在下方编辑的那个被删了 → 收起编辑器（否则面板里编辑的是一个不存在的界面）。
   */
  const deleteSelection = useCallback(
    async (ids: readonly string[]): Promise<void> => {
      if (ids.length === 0) {
        return;
      }
      devLog(`删除界面：${ids.join('、')}（${ids.length} 个）`);
      setSelectedIds([]);
      if (selectedNodeId && ids.includes(selectedNodeId)) {
        selectNode(null);
      }
      for (const id of ids) {
        try {
          await removeNode(activeId, id);
        } catch (error) {
          devLog(`删不掉 ${id}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    [activeId, removeNode, selectNode, selectedNodeId],
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
    devLog(`状态图: 重建 ${rfNodes.length} 个节点（拖不动就是这里刷太频）`);
  }, [rfNodes]);
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
          <TaskTabs />
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
              // 重新按网格布局（引擎不存坐标，坐标是界面私有的）—— 这里要**丢弃**摆位记忆
              const raw = useGraphStore.getState().raws[activeId];
              if (raw) {
                useGraphStore
                  .getState()
                  .setGraph(activeId, toGraphData(activeId, raw, undefined), raw, { resetPositions: true });
              }
            }}
            title="按网格重新排列节点"
          >
            重新布局
          </GhostButton>
          {/* 节点卡片大小：小/中/大（卡片、字号、缩略图一起缩放），选择记在 ui store 里 */}
          <GhostButton
            onClick={() => {
              const next = NODE_SCALES[(NODE_SCALES.indexOf(nodeScale) + 1) % NODE_SCALES.length];
              setNodeScale(next ?? 'md');
            }}
            title="节点卡片大小（小 / 中 / 大）—— 放大后卡片里的模板缩略图也能看清"
          >
            节点 {NODE_SCALE_LABEL[nodeScale]}
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
            {rfNodes.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-badge text-faint">
                <span>这台设备还没有状态图</span>
                <span>先连接设备，然后在画面栏点「框选」，在画面上拖一个矩形即生成第一个节点</span>
              </div>
            ) : view === 'script' ? (
              <ScriptStepsView graph={graph} />
            ) : view === 'variables' ? (
              <VariablesPanel deviceId={activeId} graph={graph} />
            ) : (
              <ReactFlow
                nodes={rfNodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={applyNodeChanges}
                onNodeDrag={onNodeDrag}
                onNodeDragStop={onNodeDragStop}
                // 点边 = 选中（幂等）：以前是 toggle，点到已选中的边会顺手关掉编辑器
                onEdgeClick={(_event, edge) => selectEdge(edge.id)}
                onEdgeMouseEnter={(_event, edge) => setHoveredEdge(edge.id)}
                onEdgeMouseLeave={() => setHoveredEdge(null)}
                // 双击边 = 直接进编辑（底部面板会聚焦到动作区）
                onEdgeDoubleClick={(_event, edge) => {
                  selectEdge(edge.id);
                  focusEdgeAction();
                }}
                /*
                 * 点节点 = 选中（**幂等**，不再 toggle）。
                 * 以前点已展开的节点会"取消选中 → 收起"，而节点内部的空白/文字/改名输入框
                 * 点一下也会冒泡到这里 —— 用户反馈"点节点里的东西也会收起"就是这个。
                 * 收起统一由画布空白（onPaneClick）负责。
                 */
                onNodeClick={(_event, node) => selectNode(node.id)}
                onConnect={(connection) => {
                  if (connection.source && connection.target) {
                    void connectNodes(activeId, connection.source, connection.target);
                  }
                }}
                onPaneContextMenu={(event) => {
                  const mouse = event;
                  const flow = flowRef.current?.screenToFlowPosition({
                    x: mouse.clientX,
                    y: mouse.clientY,
                  }) ?? { x: 0, y: 0 };
                  openPaneMenu(mouse, flow);
                }}
                onNodeContextMenu={(event, node) => {
                  selectNode(node.id);
                  openNodeMenu(event, node.id, node.data.label || node.id);
                }}
                onEdgeContextMenu={(event, edge) => {
                  selectEdge(edge.id);
                  openEdgeMenu(event, edge.id, typeof edge.label === 'string' ? edge.label : edge.id);
                }}
                /*
                 * 点画布空白 = 收起。
                 *
                 * ⚠️ xyflow 的 pane click 是挂在 `.react-flow__pane` 上的，而节点就在它里面 ——
                 * 点节点/边时这个回调**也会被触发**（冒泡）。不排掉的话：点节点会"先选中、再被清空"，
                 * 点节点里的操作更是直接收起（用户反馈的两次"收起"都是这个）。
                 */
                onPaneClick={(event) => {
                  const target = event.target as HTMLElement | null;
                  if (target?.closest('.react-flow__node') || target?.closest('.react-flow__edge')) {
                    return; // 点在节点/边里面：不是"点空白"
                  }
                  selectEdge(null);
                  selectNode(null);
                }}
                onInit={(instance) => {
                  flowRef.current = instance;
                }}
                /*
                 * 画布手势（用户反馈"鼠标一放上去就是小手，而且没法框选多个"）：
                 *   - `selectionOnDrag`：**左键拖空白 = 框选**多个界面；
                 *   - `panOnDrag={[1]}`：平移给**中键**（外加 xyflow 默认的"空格+拖动"）。
                 *     `[1]` 是 DOM 的 `MouseEvent.button`：**1 = 中键、2 = 右键**。
                 *     **不能用右键平移**：xyflow 的实现里，只要 panOnDrag 含 2，
                 *     它就把 `contextmenu` 事件 preventDefault 掉并 return —— 右键菜单会被整个吞掉；
                 *   - `panOnScroll` + `zoomOnScroll={false}`：**滚动/双指滑动 = 平移**，
                 *     ⌘+滚动 = 缩放（Mac 上 zoomActivationKeyCode 默认就是 Meta），捏合仍然缩放。
                 *     Mac 触控板没有中键，原来"滚动=缩放"意味着不按空格就没法平移。
                 */
                selectionOnDrag
                panOnDrag={[1]}
                panOnScroll
                zoomOnScroll={false}
                multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
                // Delete 和 Backspace 都能删（macOS 键盘上 Delete 是 Fn+Backspace，不给 Backspace 就没人删得动）
                deleteKeyCode={['Delete', 'Backspace']}
                onSelectionChange={onSelectionChange}
                /* Delete 键删：xyflow 先从自己的状态里摘掉再回调 → 这里同步到引擎（真源在 graph.json） */
                onNodesDelete={(nodes) => void deleteSelection(nodes.map((node) => node.id))}
                onEdgesDelete={(edges) => {
                  for (const edge of edges) {
                    void removeEdge(activeId, edge.id);
                  }
                }}
                fitView
                fitViewOptions={{ padding: 0.25, maxZoom: 1.2 }}
                minZoom={0.3}
                maxZoom={1.6}
                nodesDraggable
                nodesConnectable
                // 允许从任意一侧的圆点连（Loose）：用户不用记住"左边是入、右边是出"
                // 用官方的严格模式：右圆点(出) → 左圆点(入)。Loose 模式下从**左**（target）
                // 圆点拖出去也允许连线，得到的是反向边（用户反馈"选左侧却连到右侧"）
                connectionMode={ConnectionMode.Strict}
                connectionLineStyle={{ stroke: 'var(--brand, #6ea8fe)', strokeWidth: 2 }}
                proOptions={{ hideAttribution: false }}
              >
                <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#262b36" />
                {/*
                  小地图：节点一多（或拖远了）没有它就"找不到自己在哪"，
                  用户反馈"节点会消失"有一半是节点跑到视野外却没有参照物。
                */}
                <MiniMap
                  pannable
                  zoomable
                  position="bottom-right"
                  style={{
                    width: 148,
                    height: 104,
                    // 官方控件放在小地图左边（两个都在右下角会叠在一起）
                    bottom: 8,
                    right: 8,
                    background: 'var(--bg-panel)',
                    border: '1px solid var(--border)',
                  }}
                  maskColor="rgba(10,12,16,0.55)"
                  // 节点颜色要能看清：原来用面板灰，和底色几乎一样，小地图等于白给
                  nodeColor={(node) =>
                    (node.data as { active?: boolean } | undefined)?.active ? '#4da3ff' : '#8b95a7'
                  }
                  nodeStrokeColor="#1a1d24"
                  nodeStrokeWidth={1}
                  nodeBorderRadius={2}
                />
                {/* 官方控件：缩放 / 适配视图（fitView）/ 锁定，比自己画一套稳 */}
                <Controls
                  showInteractive={false}
                  position="bottom-right"
                  style={{ bottom: 8, right: 164 }} // 挨着小地图左侧
                />
              </ReactFlow>
            )}

            {/* 图例 + 孤立步骤清理：第一次打开的人要能知道节点/边是干什么的 */}
            <div className="pointer-events-none absolute bottom-2 left-2 flex max-w-[70%] flex-col items-start gap-0.5 rounded-sm bg-panel/85 px-1 text-badge text-faint">
              <span className="pointer-events-none">
                节点 = 一个界面（由识别器判定）· 边 = 一个动作（条件成立才走）
              </span>
              <span className="pointer-events-none">
                拖节点右侧圆点连到另一个节点 = 连一条边；点节点/边可在下方编辑
              </span>
              <span className="pointer-events-none">拖动空白 = 框选多个界面（Delete 删除选中）</span>
              <span className="pointer-events-none">
                滚动 / 双指滑动 = 平移画布，⌘+滚动 = 缩放（空格或中键拖动也能平移）
              </span>
              {selectedIds.length > 0 && (
                <span className="pointer-events-auto flex items-center gap-1 rounded-sm border border-brand bg-panel px-1 text-brand">
                  <span data-testid="selection-count">已选 {selectedIds.length} 个界面</span>
                  <button
                    type="button"
                    data-testid="delete-selection"
                    onClick={() => void deleteSelection(selectedIds)}
                    title="删除选中的界面（连在它们身上的边会一起删）"
                    className="rounded-sm border border-failed/60 px-1 text-failed hover:bg-raised"
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedIds([]);
                      selectNode(null);
                    }}
                    title="取消选择（也可以点一下画布空白）"
                    className="rounded-sm px-1 text-dim hover:bg-raised hover:text-fg"
                  >
                    取消选择
                  </button>
                </span>
              )}
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

            {menu && <GraphContextMenu anchor={menu} onClose={() => setMenu(null)} />}

            {/* 运行状态条：现在停在哪 / 下一步走哪条 / 还差什么 */}
            <RunStatusStrip graph={graph} statuses={statuses} running={running} />

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
          <div className="flex h-full flex-col bg-panel">
            {/* 显式 展开/收起 + 当前在编辑什么（收起时也看得见） */}
            <DockBar
              panelRef={editorRef}
              title={
                selected
                  ? `这一步操作 · ${selected.from ?? '?'} → ${selected.to ?? '原地'}`
                  : selectedNode
                    ? `界面 · ${selectedNode.name}`
                    : '详情'
              }
              subtitle={
                selected
                  ? selected.action
                  : selectedNode
                    ? `${selectedNode.enter.length} 个进入识别器`
                    : '未选中任何节点/边'
              }
            />
            <div className="min-h-0 flex-1 overflow-auto">
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
          </div>
        </Panel>
      </Group>
    </PanelShell>
  );
}
