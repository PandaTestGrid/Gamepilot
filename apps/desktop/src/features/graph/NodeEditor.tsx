/**
 * 节点编辑器：改名、挂/摘进入识别器、删除节点。
 *
 * 节点 = 一个界面；`enter` 里的识别器确认命中时，状态机就认为"我现在在这个界面"。
 * 所以这里挂哪些识别器，直接决定脚本能不能认出这个界面。
 */
import { type ReactNode, useState } from 'react';

import { TemplateThumb } from '@/features/recognizers/TemplateThumb';
import { describeAction, describeCondition, describeNodeLogic } from '@/lib/graph-logic';
import { cn } from '@/lib/utils';
import { useGraphStore } from '@/stores/graph.store';
import type { GraphData, GraphNodeView } from '@/types';

export function NodeEditor({
  deviceId,
  node,
  graph,
}: {
  deviceId: string;
  node: GraphNodeView;
  graph: GraphData | undefined;
}): ReactNode {
  const updateNode = useGraphStore((state) => state.updateNode);
  const selectEdge = useGraphStore((state) => state.selectEdge);
  const removeNode = useGraphStore((state) => state.removeNode);
  const selectNode = useGraphStore((state) => state.selectNode);
  const [name, setName] = useState(node.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const labels = (graph?.recognizers ?? []).map((item) => item.label);
  const enter = graph?.nodes.find((item) => item.id === node.id)?.enter ?? [];

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleEnter = (label: string): void => {
    const next = enter.includes(label) ? enter.filter((item) => item !== label) : [...enter, label];
    void run(() => updateNode(deviceId, node.id, { enter: next }));
  };

  return (
    // 同 EdgeEditor：外框/分隔线交给 GraphPane 的纵向 Group，自己只负责内容
    <div className="bg-panel px-2 py-1.5">
      {/* 必须能换行：面板不宽、识别器又多的时候，不换行会把按钮挤成一列竖排文字 */}
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-body text-brand">节点 {node.id}</span>
        <label className="flex items-center gap-1 text-badge text-dim">
          名称
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => {
              if (name.trim() && name !== node.name) {
                void run(() => updateNode(deviceId, node.id, { name: name.trim() }));
              }
            }}
            className="h-5 w-32 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
          />
        </label>
        <span className="text-badge text-faint">进入识别器（命中哪些就认定"在这个界面"）</span>
        {labels.map((label) => {
          const active = enter.includes(label);
          return (
            <span key={label} className="flex items-center gap-0.5">
              {/* 模板缩略图：点一下切黑白（模板匹配本来就是按灰度算的） */}
              <TemplateThumb label={label} size={18} />
              <button
                type="button"
                disabled={busy}
                onClick={() => toggleEnter(label)}
                className={cn(
                  'rounded-sm border px-1 text-badge',
                  active ? 'border-confirmed text-confirmed' : 'border-line text-dim hover:text-fg',
                )}
              >
                {label}
              </button>
            </span>
          );
        })}
        {labels.length === 0 && (
          <span className="text-badge text-faint">（还没有识别器，先在画面栏框选录制）</span>
        )}
        <div className="flex-1" />
        {error && <span className="text-failed">{error}</span>}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void run(async () => {
              await removeNode(deviceId, node.id);
              selectNode(null);
            });
          }}
          className="h-5 rounded-sm border border-line px-1.5 text-badge text-failed hover:bg-raised"
        >
          删除节点
        </button>
      </div>
      {enter.length > 0 && (
        <div className="mb-1 flex flex-wrap items-center gap-1 text-badge text-faint">
          <span>这个界面用的模板：</span>
          {enter.map((label) => (
            <span key={label} className="flex items-center gap-0.5">
              <TemplateThumb label={label} size={22} />
              <span className="text-dim">{label}</span>
            </span>
          ))}
        </div>
      )}

      {/* 这个界面的逻辑：怎么判定、有哪些操作、怎么进来的 */}
      <div className="flex flex-col gap-0.5 text-badge text-faint">
        {describeNodeLogic(node, graph).map((line) => (
          <span key={line}>· {line}</span>
        ))}
      </div>

      {(graph?.edges ?? []).some((edge) => edge.from === node.id) && (
        <div className="mt-1 flex flex-col gap-0.5">
          <span className="text-badge text-dim">出去的操作（点一条可在下方编辑）</span>
          {(graph?.edges ?? [])
            .filter((edge) => edge.from === node.id)
            .map((edge) => (
              <button
                key={edge.id}
                type="button"
                onClick={() => selectEdge(edge.id)}
                className="flex items-center gap-1 rounded-sm px-1 text-left text-badge text-dim hover:bg-raised hover:text-fg"
              >
                <span className="shrink-0 text-faint">{edge.kind === 'recovery' ? '⚡' : '→'}</span>
                <span className="text-fg">{describeAction(edge.actionSpec, true)}</span>
                <span className="text-faint">当 {describeCondition(edge)}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
