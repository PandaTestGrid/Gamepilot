/**
 * 运行状态条：运行中在画布左上角显示"现在停在哪、下一步会走哪条、还差什么"。
 *
 * 为什么要有它：画布上的高亮（当前节点呼吸、条件边流动）只能表达"大概在动"，
 * 但调试时最想知道的是一句话答案 —— 当前界面 / 正在等的识别器 / 哪条边被选中了。
 * 这里就是那句话，数据全部来自已有的实时状态（`graph.activeNodeId` + 每帧识别结果算出的边状态）。
 */
import type { ReactNode } from 'react';

import { type EdgeStatus } from '@/lib/edge-status';
import { edgeLabel } from '@/lib/graph-logic';
import { cn } from '@/lib/utils';
import type { GraphData } from '@/types';

export function RunStatusStrip({
  graph,
  statuses,
  running,
}: {
  graph: GraphData | undefined;
  statuses: ReadonlyMap<string, EdgeStatus>;
  running: boolean;
}): ReactNode {
  if (!graph) {
    return null;
  }
  const current = (graph.nodes ?? []).find((node) => node.id === graph.activeNodeId);
  const outgoing = (graph.edges ?? []).filter((edge) => edge.from === graph.activeNodeId);

  // 下一步：优先"可以走"的，其次"正在等"的（按引擎的优先级排序取第一条）
  const sorted = [...outgoing].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const next =
    sorted.find((edge) => statuses.get(edge.id)?.kind === 'matched') ??
    sorted.find((edge) => statuses.get(edge.id)?.kind === 'waiting');
  const status = next ? statuses.get(next.id) : undefined;

  if (!running && !current) {
    return null;
  }

  return (
    <div
      data-testid="run-status"
      className="pointer-events-none absolute top-2 left-2 z-10 flex max-w-[calc(100%-16px)] flex-wrap items-center gap-x-2 gap-y-0.5 rounded-sm border border-line bg-panel/90 px-2 py-0.5 text-badge"
    >
      <span className={cn('flex items-center gap-1', running ? 'text-confirmed' : 'text-faint')}>
        <span className={cn('size-1.5 rounded-full', running ? 'bg-confirmed' : 'bg-idle')} />
        {running ? '运行中' : '已停止'}
      </span>
      <span className="text-dim">
        当前：<span className="text-fg">{current?.name ?? '（不在任何界面）'}</span>
      </span>
      {next && (
        <span className="text-dim">
          下一步：<span className="text-fg">{edgeLabel(next, graph)}</span>
          {status?.kind === 'matched' ? (
            <span className="text-confirmed"> · 条件成立</span>
          ) : (
            <span className="text-faint"> · {status?.reason ?? '等待条件'}</span>
          )}
        </span>
      )}
      {!next && current && <span className="text-faint">没有出边：脚本会停在这个界面</span>}
    </div>
  );
}
