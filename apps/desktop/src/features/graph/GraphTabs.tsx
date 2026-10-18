/**
 * 中间栏工作流标签（IDE 式）：点标签 = `switchWorkflow`；✕ 只关界面不删文件。
 * 每个标签可以独立运行；点标签 = `switchWorkflow`。
 */
import { type ReactNode, useEffect, useState } from 'react';

import { taskName } from '@/features/graph/task-name';
import { PanelTab, PanelTabList } from '@/layout/PanelTabBar';
import { jumpToDevice } from '@/lib/jump-to-run';
import { useLiveWorkflow, useRunningDevicesForWorkflow } from '@/lib/useLiveWorkflow';
import { useDeviceStore } from '@/stores/device.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

const CLOSE_HINT = '关闭这个标签（只是关掉界面，文件还在）';
const CLOSE_LIVE_HINT = '关闭这个标签（正在运行，会先确认）';

export function GraphTabs(): ReactNode {
  const openWorkflowTabs = useUiStore((state) => state.openWorkflowTabs);
  const closeWorkflowTab = useUiStore((state) => state.closeWorkflowTab);
  const currentRoot = useSessionStore((state) => state.currentWorkflow?.root ?? '');
  const switching = useSessionStore((state) => state.switchingWorkflow);
  const switchingRoot = useSessionStore((state) => state.switchingWorkflowRoot);
  const switchWorkflow = useSessionStore((state) => state.switchWorkflow);
  const [confirmingRoot, setConfirmingRoot] = useState('');

  useEffect(() => {
    if (!confirmingRoot) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setConfirmingRoot('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmingRoot]);

  if (openWorkflowTabs.length === 0) {
    return null;
  }

  const closeTab = (root: string): void => {
    const index = openWorkflowTabs.indexOf(root);
    const closingCurrent = root === currentRoot;
    const neighbour = openWorkflowTabs[index + 1] ?? openWorkflowTabs[index - 1];
    setConfirmingRoot('');
    closeWorkflowTab(root);
    if (closingCurrent && neighbour) {
      void switchWorkflow(neighbour);
    }
  };

  return (
    <PanelTabList>
      {openWorkflowTabs.map((root) => (
        <GraphTab
          key={root}
          root={root}
          active={root === currentRoot}
          switching={switching && (switchingRoot ? root === switchingRoot : root === currentRoot)}
          confirming={confirmingRoot === root}
          onSelect={() => {
            setConfirmingRoot('');
            if (root !== currentRoot) {
              void switchWorkflow(root);
            }
          }}
          onRequestClose={(live) => {
            if (live && confirmingRoot !== root) {
              setConfirmingRoot(root);
              return;
            }
            closeTab(root);
          }}
          onCancelClose={() => setConfirmingRoot('')}
        />
      ))}
    </PanelTabList>
  );
}

function GraphTab({
  root,
  active,
  switching,
  confirming,
  onSelect,
  onRequestClose,
  onCancelClose,
}: {
  root: string;
  active: boolean;
  switching: boolean;
  confirming: boolean;
  onSelect: () => void;
  onRequestClose: (live: boolean) => void;
  onCancelClose: () => void;
}): ReactNode {
  const live = useLiveWorkflow(root);
  const runners = useRunningDevicesForWorkflow(root);
  const activeId = useDeviceStore((state) => state.activeId);
  const liveHint = runners.length ? `运行中 · ${runners.map((runner) => runner.name).join('、')}` : undefined;
  return (
    <PanelTab
      active={active}
      label={taskName(root)}
      fullTitle={root}
      closeTitle={live ? CLOSE_LIVE_HINT : CLOSE_HINT}
      busy={switching}
      live={live}
      liveHint={liveHint}
      confirming={confirming}
      onSelect={() => {
        onSelect();
        const preferred = runners.find((runner) => runner.id === activeId) ?? runners[0];
        if (preferred) {
          jumpToDevice(preferred.id);
        }
      }}
      onClose={() => onRequestClose(live)}
      onCancelClose={onCancelClose}
    />
  );
}
