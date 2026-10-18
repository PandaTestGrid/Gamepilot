/**
 * 工作流画布头部（IDE 风格）：运行 · 分屏 · 自动排版（Workflow 图标：重新摆模块） · 更多。
 */
import {
  Columns2,
  Maximize2,
  MoreHorizontal,
  Play,
  Redo2,
  SlidersHorizontal,
  Square,
  Undo2,
  Workflow,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { IconGhostButton } from '@/layout/PanelShell';
import { useRunControl } from '@/lib/useRunControl';
import { cn } from '@/lib/utils';
import { FLOW_EDIT_LOCKED_HINT } from '@/lib/flow-edit-lock';
import { useCurrentWorkflowLive } from '@/lib/useLiveWorkflow';
import { useGraphStore } from '@/stores/graph.store';
import { NODE_SCALES, useUiStore, type NodeScale } from '@/stores/ui.store';

const NODE_SCALE_LABEL: Record<NodeScale, string> = { sm: '小', md: '中', lg: '大' };

export function GraphToolbar(): ReactNode {
  const run = useRunControl();
  const nodeScale = useUiStore((state) => state.nodeScale);
  const setNodeScale = useUiStore((state) => state.setNodeScale);
  const workflowSplitOpen = useUiStore((state) => state.workflowSplitOpen);
  const toggleWorkflowSplit = useUiStore((state) => state.toggleWorkflowSplit);
  const relayoutFlowCanvas = useUiStore((state) => state.relayoutFlowCanvas);
  const lockEdits = useCurrentWorkflowLive();
  const canUndoFlow = useGraphStore((state) => state.flowUndo.length > 0) && !lockEdits;
  const canRedoFlow = useGraphStore((state) => state.flowRedo.length > 0) && !lockEdits;
  const undoFlow = useGraphStore((state) => state.undoFlow);
  const redoFlow = useGraphStore((state) => state.redoFlow);
  const flowGlobalSettingsOpen = useUiStore((state) => state.flowGlobalSettingsOpen);
  const toggleFlowGlobalSettings = useUiStore((state) => state.toggleFlowGlobalSettings);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const close = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as HTMLElement)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const runTitle = run.blocker
    ? run.blocker
    : run.running
      ? `停止（${run.deviceName ?? '当前设备'}）`
      : `运行（${run.deviceName ?? '当前设备'}）`;

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <IconGhostButton
        active={run.running}
        disabled={Boolean(run.blocker)}
        onClick={run.toggle}
        title={runTitle}
      >
        {run.running ? (
          <Square className="size-3.5" strokeWidth={1.75} />
        ) : (
          <Play className="size-3.5" strokeWidth={1.75} />
        )}
      </IconGhostButton>
      <IconGhostButton
        active={workflowSplitOpen}
        onClick={toggleWorkflowSplit}
        title={
          workflowSplitOpen
            ? '关闭左右分屏（只保留当前工作流）'
            : '左右分屏（并排查看两个已打开的工作流标签）'
        }
      >
        <Columns2 className="size-3.5" strokeWidth={1.75} />
      </IconGhostButton>
      <IconGhostButton
        disabled={lockEdits}
        onClick={relayoutFlowCanvas}
        title={lockEdits ? FLOW_EDIT_LOCKED_HINT : '自动排版（按循环 / 条件结构重新摆模块）'}
      >
        <Workflow className="size-3.5" strokeWidth={1.75} />
      </IconGhostButton>
      <IconGhostButton
        disabled={!canUndoFlow}
        onClick={() => void undoFlow()}
        title={lockEdits ? FLOW_EDIT_LOCKED_HINT : canUndoFlow ? '撤销（Ctrl+Z）' : '没有可撤销的编辑'}
      >
        <Undo2 className="size-3.5" strokeWidth={1.75} />
      </IconGhostButton>
      <IconGhostButton
        disabled={!canRedoFlow}
        onClick={() => void redoFlow()}
        title={lockEdits ? FLOW_EDIT_LOCKED_HINT : canRedoFlow ? '重做（Ctrl+Y）' : '没有可重做的编辑'}
      >
        <Redo2 className="size-3.5" strokeWidth={1.75} />
      </IconGhostButton>
      <div className="relative" ref={menuRef}>
        <IconGhostButton
          active={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          title="更多工作流操作"
        >
          <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
        </IconGhostButton>
        {menuOpen && (
          <div
            className={cn(
              'absolute right-0 top-full z-50 mt-0.5 min-w-[10.5rem] rounded-sm border border-line bg-panel py-1 text-badge shadow-lg',
            )}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-dim hover:bg-raised hover:text-fg"
              onClick={() => {
                const next = NODE_SCALES[(NODE_SCALES.indexOf(nodeScale) + 1) % NODE_SCALES.length];
                setNodeScale(next ?? 'md');
              }}
            >
              <Maximize2 className="size-3.5 shrink-0 text-faint" strokeWidth={1.75} />
              <span>模块大小 · {NODE_SCALE_LABEL[nodeScale]}</span>
            </button>
            <div className="my-0.5 border-t border-line" />
            <button
              type="button"
              className={cn(
                'flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-raised hover:text-fg',
                flowGlobalSettingsOpen ? 'text-brand' : 'text-dim',
              )}
              onClick={() => {
                toggleFlowGlobalSettings();
                setMenuOpen(false);
              }}
            >
              <SlidersHorizontal className="size-3.5 shrink-0" strokeWidth={1.75} />
              <span>全局配置</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
