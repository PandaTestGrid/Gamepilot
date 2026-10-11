/**
 * 边的编辑器：判断条件 + 基础操作。
 *
 * 这里改的是**引擎的真源**（graph.json）——通过 graph store 的 `saveEdge` 写回，
 * 保存后引擎热重载，运行中的状态机立刻用新条件。
 *
 * 条件语义（和引擎 core/conditions.py 一致）：
 *   且（all_of）所有标签都命中 / 或（any_of）任一命中 / 非（none_of）都不得出现，
 *   min_score 是分数门槛，within_ms 是"限时等待"（进节点后最多等这么久，超时这条边就不走）。
 */
import { type ReactNode, useState } from 'react';

import { toActionPayload, toConditionPayload } from '@/lib/graph-adapter';
import { type DetectionLike, evaluateEdge } from '@/lib/edge-status';
import { devLog, actionRun } from '@/lib/rpc';
import { describeEdgeLogic } from '@/lib/graph-logic';
import { cn } from '@/lib/utils';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import type { EdgeAction, EdgeCondition, GraphData, GraphEdgeView } from '@/types';

const KEY_OPTIONS = ['back', 'home', 'recents', 'power', 'volume_up', 'volume_down'] as const;

const ACTION_OPTIONS: { value: EdgeAction['type']; label: string }[] = [
  { value: 'click', label: '点击' },
  { value: 'long_press', label: '长按' },
  { value: 'swipe', label: '滑动' },
  { value: 'wait', label: '等待' },
  { value: 'key', label: '按键' },
  { value: 'text', label: '输入文本' },
];

