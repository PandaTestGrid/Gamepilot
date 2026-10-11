/**
 * 黑板（变量）面板。
 *
 * 蓝图里"把值抽出来共享"的那一层：一个坐标、一个阈值、一个次数写在变量里，
 * 动作参数用 `$变量名` 引用 —— 改一处，全脚本生效。
 *
 * 这里管的是**默认值**（写回 graph.json）；运行期被"赋值"动作改过的值，
 * 引擎会通过 device.status 回传，面板上会显示成"当前"。
 */
import { type ReactNode, useState } from 'react';

import { cn } from '@/lib/utils';
import { useGraphStore } from '@/stores/graph.store';
import type { GraphData } from '@/types';

export function VariablesPanel({
  deviceId,
  graph,
}: {
  deviceId: string;
  graph: GraphData | undefined;
}): ReactNode {
  const setVariables = useGraphStore((state) => state.setVariables);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const variables = graph?.variables ?? [];

  const save = async (
    next: Record<string, { type?: string; value?: string | number | boolean }>,
  ): Promise<void> => {
    setError(null);
    try {
      await setVariables(deviceId, next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const asRecord = (): Record<string, { type?: string; value?: string | number | boolean }> =>
    Object.fromEntries(variables.map((item) => [item.name, { type: item.type, value: item.value }]));

  return (
    <div className="h-full min-h-0 overflow-auto px-2 py-1 text-badge">
      <div className="mb-1 text-faint">
        动作参数里填 <span className="text-fg">$变量名</span> 就能引用这里的变量（例：X 填{' '}
        <span className="text-fg">$点击X</span>）
      </div>

      {variables.length === 0 && <div className="py-2 text-faint">还没有变量。下面加一个试试。</div>}

      {variables.map((item) => (
        <div key={item.name} className="flex items-center gap-1 py-0.5">
          <span className="w-28 shrink-0 truncate text-fg" title={item.name}>
            {item.name}
          </span>
          <select
            value={item.type}
            onChange={(event) =>
              void save({ ...asRecord(), [item.name]: { type: event.target.value, value: item.value } })
            }
            className="h-5 rounded-sm border border-line bg-canvas px-1 text-badge text-dim"
          >
            <option value="number">数字</option>
            <option value="text">文本</option>
            <option value="key">识别器键</option>
          </select>
          <input
            value={String(item.value)}
            onChange={(event) => {
              const raw = event.target.value;
              const value =
                item.type === 'number' && raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
              void save({ ...asRecord(), [item.name]: { type: item.type, value } });
            }}
            className="h-5 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
          />
          <span className="w-20 shrink-0 text-right text-faint" title="运行时当前值">
            {item.runtimeValue !== undefined ? `当前 ${String(item.runtimeValue)}` : ''}
          </span>
          <button
            type="button"
            onClick={() => {
              const next = asRecord();
              delete next[item.name];
              void save(next);
            }}
            className="h-5 shrink-0 rounded-sm border border-line px-1 text-failed hover:bg-raised"
          >
            删
          </button>
        </div>
      ))}

      <div className="mt-2 flex items-center gap-1 border-t border-line pt-1">
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="新变量名，如 点击X"
          className="h-5 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
        />
        <button
          type="button"
          disabled={newName.trim() === '' || variables.some((item) => item.name === newName.trim())}
          onClick={() => {
            const name = newName.trim();
            void save({ ...asRecord(), [name]: { type: 'number', value: 0 } });
            setNewName('');
          }}
          className={cn(
            'h-5 shrink-0 rounded-sm border border-line px-1 text-dim hover:bg-raised hover:text-fg',
            'disabled:opacity-40',
          )}
        >
          加变量
        </button>
      </div>

      {error && <div className="mt-1 text-failed">{error}</div>}
      <div className="mt-2 text-faint">
        提示：运行时被「设置变量」动作改过的值只在这一次运行有效，每次运行都从默认值开始。
      </div>
    </div>
  );
}
