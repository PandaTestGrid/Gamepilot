/**
 * 步骤链 React Flow 画布（模块顺序 = flow.steps 顺序）。
 * 官方 @xyflow/react + 项目 graph.css；手势与旧状态图一致（见 features/graph/README.md）。
 */
import '@xyflow/react/dist/style.css';

import '@/features/graph/graph.css';

import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  PanOnScrollMode,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  type OnNodeDrag,
  type OnSelectionChangeFunc,
  type ReactFlowInstance,
} from '@xyflow/react';
import type { MenuAnchor } from '@/features/graph/GraphContextMenu';
import { GraphContextMenu } from '@/features/graph/GraphContextMenu';
import {
  flowEdgeContextMenu,
  flowNodeContextMenu,
  flowPaneContextMenu,
  flowSelectionContextMenu,
} from '@/features/graph/flow/flow-context-menu';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FlowDropProvider } from '@/features/graph/flow/FlowDropContext';
import {
  useFlowModulePointerDrag,
  type FlowModulePointerDragContextValue,
} from '@/features/graph/flow/flow-module-pointer-drag';
import { FlowRunStrip } from '@/features/graph/flow/FlowRunStrip';
import { RunDebugBar } from '@/features/graph/flow/RunDebugBar';
import { FlowStepNode } from '@/features/graph/flow/FlowStepNode';
import { mergeDerivedFlowNodes } from '@/features/graph/flow/flow-canvas-sync';
import { resolveModuleDropTarget } from '@/features/graph/flow/flow-drop-target';
import { flowHeadStepId, flowStepTitle } from '@/features/graph/flow/flow-step-meta';
import { isBlockHead } from '@/features/graph/flow/flow-structure';
import { stepsToFlowCanvas, type FlowStepNodeType } from '@/features/graph/flow/flow-layout';
import {
  applyModuleDrop,
  flowConnectionRejectReason,
  isFlowConnectionAllowed,
} from '@/features/graph/flow/flow-mutations';
import {
  useFlowModuleDropRegistration,
  useFlowNoticeAutoDismiss,
} from '@/features/graph/flow/use-flow-editor';
import {
  acceptModuleDrag,
  isModuleDragEvent,
  readModuleDragData,
  setDraggingModule,
} from '@/features/graph/flow/module-drag';
import { lastFailedStepId } from '@/features/graph/flow/flow-console';
import { flowHistoryHotkey } from '@/features/graph/flow/flow-history';
import { useCurrentWorkflowLive, useCurrentWorkflowRunning } from '@/lib/useLiveWorkflow';
import { loadStoredPositions, storeStepPositions } from '@/lib/node-positions';
import { devLog } from '@/lib/rpc';
import { activeDevice, useDeviceStore } from '@/stores/device.store';
import { useEventStore } from '@/stores/event.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import { cn } from '@/lib/utils';
import type { FlowStep, GraphData } from '@/types';

const nodeTypes = { flowStep: FlowStepNode };

const DISCONNECT_NOTICE = '已断开：下游模块变成「未接入」（位置不变），拖到别处即可重新接入';

function selectionKey(ids: readonly string[]): string {
  return [...ids].sort().join('|');
}

function stepsSignature(steps: readonly FlowStep[]): string {
  return steps.map((step) => `${step.id}:${step.type}:${step.disabled ? 1 : 0}`).join('|');
}

