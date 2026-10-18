/**
 * 工作流画布：唯一真源 `graph.json` → `flow.steps`（Automa 式步骤链）。
 * 识别器仍在 graph.recognizers；不再编辑 nodes/edges 状态图。
 */
import { MousePointerSquareDashed, ScanLine, ScanText, Video } from 'lucide-react';
import { Component, Fragment, type ReactNode, useEffect, useRef } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

import { DockBar } from '@/features/graph/DockBar';
import { FlowStepConsole } from '@/features/graph/flow/FlowStepConsole';
import { FlowStepEditor } from '@/features/graph/flow/FlowStepEditor';
import { flowStepTitle } from '@/features/graph/flow/flow-step-meta';
import { WorkflowWorkspace } from '@/features/graph/flow/WorkflowWorkspace';
import { GraphTabs } from '@/features/graph/GraphTabs';
import { GraphToolbar } from '@/features/graph/GraphToolbar';
import { taskName } from '@/features/graph/task-name';
import { GRAPH_LAYOUT } from '@/layout/layout-specs';
import { FLOW_EDIT_LOCKED_HINT } from '@/lib/flow-edit-lock';
import { useCurrentWorkflowLive } from '@/lib/useLiveWorkflow';
import { useLayoutGroup } from '@/layout/useLayoutGroup';
import { PanelShell } from '@/layout/PanelShell';
import { devLog } from '@/lib/rpc';
import { cn } from '@/lib/utils';
import { activeDevice, useDeviceStore } from '@/stores/device.store';
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
/**
 * 详情坞左侧（配置 Tab 前面）的录制图标按钮：
 * - 框选录制（MousePointerSquareDashed）→ 图像模板
 * - 点选录制（ScanLine）→ 图像模板
 * - 文字识别（ScanText，OCR 识别器；框出一块区域后填要认的字）
 * - 录操作（Video 录像图标，把画面上的点击/滑动直接录成工作流步骤，开启后附带 +等0.5s/1s/3s）
 */
