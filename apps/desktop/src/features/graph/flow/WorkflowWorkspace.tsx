/**
 * 工作流画布区：模块栏 + 流程图（多标签快照）。
 */
import { type ReactNode, useMemo, useState } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

import { FlowCanvas } from '@/features/graph/flow/FlowCanvas';
import { FlowGlobalSettingsDrawer } from '@/features/graph/flow/FlowGlobalSettingsDrawer';
import { FlowModulePointerDragProvider } from '@/features/graph/flow/flow-module-pointer-drag';
import { ModulePaletteRail } from '@/features/graph/flow/ModulePaletteRail';
import { taskName } from '@/features/graph/task-name';
import { GRAPH_SPLIT_LAYOUT, defaultPanelShare } from '@/layout/layout-specs';
import { useLayoutGroup } from '@/layout/useLayoutGroup';
import { cn } from '@/lib/utils';
import { FLOW_EDIT_LOCKED_HINT } from '@/lib/flow-edit-lock';
import { useLiveWorkflow } from '@/lib/useLiveWorkflow';
import { useDeviceStore } from '@/stores/device.store';
import { graphForWorkflowRoot, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
function WorkflowColumn({
  workflowRoot,
  readOnly,
  showHeader,
}: {
  workflowRoot: string;
  readOnly?: boolean;
  showHeader?: boolean;
}): ReactNode {
  const activeId = useDeviceStore((state) => state.activeId);
  const graph = useGraphStore((state) => graphForWorkflowRoot(state, workflowRoot, activeId));
  const currentRoot = useSessionStore((state) => state.currentWorkflow?.root ?? '');
  const switchWorkflow = useSessionStore((state) => state.switchWorkflow);
  const live = useLiveWorkflow(workflowRoot);
  const isActive = workflowRoot === currentRoot;
  const title = taskName(workflowRoot);
  const columnReadOnly = Boolean(readOnly || !isActive);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid={readOnly ? 'flow-column-readonly' : 'flow-column-active'}
    >
      {showHeader ? (
        <div
          className={cn(
            'flex h-6 shrink-0 items-center gap-2 border-b border-line bg-panel px-2 text-badge',
            isActive ? 'text-fg' : 'text-dim',
          )}
        >
          <button
            type="button"
            className="min-w-0 truncate hover:text-fg"
            title={workflowRoot}
            disabled={isActive}
            onClick={() => {
              if (!isActive) {
                void switchWorkflow(workflowRoot);
              }
            }}
          >
            {title}
            {isActive ? ' · 当前' : ' · 点此切换'}
          </button>
          {live ? (
            <span className="shrink-0 text-brand" title={FLOW_EDIT_LOCKED_HINT}>
              运行中 · 只读
            </span>
          ) : readOnly ? (
            <span className="shrink-0 text-faint">只读快照</span>
          ) : null}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {graph ? (
          <FlowCanvas graph={graph} readOnly={columnReadOnly} allowManualConnect />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-badge text-faint">
            还没有快照：点标签切换到该工作流一次后，可在此并排查看
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkflowWorkspace({
  tabsOpen,
  workflowRoot,
  emptyOverlay,
}: {
  tabsOpen: boolean;
  workflowRoot: string;
  emptyOverlay: ReactNode;
}): ReactNode {
  const workflowSplitOpen = useUiStore((state) => state.workflowSplitOpen);
  const openWorkflowTabs = useUiStore((state) => state.openWorkflowTabs);
  const splitLayout = useLayoutGroup(GRAPH_SPLIT_LAYOUT);
  const paletteRef = usePanelRef();
  const [paletteOpen, setPaletteOpen] = useState(true);

  const primaryRoot = workflowRoot;
  const peerRoot = useMemo(() => {
    if (!workflowSplitOpen) {
      return '';
    }
    return openWorkflowTabs.find((root) => root && root !== workflowRoot) ?? '';
  }, [workflowSplitOpen, openWorkflowTabs, workflowRoot]);

  const defaultPrimary =
    splitLayout.defaultLayout?.primary ?? defaultPanelShare(GRAPH_SPLIT_LAYOUT, 'primary');

  if (!tabsOpen) {
    return (
      <div className="relative flex h-full min-h-0">
        <div className="relative min-w-0 flex-1">{emptyOverlay}</div>
        <FlowGlobalSettingsDrawer />
      </div>
    );
  }

  return (
    <FlowModulePointerDragProvider>
      <ModulePaletteRail paletteRef={paletteRef} paletteOpen={paletteOpen} setPaletteOpen={setPaletteOpen}>
        <div className="flex h-full min-h-0 w-full">
          <div className="min-w-0 flex-1">
            {workflowSplitOpen && peerRoot ? (
              <Group
                id={GRAPH_SPLIT_LAYOUT.id}
                orientation="horizontal"
                defaultLayout={splitLayout.defaultLayout}
                onLayoutChanged={splitLayout.onLayoutChanged}
                groupRef={splitLayout.groupRef}
                className="h-full min-h-0"
              >
                <Panel
                  id="primary"
                  defaultSize={`${defaultPrimary}%`}
                  minSize="25%"
                  style={{ overflow: 'hidden' }}
                >
                  <WorkflowColumn workflowRoot={primaryRoot} showHeader />
                </Panel>
                <Separator
                  className="w-px bg-line transition-colors hover:bg-brand"
                  title="拖动改左右分屏比例"
                />
                <Panel
                  id="secondary"
                  defaultSize={`${100 - defaultPrimary}%`}
                  minSize="25%"
                  style={{ overflow: 'hidden' }}
                >
                  <WorkflowColumn workflowRoot={peerRoot} readOnly showHeader />
                </Panel>
              </Group>
            ) : (
              <WorkflowColumn workflowRoot={primaryRoot} />
            )}
          </div>
          <FlowGlobalSettingsDrawer />
        </div>
      </ModulePaletteRail>
    </FlowModulePointerDragProvider>
  );
}
