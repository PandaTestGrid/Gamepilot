/**
 * 节点编辑器：改名、挂/摘进入识别器、删除节点。
 *
 * 节点 = 一个界面；`enter` 里的识别器确认命中时，状态机就认为"我现在在这个界面"。
 * 所以这里挂哪些识别器，直接决定脚本能不能认出这个界面。
 */
import { type ReactNode, useState } from 'react';

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
    <div className="shrink-0 border-t border-line bg-panel px-2 py-1.5">
      <div className="mb-1 flex items-center gap-2">
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
            <button
              key={label}
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
      <div className="text-badge text-faint">
        提示：拖节点右侧的小圆点到另一个节点即可连边；连出来的边默认条件是"源界面的识别器"，
        点那条边可以再改动作与条件。
      </div>
    </div>
  );
}
