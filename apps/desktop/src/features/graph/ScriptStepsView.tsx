/**
 * 脚本视图：把状态图按执行顺序展开成**线性步骤**。
 *
 * 和画布双向联动：
 * - 点步骤 → 选中对应节点/边（画布高亮、底部打开编辑器）
 * - 画布选中 → 这里高亮并自动滚动到那一步
 *
 * 挂在状态图面板的「脚本」页签下（画布是「状态图」页签）。
 */
import { type ReactNode, useEffect, useMemo, useRef } from 'react';

import { buildScriptSteps, selectedStepId } from '@/lib/script-steps';
import { cn } from '@/lib/utils';
import { useGraphStore } from '@/stores/graph.store';
import type { GraphData } from '@/types';

export function ScriptStepsView({ graph }: { graph: GraphData | undefined }): ReactNode {
  const selectNode = useGraphStore((state) => state.selectNode);
  const selectEdge = useGraphStore((state) => state.selectEdge);
  const selectedNodeId = useGraphStore((state) => state.selectedNodeId);
  const selectedEdgeId = useGraphStore((state) => state.selectedEdgeId);

  const steps = useMemo(() => buildScriptSteps(graph), [graph]);
  const active = selectedStepId(selectedNodeId, selectedEdgeId);
  const containerRef = useRef<HTMLDivElement>(null);

  // 画布上选中了什么，脚本视图就滚到哪一步（DOM 副作用，不涉及状态更新）
  useEffect(() => {
    if (!active || !containerRef.current) {
      return;
    }
    const element = containerRef.current.querySelector(`[data-step="${active}"]`);
    element?.scrollIntoView({ block: 'nearest' });
  }, [active, steps]);

  if (steps.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-badge text-faint">
        脚本还是空的。先在画面栏「框选」录一个界面，或者用「录操作」点几下 —— 步骤会出现在这里。
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full min-h-0 overflow-auto px-2 py-1">
      {steps.map((step, index) => {
        const selected = step.id === active;
        return (
          <button
            key={`${step.kind}-${step.id}-${index}`}
            type="button"
            data-step={step.id}
            onClick={() => {
              if (step.kind === 'edge' && step.edgeId) {
                selectEdge(step.edgeId);
              } else if (step.nodeId) {
                selectNode(step.nodeId);
              }
            }}
            className={cn(
              'flex w-full items-start gap-2 rounded-sm px-1 py-0.5 text-left',
              step.depth > 0 && 'pl-6',
              selected ? 'bg-raised' : 'hover:bg-raised/60',
              !step.reachable && 'opacity-50',
            )}
            title={`${step.title}：${step.detail}`}
          >
            <span className="w-6 shrink-0 text-right text-badge text-faint">{index + 1}</span>
            <span className="shrink-0 text-badge text-dim">
              {step.kind === 'node' ? '▣' : step.depth > 0 ? '↳' : '→'}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn('block truncate text-body', selected ? 'text-brand' : 'text-fg')}>
                {step.title}
              </span>
              <span className="block truncate text-badge text-faint">{step.detail}</span>
            </span>
          </button>
        );
      })}
      <div className="mt-2 px-1 text-badge text-faint">
        共 {steps.filter((step) => step.kind === 'node').length} 个界面 ·{' '}
        {steps.filter((step) => step.kind === 'edge').length} 步操作
        {steps.some((step) => !step.reachable) && ' · 灰色的是从起点走不到的'}
      </div>
    </div>
  );
}