function FlowCanvasView({
  graph,
  readOnly = false,
  allowManualConnect = true,
  moduleDrag,
}: {
  graph: GraphData | undefined;
  readOnly?: boolean;
  /** 为 false 时禁止拖线改顺序（只读预览） */
  allowManualConnect?: boolean;
  moduleDrag: FlowModulePointerDragContextValue | null;
}): ReactNode {
  const steps = useMemo(() => graph?.flow?.steps ?? [], [graph?.flow?.steps]);
  const sig = useMemo(() => stepsSignature(steps), [steps]);
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const deviceKind = activeDevice(devices, activeId)?.kind;
  const selectedNodeId = useGraphStore((state) => state.selectedNodeId);
  const selectedNodeIds = useGraphStore((state) => state.selectedNodeIds);
  const focusNodeRequest = useGraphStore((state) => state.focusNodeRequest);
  const selectNode = useGraphStore((state) => state.selectNode);
  const setNodeSelection = useGraphStore((state) => state.setNodeSelection);
  const connectFlowSteps = useGraphStore((state) => state.connectFlowSteps);
  const disconnectFlowEdge = useGraphStore((state) => state.disconnectFlowEdge);
  const appendFlowModule = useGraphStore((state) => state.appendFlowModule);
  const insertFlowModuleAfter = useGraphStore((state) => state.insertFlowModuleAfter);
  const insertFlowModuleBefore = useGraphStore((state) => state.insertFlowModuleBefore);
  const flowNotice = useGraphStore((state) => state.flowNotice);
  const clearFlowNotice = useGraphStore((state) => state.clearFlowNotice);
  const reportFlowNotice = useGraphStore((state) => state.reportFlowNotice);
  const removeFlowSteps = useGraphStore((state) => state.removeFlowSteps);
  const removeFlowStepKeepingGap = useGraphStore((state) => state.removeFlowStepKeepingGap);
  const undoFlow = useGraphStore((state) => state.undoFlow);
  const redoFlow = useGraphStore((state) => state.redoFlow);
  const wrapFlowSelectionInLoop = useGraphStore((state) => state.wrapFlowSelectionInLoop);
  const runningStepId = useGraphStore((state) => state.liveByDevice[activeId]?.node ?? null);
  const sessionRunning = useCurrentWorkflowRunning();
  const live = useCurrentWorkflowLive();
  const lockEdits = readOnly || live;
  const engineEvents = useEventStore((state) => state.events[activeId]);
  const failedStepId = useMemo(() => {
    if (sessionRunning) {
      return null;
    }
    return lastFailedStepId(engineEvents ?? []);
  }, [engineEvents, sessionRunning]);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [moduleDragOver, setModuleDragOver] = useState(false);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const rfRef = useRef<ReactFlowInstance<FlowStepNodeType, Edge> | null>(null);
  const hoverStepId = moduleDrag?.hoverStepId ?? null;
  const isDraggingModule = moduleDrag?.isDraggingModule ?? false;
  const flowRelayoutGeneration = useUiStore((state) => state.flowRelayoutGeneration);
  const lastRelayoutApplied = useRef(flowRelayoutGeneration);
  /** 拖线已成功 onConnect 时，onConnectEnd 不再重复报「连不上」 */
  const connectSucceededRef = useRef(false);

  // sig / flowRelayoutGeneration 不在函数体里用到，但它们变了就必须重新读一遍落盘坐标
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const storedPositions = useMemo(() => loadStoredPositions(), [flowRelayoutGeneration, sig]);

  const flowPositionAt = useCallback((clientX: number, clientY: number) => {
    return rfRef.current?.screenToFlowPosition({ x: clientX, y: clientY }) ?? null;
  }, []);

  const dropDeps = useMemo(
    () => ({ appendFlowModule, insertFlowModuleAfter, insertFlowModuleBefore }),
    [appendFlowModule, insertFlowModuleAfter, insertFlowModuleBefore],
  );

  useFlowModuleDropRegistration(lockEdits, moduleDrag, dropDeps, selectNode, flowPositionAt);
  useFlowNoticeAutoDismiss(flowNotice, clearFlowNotice, lockEdits);

  const canConnect = !lockEdits && allowManualConnect;

  const effectiveDropTargetId = isDraggingModule ? hoverStepId : dropTargetId;
  const showModuleDragOver = isDraggingModule || moduleDragOver;

  const selectedIdSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);

  const flowHeadId = useMemo(() => flowHeadStepId(steps), [steps]);

  const structural = useMemo(
    () => stepsToFlowCanvas(steps, storedPositions, null, null),
    [steps, storedPositions],
  );

  const [rfNodes, setRfNodes] = useNodesState<FlowStepNodeType>(structural.nodes);
  const [rfEdges, setRfEdges] = useEdgesState(structural.edges);
  /** 选中的连线（选中态由 xyflow 写进 edge.selected，经 onEdgesChange 回到 rfEdges） */
  const selectedEdges = useMemo(() => rfEdges.filter((edge) => edge.selected), [rfEdges]);
  const nodesRef = useRef(rfNodes);
  const prevStoredRef = useRef(storedPositions);
  const draggingIdsRef = useRef(new Set<string>());
  /** React Flow 最近一次上报的选中集合（排序后的 key）；null = 还没上报过 */
  const reportedSelectionRef = useRef<string | null>(null);

  useEffect(() => {
    nodesRef.current = rfNodes;
  }, [rfNodes]);

  useEffect(() => {
    if (lockEdits) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = flowHistoryHotkey(event);
      if (!action) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void (action === 'undo' ? undoFlow() : redoFlow());
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lockEdits, undoFlow, redoFlow]);

  useEffect(() => {
    setRfEdges(structural.edges);
  }, [structural.edges, setRfEdges]);

  useEffect(() => {
    if (draggingIdsRef.current.size > 0) {
      return;
    }
    // 落盘坐标变了的节点（插入模块时给后面的让位）要跟着动；其余节点保持 RF 里当前的位置
    const forcePositionIds = new Set<string>();
    const previous = prevStoredRef.current;
    for (const [id, pos] of Object.entries(storedPositions)) {
      const before = previous[id];
      if (!before || before.x !== pos.x || before.y !== pos.y) {
        forcePositionIds.add(id);
      }
    }
    prevStoredRef.current = storedPositions;
    setRfNodes((current) => {
      const resetPositions = lastRelayoutApplied.current !== flowRelayoutGeneration;
      if (resetPositions) {
        lastRelayoutApplied.current = flowRelayoutGeneration;
      }
      return mergeDerivedFlowNodes(current, structural.nodes, { resetPositions, forcePositionIds });
    });
  }, [structural.nodes, storedPositions, sig, flowRelayoutGeneration, setRfNodes]);

  useEffect(() => {
    if (draggingIdsRef.current.size > 0) {
      return;
    }
    // 选中是双向的（store ↔ React Flow 的选中监听）。只有 store 的选中集合和 React Flow 最近一次
    // 上报的不一样（= 别处程序化地改了选中）才往画布写，否则两边各自拿对方的旧值互相覆盖，死循环。
    const syncSelection = selectionKey(selectedNodeIds) !== reportedSelectionRef.current;
    setRfNodes((current) => {
      // 只有真的变了才产生新节点：否则每次都换一批新对象 → React Flow 重新同步 →
      // 选中监听再回写 store → 再来一轮（"Maximum update depth exceeded" 的来源）
      let changed = false;
      const next = current.map((node) => {
        const selected = syncSelection ? selectedIdSet.has(node.id) : Boolean(node.selected);
        const expanded = selectedNodeId === node.id;
        const running = runningStepId === node.id;
        const failed = failedStepId === node.id;
        const title = flowStepTitle(node.data.step);
        if (
          Boolean(node.selected) === selected &&
          node.data.expanded === expanded &&
          node.data.running === running &&
          node.data.failed === failed &&
          node.data.title === title
        ) {
          return node;
        }
        changed = true;
        return { ...node, selected, data: { ...node.data, expanded, running, failed, title } };
      });
      return changed ? next : current;
    });
  }, [selectedNodeId, selectedNodeIds, runningStepId, failedStepId, selectedIdSet, steps, setRfNodes]);

  useEffect(() => {
    if (flowRelayoutGeneration === 0) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      void rfRef.current?.fitView({ padding: 0.14, duration: 220 });
    });
    return () => cancelAnimationFrame(frame);
  }, [flowRelayoutGeneration]);

  useEffect(() => {
    if (!focusNodeRequest || readOnly) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      void rfRef.current?.fitView({
        nodes: [{ id: focusNodeRequest.nodeId }],
        padding: 0.35,
        maxZoom: 1.15,
        duration: 240,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusNodeRequest, readOnly]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowStepNodeType>[]) => {
      // RF 在 props/选中态不同步时会误发 remove；删除只走 onNodesDelete + removeFlowSteps
      const safeChanges = changes.filter((change) => change.type !== 'remove');
      if (safeChanges.length === 0) {
        return;
      }
      setRfNodes((current) => {
        for (const change of safeChanges) {
          if (change.type === 'position' && change.dragging === true) {
            draggingIdsRef.current.add(change.id);
          }
          if (change.type === 'position' && change.dragging === false) {
            draggingIdsRef.current.delete(change.id);
          }
        }
        let next = applyNodeChanges(safeChanges, current);
        for (const change of safeChanges) {
          if (change.type === 'position' && change.dragging !== undefined) {
            next = next.map((node) =>
              node.id === change.id ? { ...node, dragging: change.dragging } : node,
            );
          }
        }
        nodesRef.current = next;
        return next;
      });
    },
    [setRfNodes],
  );

  const onNodeDragStop = useCallback<OnNodeDrag<FlowStepNodeType>>(
    (_event, node) => {
      // 只落盘**刚拖的这个节点**：以前把所有步骤的坐标整体回写，别处节点用的是画布上的
      // 临时坐标（可能是旧网格），一次拖拽就会把用户之前的手工摆位悄悄盖掉。
      const positionsMap = { ...loadStoredPositions() };
      const dragged = nodesRef.current.find((item) => item.id === node.id);
      if (dragged) {
        positionsMap[node.id] = dragged.position;
        storeStepPositions(positionsMap);
      }
      draggingIdsRef.current.clear();
      setRfNodes((current) => current.map((item) => ({ ...item, dragging: false })));
    },
    [setRfNodes],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const safe = changes.filter((change) => change.type !== 'remove');
      if (safe.length === 0) {
        return;
      }
      setRfEdges((current) => applyEdgeChanges(safe, current));
    },
    [setRfEdges],
  );

  /** 断开画布上的一条线：下游就地变「未接入」，不重排、也不会自动接回上游 */
  const disconnectEdge = useCallback(
    async (edge: Edge): Promise<boolean> => {
      const reason = await disconnectFlowEdge(edge.source, edge.target, edge.sourceHandle, edge.targetHandle);
      return reason === null;
    },
    [disconnectFlowEdge],
  );

  const clearEdgeSelection = useCallback(() => {
    setRfEdges((current) => current.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)));
  }, [setRfEdges]);

  const disconnectSelectedEdges = useCallback(() => {
    if (selectedEdges.length === 0) {
      return;
    }
    const targets = selectedEdges;
    clearEdgeSelection();
    void (async () => {
      let failed = 0;
      for (const edge of targets) {
        if (!(await disconnectEdge(edge))) {
          failed += 1;
        }
      }
      if (failed === 0) {
        reportFlowNotice(DISCONNECT_NOTICE);
      }
    })();
  }, [clearEdgeSelection, disconnectEdge, reportFlowNotice, selectedEdges]);

  const visibleEdges = useMemo(
    () =>
      rfEdges.map((edge) => {
        if (!edge.selected) {
          return edge;
        }
        const markerEnd =
          edge.markerEnd && typeof edge.markerEnd === 'object'
            ? { ...edge.markerEnd, color: 'var(--brand)' }
            : edge.markerEnd;
        return {
          ...edge,
          zIndex: 1000,
          markerEnd,
          style: {
            ...edge.style,
            stroke: 'var(--brand)',
            strokeWidth: 3,
          },
        };
      }),
    [rfEdges],
  );

  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selectedNodes }) => {
      const ids = selectedNodes.map((node) => node.id);
      reportedSelectionRef.current = selectionKey(ids);
      setNodeSelection(ids);
    },
    [setNodeSelection],
  );

  const handleModuleDrop = useCallback(
    (event: React.DragEvent) => {
      if (!isModuleDragEvent(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const module = readModuleDragData(event.dataTransfer);
      setDraggingModule(null);
      if (!module) {
        return;
      }
      setDropTargetId(null);
      setModuleDragOver(false);
      const target = resolveModuleDropTarget(event.clientX, event.clientY);
      void applyModuleDrop(target, module, flowPositionAt(event.clientX, event.clientY), dropDeps).then(
        (newId) => {
          if (newId) {
            selectNode(newId);
          }
        },
      );
    },
    [dropDeps, flowPositionAt, selectNode],
  );

  const handleModuleDragOver = useCallback((event: React.DragEvent) => {
    if (!isModuleDragEvent(event)) {
      return;
    }
    acceptModuleDrag(event);
    setModuleDragOver(true);
  }, []);

  const handleModuleDragLeave = useCallback((event: React.DragEvent) => {
    if (event.currentTarget === event.target) {
      setModuleDragOver(false);
      setDropTargetId(null);
    }
  }, []);

  const notifyConnectionReject = useCallback(
    (sourceId: string, targetId: string, sourceHandle?: string | null, targetHandle?: string | null) => {
      const reason = flowConnectionRejectReason(steps, sourceId, targetId, sourceHandle, targetHandle);
      if (!reason) {
        return;
      }
      devLog(`连线被拒绝: ${reason}`);
      reportFlowNotice(reason);
    },
    [reportFlowNotice, steps],
  );

  /** 拖线时就判定能不能连（非法的不会高亮、松手也不生效），和松手后的结构校验同一套规则 */
  const isValidConnection = useCallback(
    (connection: Edge | Connection): boolean => {
      if (!connection.source || !connection.target) {
        return false;
      }
      return isFlowConnectionAllowed(
        steps,
        connection.source,
        connection.target,
        connection.sourceHandle,
        connection.targetHandle ?? 'in',
      );
    },
    [steps],
  );

  const handleConnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (connectSucceededRef.current) {
        connectSucceededRef.current = false;
        return;
      }
      const fromId = state.fromNode?.id;
      const toId = state.toNode?.id;
      if (!fromId || !toId || state.isValid) {
        return;
      }
      notifyConnectionReject(fromId, toId, state.fromHandle?.id ?? null, state.toHandle?.id ?? 'in');
    },
    [notifyConnectionReject],
  );

  const pickModule = useCallback(
    (
      module: Parameters<typeof appendFlowModule>[0],
      afterId?: string,
      position?: { x: number; y: number },
    ) => {
      setMenu(null);
      const task = afterId
        ? insertFlowModuleAfter(afterId, module)
        : appendFlowModule(module, position ? { position } : undefined);
      void task.then((newId) => {
        if (newId) {
          selectNode(newId);
        }
      });
    },
    [appendFlowModule, insertFlowModuleAfter, selectNode],
  );

  const flowPointAt = useCallback((clientX: number, clientY: number) => {
    return rfRef.current?.screenToFlowPosition({ x: clientX, y: clientY }) ?? { x: 0, y: 0 };
  }, []);

  const openSelectionMenu = useCallback(
    (screen: { x: number; y: number }, flow: { x: number; y: number }, ids: readonly string[]) => {
      if (ids.length < 2) {
        return;
      }
      setMenu(
        flowSelectionContextMenu(
          screen,
          flow,
          ids.length,
          () => {
            setMenu(null);
            setNodeSelection(ids);
            void wrapFlowSelectionInLoop();
          },
          () => {
            setMenu(null);
            void removeFlowSteps(ids);
          },
        ),
      );
    },
    [removeFlowSteps, setNodeSelection, wrapFlowSelectionInLoop],
  );

  const openNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: FlowStepNodeType) => {
      event.preventDefault();
      const screen = { x: event.clientX, y: event.clientY };
      const flow = flowPointAt(event.clientX, event.clientY);
      if (selectedNodeIds.length >= 2 && selectedNodeIds.includes(node.id)) {
        openSelectionMenu(screen, flow, selectedNodeIds);
        return;
      }
      const hasBreakpoint = activeId
        ? (useSessionStore.getState().breakpoints[activeId] ?? []).includes(node.id)
        : false;
      setMenu(
        flowNodeContextMenu(
          screen,
          flow,
          node.id,
          node.data.title,
          (module) => pickModule(module, node.id),
          () => {
            selectNode(node.id);
            useUiStore.getState().openFlowConfig();
            setMenu(null);
          },
          deviceKind,
          activeId && activeDevice(devices, activeId)?.status === 'connected'
            ? () => {
                setMenu(null);
                void useSessionStore.getState().startRun(activeId, node.id);
              }
            : undefined,
          !node.data.isTrigger
            ? () => {
                setMenu(null);
                void removeFlowSteps([node.id]);
              }
            : undefined,
          !node.data.isTrigger && !isBlockHead(node.data.step.type)
            ? () => {
                setMenu(null);
                void removeFlowStepKeepingGap(node.id);
              }
            : undefined,
          hasBreakpoint,
          activeId
            ? () => {
                setMenu(null);
                void useSessionStore.getState().setStepBreakpoint(activeId, node.id, !hasBreakpoint);
              }
            : undefined,
        ),
      );
    },
    [
      activeId,
      deviceKind,
      devices,
      flowPointAt,
      openSelectionMenu,
      pickModule,
      removeFlowStepKeepingGap,
      removeFlowSteps,
      selectNode,
      selectedNodeIds,
    ],
  );

  return (
    <FlowDropProvider dropTargetId={effectiveDropTargetId} setDropTargetId={setDropTargetId}>
      <div
        data-testid="flow-canvas"
        className={cn(
          'relative h-full min-w-0 flex-1 bg-canvas',
          showModuleDragOver && 'ring-1 ring-inset ring-brand/40',
        )}
        onDragOverCapture={lockEdits ? undefined : handleModuleDragOver}
        onDragLeaveCapture={lockEdits ? undefined : handleModuleDragLeave}
        onDropCapture={lockEdits ? undefined : handleModuleDrop}
        onContextMenuCapture={
          lockEdits
            ? undefined
            : (event) => {
                // Tauri / WebView2 默认「返回 / 刷新」菜单；必须在捕获阶段拦掉
                event.preventDefault();
              }
        }
      >
        {!readOnly && flowNotice ? (
          <div
            role="status"
            data-testid="flow-notice"
            className="pointer-events-auto absolute left-1/2 top-8 z-20 max-w-[80%] -translate-x-1/2 cursor-pointer rounded-sm border border-line bg-panel px-2 py-1 text-badge text-failed"
            onClick={() => clearFlowNotice(flowNotice.id)}
            title="点击关闭"
          >
            {flowNotice.text}
          </div>
        ) : null}
        {!lockEdits && selectedEdges.length > 0 ? (
          <div
            data-testid="flow-edge-actions"
            className="absolute right-2 top-2 z-20 flex items-center gap-2 rounded-sm border border-line bg-panel px-2 py-1 shadow-sm"
          >
            <span className="text-badge text-dim">已选 {selectedEdges.length} 条连线</span>
            <button
              type="button"
              onClick={disconnectSelectedEdges}
              title="断开选中的连线：下游模块变成「未接入」（位置不变），不会被自动接上"
              className="rounded-sm border border-line px-1.5 py-0.5 text-badge text-fg transition-colors hover:border-failed hover:text-failed"
            >
              断开
            </button>
          </div>
        ) : null}
        {menu && <GraphContextMenu anchor={menu} onClose={() => setMenu(null)} />}
        <ReactFlow
          className="h-full w-full"
          nodes={rfNodes}
          edges={visibleEdges}
          defaultEdgeOptions={{ interactionWidth: 28 }}
          onEdgesChange={lockEdits ? undefined : handleEdgesChange}
          onEdgeContextMenu={
            lockEdits
              ? undefined
              : (event, edge) => {
                  event.preventDefault();
                  setMenu(
                    flowEdgeContextMenu(
                      { x: event.clientX, y: event.clientY },
                      flowPointAt(event.clientX, event.clientY),
                      edge.id,
                      () => {
                        setMenu(null);
                        void disconnectEdge(edge).then((disconnected) => {
                          if (disconnected) {
                            reportFlowNotice(DISCONNECT_NOTICE);
                          }
                        });
                      },
                    ),
                  );
                }
          }
          nodeTypes={nodeTypes}
          nodesDraggable={!lockEdits}
          nodesConnectable={canConnect}
          edgesFocusable={!lockEdits}
          edgesReconnectable={false}
          elementsSelectable={!readOnly}
          onInit={(instance) => {
            rfRef.current = instance;
          }}
          onNodesChange={handleNodesChange}
          onNodeDragStop={lockEdits ? undefined : onNodeDragStop}
          onSelectionChange={readOnly ? undefined : onSelectionChange}
          selectionKeyCode="Shift"
          selectionOnDrag={false}
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode={['Control', 'Meta']}
          // 点一下输出口、再点一下输入口也能连线（xyflow 的 connectOnClick）
          connectOnClick={canConnect}
          isValidConnection={canConnect ? isValidConnection : undefined}
          onConnectEnd={canConnect ? handleConnectEnd : undefined}
          onClickConnectEnd={canConnect ? handleConnectEnd : undefined}
          onConnect={
            canConnect
              ? (connection) => {
                  if (connection.source && connection.target) {
                    connectSucceededRef.current = true;
                    void connectFlowSteps(
                      connection.source,
                      connection.target,
                      connection.sourceHandle,
                      connection.targetHandle ?? 'in',
                    );
                  }
                }
              : undefined
          }
          onNodeClick={
            readOnly
              ? undefined
              : (event, node) => {
                  if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
                    selectNode(node.id);
                    useUiStore.getState().openFlowConfig();
                    setRfNodes((current) =>
                      current.map((item) => ({ ...item, selected: item.id === node.id })),
                    );
                  }
                }
          }
          onNodeDoubleClick={
            readOnly
              ? undefined
              : (_event, node) => {
                  selectNode(node.id);
                  useUiStore.getState().openFlowConfig();
                }
          }
          onPaneClick={
            readOnly
              ? undefined
              : () => {
                  setNodeSelection([]);
                  setRfNodes((current) => current.map((item) => ({ ...item, selected: false })));
                  setDropTargetId(null);
                  setMenu(null);
                }
          }
          onDragOver={(event) => {
            if (isModuleDragEvent(event)) {
              acceptModuleDrag(event);
              setDropTargetId(null);
            }
          }}
          onPaneContextMenu={
            lockEdits
              ? undefined
              : (event) => {
                  event.preventDefault();
                  const screen = { x: event.clientX, y: event.clientY };
                  const flow = flowPointAt(event.clientX, event.clientY);
                  if (selectedNodeIds.length >= 2) {
                    openSelectionMenu(screen, flow, selectedNodeIds);
                    return;
                  }
                  setMenu(
                    flowPaneContextMenu(
                      screen,
                      flow,
                      (module) => pickModule(module, undefined, flow),
                      deviceKind,
                    ),
                  );
                }
          }
          onSelectionContextMenu={
            lockEdits
              ? undefined
              : (event, nodes) => {
                  event.preventDefault();
                  const screen = { x: event.clientX, y: event.clientY };
                  const flow = flowPointAt(event.clientX, event.clientY);
                  const ids = nodes.map((node) => node.id);
                  if (ids.length >= 2) {
                    openSelectionMenu(screen, flow, ids);
                    return;
                  }
                  if (ids.length === 1) {
                    openNodeContextMenu(event, nodes[0] as FlowStepNodeType);
                  }
                }
          }
          onNodeContextMenu={lockEdits ? undefined : (event, node) => openNodeContextMenu(event, node)}
          onBeforeDelete={
            lockEdits
              ? undefined
              : ({ nodes, edges }) =>
                  Promise.resolve({
                    nodes: flowHeadId ? nodes.filter((node) => node.id !== flowHeadId) : nodes,
                    edges,
                  })
          }
          onNodesDelete={
            lockEdits
              ? undefined
              : (nodes) => {
                  void removeFlowSteps(nodes.map((node) => node.id));
                }
          }
          onEdgesDelete={
            lockEdits
              ? undefined
              : (edges) => {
                  for (const edge of edges) {
                    void disconnectFlowEdge(edge.source, edge.target, edge.sourceHandle, edge.targetHandle);
                  }
                }
          }
          connectionMode={ConnectionMode.Strict}
          connectionRadius={24}
          fitView
          minZoom={0.3}
          maxZoom={1.6}
          // 滚轮/双指滑动默认是缩放：很容易一滑就把整张图放得很大，而且缩放过程中
          // 文字会不断重新栅格化（看起来像"闪烁/抖动"）。改成滚动 = 平移；
          // 缩放用双指捏合或按住 ⌘ 再滚。
          zoomOnScroll={false}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Free}
          zoomOnDoubleClick={false}
          // 字段/按钮上已经有 nodrag：在这些控件上滚轮不该平移画布（滚数字输入框时尤其明显）
          noWheelClassName="nodrag"
          deleteKeyCode={lockEdits ? null : ['Delete', 'Backspace']}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#262b36" />
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            style={{
              width: 148,
              height: 104,
              bottom: 8,
              right: 8,
              background: 'var(--bg-panel)',
              border: '1px solid var(--border)',
            }}
            nodeColor="#8b95a7"
          />
          <Controls showInteractive={false} position="bottom-right" style={{ bottom: 8, right: 164 }} />
        </ReactFlow>
        <FlowRunStrip readOnly={readOnly} />
        <RunDebugBar readOnly={readOnly} />
      </div>
    </FlowDropProvider>
  );
}

function FlowCanvasWithModuleDrag(props: {
  graph: GraphData | undefined;
  readOnly?: boolean;
  allowManualConnect?: boolean;
}): ReactNode {
  const moduleDrag = useFlowModulePointerDrag();
  return <FlowCanvasView {...props} moduleDrag={moduleDrag} />;
}

export function FlowCanvas({
  graph,
  readOnly = false,
  allowManualConnect = true,
}: {
  graph: GraphData | undefined;
  readOnly?: boolean;
  allowManualConnect?: boolean;
}): ReactNode {
  if (readOnly) {
    return <FlowCanvasView graph={graph} readOnly allowManualConnect={false} moduleDrag={null} />;
  }
  return <FlowCanvasWithModuleDrag graph={graph} readOnly={false} allowManualConnect={allowManualConnect} />;
}