function DockRecordTools(): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const device = activeDevice(devices, activeId);
  const isConnected = useSessionStore((state) => Boolean(state.ready[activeId]));
  const recordStep = useSessionStore((state) => state.recordStep);
  const recordMode = useUiStore((state) => state.recordMode);
  const recordKind = useUiStore((state) => state.recordKind);
  const setRecordMode = useUiStore((state) => state.setRecordMode);
  const beginOcr = useUiStore((state) => state.beginOcrRecognizerCapture);
  const recordActionMode = useUiStore((state) => state.recordActionMode);
  const toggleRecordAction = useUiStore((state) => state.toggleRecordAction);
  const lockEdits = useCurrentWorkflowLive();
  const canRecord = isConnected && !lockEdits;

  const tools = [
    {
      mode: 'marquee' as const,
      label: '框选录制',
      hint: '框选录制：在设备画面上拖一个矩形生成识别器（点到别处或 Esc 关闭）',
      Icon: MousePointerSquareDashed,
    },
    {
      mode: 'pick' as const,
      label: '点选录制',
      hint: '点选录制：在设备画面上单击取 3×3% 邻域小模板（点到别处或 Esc 关闭）',
      Icon: ScanLine,
    },
  ];
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="录制工具" data-capture-keep>
      {tools.map(({ mode, label, hint, Icon }) => {
        // 文字识别也走 marquee 框选，但产出的是 OCR 表单，不能和「框选录制」同时点亮
        const active = recordMode === mode && !(mode === 'marquee' && recordKind === 'ocr');
        return (
          <button
            key={mode}
            type="button"
            aria-label={label}
            aria-pressed={active}
            data-testid={`dock-record-${mode}`}
            disabled={!canRecord}
            title={
              lockEdits
                ? FLOW_EDIT_LOCKED_HINT
                : isConnected
                  ? hint
                  : `设备未连接：先连上设备才能${label}（当前 ${device?.name ?? '无设备'}）`
            }
            onClick={() => setRecordMode(active ? 'off' : mode)}
            className={cn(
              'flex size-5 items-center justify-center rounded-sm',
              active ? 'bg-brand/20 text-brand' : 'text-dim hover:bg-raised hover:text-fg',
              !canRecord && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-dim',
            )}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
      <button
        type="button"
        aria-label="文字识别"
        aria-pressed={recordMode === 'marquee' && recordKind === 'ocr'}
        data-testid="dock-record-ocr"
        disabled={!canRecord}
        onClick={() => (recordMode === 'marquee' && recordKind === 'ocr' ? setRecordMode('off') : beginOcr())}
        title={
          lockEdits
            ? FLOW_EDIT_LOCKED_HINT
            : isConnected
              ? recordMode === 'marquee' && recordKind === 'ocr'
                ? '正在框选文字识别区域：再点一次或按 Esc 关闭'
                : '文字识别：在设备画面上框出要读字的区域，填上要认的字生成 OCR 识别器'
              : `设备未连接：先连上设备才能文字识别（当前 ${device?.name ?? '无设备'}）`
        }
        className={cn(
          'flex size-5 items-center justify-center rounded-sm',
          recordMode === 'marquee' && recordKind === 'ocr'
            ? 'bg-brand/20 text-brand'
            : 'text-dim hover:bg-raised hover:text-fg',
          !canRecord && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-dim',
        )}
      >
        <ScanText className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="录操作"
        aria-pressed={recordActionMode}
        data-testid="dock-record-action"
        disabled={!canRecord}
        onClick={toggleRecordAction}
        title={
          lockEdits
            ? FLOW_EDIT_LOCKED_HINT
            : isConnected
              ? recordActionMode
                ? '正在录操作：画面上的每次点击/滑动都会变成工作流里的一步（点到别处或 Esc 关闭）'
                : '录操作：把画面上的点击/滑动录成工作流里的一步'
              : `设备未连接：先连上设备才能录操作（当前 ${device?.name ?? '无设备'}）`
        }
        className={cn(
          'flex size-5 items-center justify-center rounded-sm',
          recordActionMode ? 'bg-brand/20 text-brand' : 'text-dim hover:bg-raised hover:text-fg',
          !canRecord && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-dim',
        )}
      >
        <Video className="size-3.5" />
      </button>
      {recordActionMode &&
        isConnected &&
        [0.5, 1, 3].map((seconds) => (
          <button
            key={seconds}
            type="button"
            data-testid={`record-wait-${seconds}`}
            onClick={() => void recordStep(activeId, { type: 'wait', seconds })}
            className="h-5 shrink-0 rounded-sm border border-line px-1 text-badge text-dim hover:bg-raised hover:text-fg"
            title={`录一步"等待 ${seconds}s"`}
          >
            +等{seconds}s
          </button>
        ))}
    </div>
  );
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

  const lastAutoOpenedRoot = useRef('');
  useEffect(() => {
    if (!workflowRoot || !hasKnownWorkflow) {
      lastAutoOpenedRoot.current = '';
      return;
    }
    if (lastAutoOpenedRoot.current !== workflowRoot) {
      openWorkflowTab(workflowRoot);
      lastAutoOpenedRoot.current = workflowRoot;
    }
  }, [workflowRoot, hasKnownWorkflow, openWorkflowTab]);

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
      tabs={tabsOpen ? <GraphTabs /> : undefined}
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
        className="h-full"
      >
        <Panel id="canvas" defaultSize="80%" minSize="30%" style={{ overflow: 'hidden' }}>
          <CanvasBoundary resetKey={workflowRoot}>
            <div data-testid="flow-canvas-wrap" className="h-full min-h-0">
              <WorkflowWorkspace
                tabsOpen={tabsOpen}
                workflowRoot={workflowRoot}
                emptyOverlay={
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 bg-canvas text-badge text-faint">
                    <span>没有打开的工作流</span>
                    <span>右栏「工作区」里点一条工作流就打开标签</span>
                    {hasKnownWorkflow ? (
                      <button
                        type="button"
                        onClick={() => openWorkflowTab(workflowRoot)}
                        title={workflowRoot}
                        className="mt-1 rounded-sm border border-line px-1.5 py-0.5 text-dim hover:bg-raised hover:text-fg"
                      >
                        重新打开「{taskName(workflowRoot)}」
                      </button>
                    ) : null}
                  </div>
                }
              />
            </div>
          </CanvasBoundary>
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
              leading={<DockRecordTools />}
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