export function EdgeEditor({
  deviceId,
  edge,
  graph,
}: {
  deviceId: string;
  edge: GraphEdgeView;
  graph: GraphData | undefined;
}): ReactNode {
  const saveEdge = useGraphStore((state) => state.saveEdge);
  const removeEdge = useGraphStore((state) => state.removeEdge);
  const [condition, setCondition] = useState<EdgeCondition>(edge.condition);
  const [action, setAction] = useState<EdgeAction>(edge.actionSpec);
  const [priority, setPriority] = useState(edge.priority);
  const [cooldownMs, setCooldownMs] = useState(edge.cooldownMs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 注意：草稿用 useState 初始化。换边时由外面给 <EdgeEditor key={edge.id}> 重新挂载，
  // 不用 effect 去同步 props → state（那样会多一次渲染，也被 lint 规则禁止）。

  const labels = (graph?.recognizers ?? []).map((item) => item.label);
  const deviceReady = useSessionStore((state) => state.ready[deviceId] === true);
  const runOnce = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await actionRun(deviceId, toActionPayload(edge.actionSpec));
      devLog(`单独执行：${result.described}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const live = evaluateEdge(
    edge,
    (graph?.recognizers ?? []).map<DetectionLike>((item) => ({
      label: item.label,
      score: item.score,
      state: item.state,
    })),
    graph?.activeNodeId ?? null,
  );
  const primary = edge.when;

  const toggleLabel = (group: 'allOf' | 'anyOf' | 'noneOf', label: string): void => {
    setCondition((current) => {
      const list = current[group];
      const next = list.includes(label) ? list.filter((item) => item !== label) : [...list, label];
      return { ...current, [group]: next };
    });
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await saveEdge(deviceId, edge.id, {
        condition: toConditionPayload(condition, primary) ?? null,
        action: toActionPayload(action),
        priority,
        cooldown_ms: cooldownMs,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    // 这里是画布下方那块"编辑坞"的内容：外框与分隔线由 GraphPane 的纵向 Group 提供，
    // 所以自己不再画 border-t（否则和分隔线叠成 2px），也不写 shrink-0（高度由拖动决定）
    <div className="bg-panel px-2 py-1.5">
      {/* 同 NodeEditor：面板窄的时候宁可换行，也不要把按钮挤成竖排 */}
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn('text-body', edge.kind === 'recovery' ? 'text-recovery' : 'text-confirmed')}>
          {edge.kind === 'recovery' ? '⚡ ' : ''}
          {edge.id}
        </span>
        <span className="text-badge text-faint">
          {edge.from ?? '（全局）'} → {edge.to ?? '（原地，不切界面）'}
        </span>
        <div className="flex-1" />
        <label className="flex items-center gap-1 text-badge text-dim">
          优先级
          <input
            type="number"
            value={priority}
            onChange={(event) => setPriority(Number(event.target.value))}
            className="h-5 w-12 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
          />
        </label>
        <label className="flex items-center gap-1 text-badge text-dim">
          冷却ms
          <input
            type="number"
            value={cooldownMs}
            onChange={(event) => setCooldownMs(Number(event.target.value))}
            className="h-5 w-14 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
          />
          <span className="text-faint">（0 = 每次进入节点只做一次）</span>
        </label>
        <button
          type="button"
          onClick={() => void removeEdge(deviceId, edge.id)}
          className="h-5 rounded-sm border border-line px-1.5 text-badge text-failed hover:bg-raised"
        >
          删除边
        </button>
      </div>

      {/* 判断条件 */}
      <div className="mb-1 text-badge text-dim">
        <span className="text-faint">逻辑：</span>
        <span className="text-fg">{describeEdgeLogic(edge, graph)}</span>
      </div>
      <div className="mb-1 text-badge">
        <span className="text-faint">此刻：</span>
        <span
          className={
            live.kind === 'matched' ? 'text-confirmed' : live.kind === 'blocked' ? 'text-failed' : 'text-dim'
          }
        >
          {live.kind === 'matched' ? '会走' : live.kind === 'blocked' ? '被挡' : '还没满足'} —— {live.reason}
        </span>
      </div>

      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-badge">
        <span className="text-dim">判断条件</span>
        <button
          type="button"
          onClick={() => setCondition({ ...condition, always: !condition.always })}
          className={cn(
            'rounded-sm border px-1',
            condition.always ? 'border-pending text-pending' : 'border-line text-dim hover:text-fg',
          )}
          title="无条件：进入源节点就做这一步（录制出来的步骤默认是「在当前界面才做」）"
        >
          无条件
        </button>
        {(
          [
            ['allOf', '且'],
            ['anyOf', '或'],
            ['noneOf', '非'],
          ] as const
        ).map(([group, title]) => (
          <span key={group} className="flex items-center gap-1">
            <span className="text-faint">{title}</span>
            {labels.map((label) => {
              const active = condition[group].includes(label);
              return (
                <button
                  key={`${group}-${label}`}
                  type="button"
                  onClick={() => toggleLabel(group, label)}
                  className={cn(
                    'rounded-sm border px-1',
                    active
                      ? group === 'noneOf'
                        ? 'border-failed text-failed'
                        : 'border-brand text-brand'
                      : 'border-line text-dim hover:text-fg',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </span>
        ))}
        <label className="flex items-center gap-1 text-dim">
          min_score
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={condition.minScore}
            onChange={(event) => setCondition({ ...condition, minScore: Number(event.target.value) })}
            className="h-5 w-14 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
          />
        </label>
        <label
          className="flex items-center gap-1 text-dim"
          title="限时等待：进入源节点后最多等这么久，超时这条边就不走"
        >
          限时等待ms
          <input
            type="number"
            step="500"
            min="0"
            value={condition.withinMs}
            onChange={(event) => setCondition({ ...condition, withinMs: Number(event.target.value) })}
            className="h-5 w-16 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
          />
        </label>
      </div>

      {/* 基础操作 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-badge">
        <span className="text-dim">动作</span>
        <select
          value={action.type}
          onChange={(event) => setAction({ ...action, type: event.target.value as EdgeAction['type'] })}
          className="h-5 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
        >
          {ACTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {(action.type === 'click' || action.type === 'long_press' || action.type === 'swipe') && (
          <>
            <label className="flex items-center gap-1 text-dim">
              目标
              <select
                value={action.target ?? ''}
                onChange={(event) => setAction({ ...action, target: event.target.value || undefined })}
                className="h-5 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
              >
                <option value="">（用坐标）</option>
                {labels.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {!action.target && (
              <>
                <NumberField
                  label="x"
                  value={action.x ?? 0.5}
                  onChange={(value) => setAction({ ...action, x: value })}
                />
                <NumberField
                  label="y"
                  value={action.y ?? 0.5}
                  onChange={(value) => setAction({ ...action, y: value })}
                />
              </>
            )}
          </>
        )}

        {action.type === 'swipe' && (
          <>
            <NumberField
              label="到x"
              value={action.toX ?? 0.5}
              onChange={(value) => setAction({ ...action, toX: value })}
            />
            <NumberField
              label="到y"
              value={action.toY ?? 0.2}
              onChange={(value) => setAction({ ...action, toY: value })}
            />
          </>
        )}

        {(action.type === 'click' || action.type === 'long_press' || action.type === 'swipe') && (
          <NumberField
            label="时长ms"
            value={action.durationMs ?? 300}
            onChange={(value) => setAction({ ...action, durationMs: value })}
          />
        )}

        {action.type === 'wait' && (
          <NumberField
            label="秒"
            value={action.seconds ?? 0.5}
            onChange={(value) => setAction({ ...action, seconds: value })}
          />
        )}

        {action.type === 'key' && (
          <label className="flex items-center gap-1 text-dim">
            按键
            <select
              value={action.value ?? 'back'}
              onChange={(event) => setAction({ ...action, value: event.target.value })}
              className="h-5 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
            >
              {KEY_OPTIONS.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </label>
        )}

        {action.type === 'text' && (
          <label className="flex items-center gap-1 text-dim">
            文本
            <input
              value={action.value ?? ''}
              onChange={(event) => setAction({ ...action, value: event.target.value })}
              className="h-5 w-32 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
            />
          </label>
        )}

        <div className="flex-1" />
        {error && <span className="text-failed">保存失败: {error}</span>}
        <button
          type="button"
          disabled={busy || !deviceReady}
          title={deviceReady ? '不改脚本，直接按这一步的动作操作设备（调试用）' : '设备未连接'}
          onClick={() => {
            void runOnce();
          }}
          className="h-5 rounded-sm border border-line px-2 text-badge text-dim hover:bg-raised hover:text-fg disabled:opacity-40"
        >
          立即执行这一步
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="h-5 rounded-sm bg-brand px-2 text-badge font-medium text-[#0b0d12] hover:opacity-90 disabled:opacity-50"
        >
          {busy ? '保存中…' : '保存到脚本'}
        </button>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}): ReactNode {
  return (
    <label className="flex items-center gap-1 text-dim">
      {label}
      <input
        type="number"
        step="0.05"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-5 w-14 rounded-sm border border-line bg-canvas px-1 text-badge text-fg"
      />
    </label>
  );
}
