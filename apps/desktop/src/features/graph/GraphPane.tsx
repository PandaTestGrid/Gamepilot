/**
 * 工作流画布：唯一真源 `graph.json` → `flow.steps`（Automa 式步骤链）。
 * 识别器仍在 graph.recognizers；不再编辑 nodes/edges 状态图。
 */
import { Component, Fragment, type ReactNode, useEffect, useRef } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

import { DockBar } from '@/features/graph/DockBar';
import { FlowStepConsole } from '@/features/graph/flow/FlowStepConsole';
import { FlowStepEditor } from '@/features/graph/flow/FlowStepEditor';
import { flowStepTitle } from '@/features/graph/flow/flow-step-meta';
import { WorkflowWorkspace } from '@/features/graph/flow/WorkflowWorkspace';
import { GraphStartPage } from '@/features/graph/GraphStartPage';
import { GraphTabs } from '@/features/graph/GraphTabs';
import { GraphToolbar } from '@/features/graph/GraphToolbar';
import { GRAPH_LAYOUT } from '@/layout/layout-specs';
import { useLayoutGroup } from '@/layout/useLayoutGroup';
import { PanelShell } from '@/layout/PanelShell';
import { devLog } from '@/lib/rpc';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { useLibraryStore } from '@/stores/library.store';
import { workflowRootKey } from '@/stores/ui.store';
import { graphForDevice, rawFor, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

const EDITOR_COLLAPSED_PX = 28;
const EDITOR_MIN_PX = 72;
/** 点节点展开时的默认高度；大窗口按百分比会占掉太多画布 */
const EDITOR_DEFAULT_OPEN_PX = 168;
type DockTab = 'config' | 'console';

const DOCK_TABS: ReadonlyArray<{ id: DockTab; label: string }> = [
  { id: 'config', label: '配置' },
  { id: 'console', label: '控制台' },
];

class CanvasBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { failed: boolean; message: string; generation: number }
> {
  override state = { failed: false, message: '', generation: 0 };

  static getDerivedStateFromError(error: unknown): { failed: boolean; message: string } {
    return { failed: true, message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    const stack = error instanceof Error ? (error.stack ?? '').split('\n').slice(0, 4).join(' | ') : '';
    const where = (info.componentStack ?? '').trim().split('\n').slice(0, 3).join(' < ');
    devLog(`画布出错（已隔离，可重建）: ${String(error)} ${stack} @ ${where}`);
  }

  override componentDidUpdate(previous: { resetKey: string }): void {
    // 换了工作流：旧图造成的错误不该留着
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState((state) => ({ failed: false, message: '', generation: state.generation + 1 }));
    }
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-badge text-faint">
          <span>画布渲染出错了（已隔离，其它面板不受影响）</span>
          {this.state.message ? (
            <span className="max-w-full truncate text-[10px]" title={this.state.message}>
              {this.state.message}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => {
              this.setState((state) => ({ failed: false, message: '', generation: state.generation + 1 }));
            }}
            className="rounded-sm border border-line px-2 py-0.5 text-dim hover:bg-raised hover:text-fg"
          >
            重建画布
          </button>
        </div>
      );
    }
    return <Fragment key={this.state.generation}>{this.props.children}</Fragment>;
  }
}
export function GraphPane(): ReactNode {
  const activeId = useDeviceStore((state) => state.activeId);
  const openWorkflowTabs = useUiStore((state) => state.openWorkflowTabs);
  const openWorkflowTab = useUiStore((state) => state.openWorkflowTab);
  const workflowItems = useLibraryStore((state) => state.workflows);
  const workflowRoot = useSessionStore((state) => state.currentWorkflow?.root ?? '');
  const graph = useGraphStore((state) => graphForDevice(state, activeId));
  const workflowNote = useGraphStore((state) => {
    const note = rawFor(state, activeId)?.defaults?.workflow_note;
    return typeof note === 'string' && note.trim() ? note.trim() : '';
  });
  const refreshGraph = useGraphStore((state) => state.refresh);
  const selectedNodeId = useGraphStore((state) => state.selectedNodeId);
  const selectedNodeIds = useGraphStore((state) => state.selectedNodeIds);
  const hasKnownWorkflow =
    Boolean(workflowRoot) &&
    workflowItems.some((item) => workflowRootKey(item.root) === workflowRootKey(workflowRoot));

  useEffect(() => {
    if (!workflowRoot) {
      return;
    }
    void refreshGraph();
  }, [workflowRoot, refreshGraph]);

  const startPageOpen = useUiStore((state) => state.startPageOpen);
  const lastAutoOpenedRoot = useRef('');
  useEffect(() => {
    // 开始页开着时不要替用户开图（否则恢复出来的那张会立刻把开始页顶掉）
    if (!workflowRoot || !hasKnownWorkflow || startPageOpen) {
      lastAutoOpenedRoot.current = '';
      return;
    }
    if (lastAutoOpenedRoot.current !== workflowRoot) {
      openWorkflowTab(workflowRoot);
      lastAutoOpenedRoot.current = workflowRoot;
    }
  }, [workflowRoot, hasKnownWorkflow, openWorkflowTab, startPageOpen]);

  /** 开始页点一条 → 开始页收起（真实入口在 `GraphStartPage` 的 `onOpen`）。 */
  const openFromStartPage = (root: string): void => {
    if (!root) {
      return;
    }
    useUiStore.getState().hideStartPage();
    void useSessionStore.getState().switchWorkflow(root);
  };

  const selectedFlowStep = (graph?.flow?.steps ?? []).find((step) => step.id === selectedNodeId) ?? null;

  const layout = useLayoutGroup(GRAPH_LAYOUT);
  const editorRef = usePanelRef();
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
      return;
    }
    heightTimer.current = window.setTimeout(() => {
      editorHeight.current = pixels;
    }, 150);
  };
  const hasEditor = Boolean(selectedFlowStep);
  const selectedStepId = selectedFlowStep?.id ?? null;
  const flowDockOpen = useUiStore((state) => state.flowDockOpen);
  const setFlowDockOpen = useUiStore((state) => state.setFlowDockOpen);
  const dockTab = useUiStore((state) => state.flowDockTab);
  const setDockTab = useUiStore((state) => state.setFlowDockTab);
  const focusNodeRequest = useGraphStore((state) => state.focusNodeRequest);
  const runningHere = useSessionStore((state) => Boolean(state.running[activeId]));

  // 从素材区等外部入口点击跳转模块时，切回「模块详情」Tab 并展开下方抽屉
  useEffect(() => {
    if (!focusNodeRequest) {
      return;
    }
    setDockTab('config');
    setFlowDockOpen(true);
    editorRef.current?.expand();
  }, [focusNodeRequest, editorRef, setDockTab, setFlowDockOpen]);

  // 开始运行时自动切到控制台看日志
  const wasRunning = useRef(false);
  useEffect(() => {
    if (runningHere && !wasRunning.current) {
      setDockTab('console');
      setFlowDockOpen(true);
      editorRef.current?.expand();
    }
    wasRunning.current = runningHere;
  }, [runningHere, editorRef, setDockTab, setFlowDockOpen]);

  // 选中节点变化时自动切换到「配置」并展开抽屉；取消选中且当前在配置页时自动收起
  const prevSelectedStepId = useRef<string | null>(selectedStepId);
  useEffect(() => {
    if (selectedStepId && selectedStepId !== prevSelectedStepId.current) {
      setDockTab('config');
      setFlowDockOpen(true);
    } else if (!selectedStepId && prevSelectedStepId.current && dockTab === 'config') {
      setFlowDockOpen(false);
    }
    prevSelectedStepId.current = selectedStepId;
  }, [selectedStepId, dockTab, setDockTab, setFlowDockOpen]);

  // 同步 ui.store.flowDockOpen 到下方控制台/配置抽屉 Panel
  useEffect(() => {
    const panel = editorRef.current;
    if (!panel) {
      return;
    }
    if (flowDockOpen) {
      if (!hasEditor && dockTab === 'config') {
        setDockTab('console');
      }
      if (panel.isCollapsed()) {
        panel.expand();
        panel.resize(
          editorHeight.current >= EDITOR_MIN_PX ? Math.round(editorHeight.current) : EDITOR_DEFAULT_OPEN_PX,
        );
      }
    } else if (!panel.isCollapsed()) {
      panel.collapse();
    }
  }, [flowDockOpen, hasEditor, dockTab, editorRef, setDockTab]);

  const tabsOpen = openWorkflowTabs.length > 0;
  return (
    <PanelShell
      title="工作流"
      tabs={startPageOpen || !tabsOpen ? undefined : <GraphTabs />}
      actions={
        <div className="flex min-w-0 shrink-0 items-center gap-1">
          {workflowNote ? (
            <span className="max-w-[8rem] truncate text-badge text-faint" title={workflowNote}>
              {workflowNote}
            </span>
          ) : null}
          <GraphToolbar />
        </div>
      }
    >
      <Group
        id={GRAPH_LAYOUT.id}
        orientation="vertical"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        groupRef={layout.groupRef}
        className="h-full min-h-0"
      >
        <Panel id="canvas" defaultSize="80%" minSize="30%" style={{ overflow: 'hidden' }}>
          {/* 全局配置固定贴在画布右侧（控制台上方那一格），不占画布宽度以外的行 */}
          <div className="flex h-full min-h-0 w-full">
            <div className="min-w-0 flex-1">
              <CanvasBoundary resetKey={workflowRoot}>
                <div data-testid="flow-canvas-wrap" className="h-full min-h-0">
                  <WorkflowWorkspace
                    tabsOpen={startPageOpen ? false : tabsOpen}
                    workflowRoot={workflowRoot}
                    emptyOverlay={<GraphStartPage onOpen={openFromStartPage} />}
                  />
                </div>
              </CanvasBoundary>
            </div>
          </div>
        </Panel>
        <Separator className="h-px bg-line transition-colors hover:bg-brand" title="拖动改高度" />
        <Panel
          id="editor"
          defaultSize="20%"
          minSize={`${EDITOR_MIN_PX}px`}
          collapsible
          collapsedSize={`${EDITOR_COLLAPSED_PX}px`}
          panelRef={editorRef}
          onResize={(size) => {
            rememberEditorHeight(size.inPixels);
            const open = size.inPixels > EDITOR_COLLAPSED_PX + 4;
            if (useUiStore.getState().flowDockOpen !== open) {
              setFlowDockOpen(open);
            }
          }}
          style={{ overflow: 'hidden' }}
        >
          <div className="flex h-full flex-col bg-panel">
            <DockBar
              panelRef={editorRef}
              onToggle={(next) => setFlowDockOpen(next)}
              tabs={
                <div role="tablist" className="flex h-full items-stretch">
                  {DOCK_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={dockTab === tab.id}
                      data-testid={`dock-tab-${tab.id}`}
                      onClick={() => {
                        setDockTab(tab.id);
                        setFlowDockOpen(true);
                        editorRef.current?.expand();
                      }}
                      className={cn(
                        'shrink-0 whitespace-nowrap border-b-2 px-2 text-badge',
                        dockTab === tab.id
                          ? 'border-brand text-fg'
                          : 'border-transparent text-dim hover:text-fg',
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              }
              title={selectedFlowStep ? `模块 · ${flowStepTitle(selectedFlowStep)}` : '详情'}
              subtitle={
                selectedNodeIds.length > 1
                  ? `已选 ${selectedNodeIds.length} 个模块（详情显示当前焦点）`
                  : selectedFlowStep
                    ? selectedFlowStep.id
                    : '拖模块 · 双击模块打开详情'
              }
            />
            <div className="min-h-0 flex-1 overflow-auto">
              {dockTab === 'console' ? (
                <FlowStepConsole
                  steps={graph?.flow?.steps ?? []}
                  selectedStepId={selectedFlowStep?.id ?? null}
                />
              ) : selectedFlowStep ? (
                <FlowStepEditor key={selectedFlowStep.id} step={selectedFlowStep} graph={graph} />
              ) : (
                <div className="truncate px-2 py-1 text-badge text-faint">点画布上的模块，在这里改参数</div>
              )}
            </div>
          </div>
        </Panel>
      </Group>
    </PanelShell>
  );
}
