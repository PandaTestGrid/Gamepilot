/**
 * 模块设置：常规 · 出错时 · 线段（与 Automa 模块设置对齐，数据在 params.settings）。
 */
import { type ReactNode, useState } from 'react';

import { resolveFlowGlobalDefaults } from '@/features/graph/flow/FlowGlobalSettingsDrawer';
import {
  DEBUG_CAPABLE_STEP_TYPES,
  mergeStepSettings,
  readStepSettings,
  settingsToParams,
  type LineSegmentKind,
  type OnErrorMode,
} from '@/features/graph/flow/flow-step-settings';
import { flowStepTitle } from '@/features/graph/flow/flow-step-meta';
import { cn } from '@/lib/utils';
import { useCurrentWorkflowLive } from '@/lib/useLiveWorkflow';
import { useDeviceStore } from '@/stores/device.store';
import { rawFor, SCRIPT_SCOPE, useGraphStore } from '@/stores/graph.store';
import type { FlowStep } from '@/types';

function Section({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="border-t border-line/70 pt-1.5">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1 py-0.5 text-left text-badge font-medium text-dim hover:text-fg"
      >
        <span className={cn('text-faint transition-transform', open ? 'rotate-90' : '')}>▸</span>
        {title}
      </button>
      {open ? <div className="mt-1 flex flex-col gap-2 pb-1">{children}</div> : null}
    </div>
  );
}

function CheckRow({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}): ReactNode {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-badge text-dim">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5"
      />
      <span>
        {label}
        {hint ? <span className="mt-0.5 block text-faint">{hint}</span> : null}
      </span>
    </label>
  );
}

export function FlowStepSettingsPanel({
  step,
  allSteps,
}: {
  step: FlowStep;
  allSteps: readonly FlowStep[];
}): ReactNode {
  const updateFlowStep = useGraphStore((state) => state.updateFlowStep);
  const lockEdits = useCurrentWorkflowLive();
  const activeId = useDeviceStore((state) => state.activeId);
  const rawDefaults = useGraphStore((state) => rawFor(state, activeId || SCRIPT_SCOPE)?.defaults);
  const globalCfg = resolveFlowGlobalDefaults(rawDefaults);
  const params = step.params ?? {};
  const settings = readStepSettings(params);
  const [openGeneral, setOpenGeneral] = useState(true);
  const [openError, setOpenError] = useState(Boolean(settings.onError?.enabled));
  const [openLine, setOpenLine] = useState(false);

  const saveSettings = async (patch: Parameters<typeof mergeStepSettings>[1]): Promise<void> => {
    if (lockEdits) {
      return;
    }
    const next = mergeStepSettings(settings, patch);
    await updateFlowStep(step.id, { params: settingsToParams(params, next) });
  };

  const onError = settings.onError ?? {};
  const line = settings.line ?? {};
  const canPickBackLine = step.type === 'condend' || step.type === 'loopend';
  const segment: LineSegmentKind = line.segment ?? 'next';
  const mode: OnErrorMode = onError.mode ?? 'throw';

  const stepOptions = allSteps.filter((item) => item.id !== step.id);

  return (
    <div className={cn('mt-2 border-t border-line pt-2', lockEdits && 'pointer-events-none opacity-60')}>
      <div className="mb-1 text-badge text-faint">模块设置</div>

      <Section title="常规" open={openGeneral} onToggle={() => setOpenGeneral((value) => !value)}>
        <label className="block space-y-0.5 text-badge text-dim">
          <span>模板匹配等待时间 (ms)</span>
          <input
            type="number"
            min={0}
            step={1000}
            placeholder={`跟随全局 (${globalCfg.match_timeout_ms} ms)`}
            value={settings.general?.matchTimeoutMs ?? ''}
            onChange={(event) => {
              const raw = event.target.value.trim();
              const parsed = raw === '' ? null : Math.max(0, Math.round(Number(raw)));
              void saveSettings({
                general: {
                  matchTimeoutMs: parsed !== null && Number.isFinite(parsed) ? parsed : null,
                },
              });
            }}
            className="h-6 w-full rounded-sm border border-line bg-canvas px-1.5 font-mono text-badge text-fg placeholder:font-sans placeholder:text-faint focus:border-brand focus:outline-none"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-0.5 text-badge text-dim">
            <span>执行前延迟 (ms)</span>
            <input
              type="number"
              min={0}
              step={50}
              placeholder={`跟随全局 (${globalCfg.pre_action_delay_ms} ms)`}
              value={settings.general?.preDelayMs ?? ''}
              onChange={(event) => {
                const raw = event.target.value.trim();
                const parsed = raw === '' ? null : Math.max(0, Math.round(Number(raw)));
                void saveSettings({
                  general: {
                    preDelayMs: parsed !== null && Number.isFinite(parsed) ? parsed : null,
                  },
                });
              }}
              className="h-6 w-full rounded-sm border border-line bg-canvas px-1.5 font-mono text-badge text-fg placeholder:font-sans placeholder:text-faint focus:border-brand focus:outline-none"
            />
          </label>
          <label className="block space-y-0.5 text-badge text-dim">
            <span>执行后延迟 (ms)</span>
            <input
              type="number"
              min={0}
              step={50}
              placeholder={`跟随全局 (${globalCfg.post_action_delay_ms} ms)`}
              value={settings.general?.postDelayMs ?? ''}
              onChange={(event) => {
                const raw = event.target.value.trim();
                const parsed = raw === '' ? null : Math.max(0, Math.round(Number(raw)));
                void saveSettings({
                  general: {
                    postDelayMs: parsed !== null && Number.isFinite(parsed) ? parsed : null,
                  },
                });
              }}
              className="h-6 w-full rounded-sm border border-line bg-canvas px-1.5 font-mono text-badge text-fg placeholder:font-sans placeholder:text-faint focus:border-brand focus:outline-none"
            />
          </label>
        </div>
        {DEBUG_CAPABLE_STEP_TYPES.has(step.type) ? (
          <CheckRow
            label="调试模式"
            hint="使用 CSP 执行模块（部分模块如「点击」「输入文字」）；桌面端先作标记，后续引擎对齐。"
            checked={settings.general?.debug === true}
            onChange={(debug) => void saveSettings({ general: { debug } })}
          />
        ) : null}
      </Section>

      <Section title="出错时" open={openError} onToggle={() => setOpenError((value) => !value)}>
        <CheckRow
          label="启用"
          hint="启用本模块的错误处理程序"
          checked={onError.enabled === true}
          onChange={(enabled) => void saveSettings({ onError: { enabled } })}
        />
        {onError.enabled ? (
          <>
            <CheckRow
              label="重试操作"
              checked={onError.retry === true}
              onChange={(retry) => void saveSettings({ onError: { retry } })}
            />
            {onError.retry ? (
              <label className="flex items-center gap-2 text-badge text-dim">
                重试次数
                <input
                  type="number"
                  min={1}
                  max={20}
                  defaultValue={onError.retryTimes ?? 3}
                  onBlur={(event) =>
                    void saveSettings({
                      onError: { retryTimes: Math.max(1, Number(event.target.value) || 3) },
                    })
                  }
                  className="h-5 w-16 rounded-sm border border-line bg-canvas px-1"
                />
              </label>
            ) : null}
            <fieldset className="flex flex-col gap-1 text-badge text-dim">
              <legend className="text-faint">出错后</legend>
              {(
                [
                  ['throw', '抛出错误：停止工作流'],
                  ['continue', '继续流程：跳过本步继续'],
                  ['fallback', '执行回退：跳到指定模块'],
                  ['insertData', '插入数据：写入变量'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`onError-${step.id}`}
                    checked={mode === value}
                    onChange={() => void saveSettings({ onError: { mode: value } })}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            {mode === 'fallback' ? (
              <label className="flex flex-wrap items-center gap-2 text-badge text-dim">
                回退到模块
                <select
                  value={onError.fallbackStepId ?? ''}
                  onChange={(event) => void saveSettings({ onError: { fallbackStepId: event.target.value } })}
                  className="h-5 min-w-[10rem] rounded-sm border border-line bg-canvas px-1"
                >
                  <option value="">请选择</option>
                  {stepOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {flowStepTitle(item)} ({item.id})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {mode === 'insertData' ? (
              <div className="flex flex-col gap-1 text-badge text-dim">
                <label className="flex items-center gap-2">
                  写入
                  <select
                    value={onError.insertData?.target ?? 'variable'}
                    onChange={(event) =>
                      void saveSettings({
                        onError: {
                          insertData: {
                            target: event.target.value === 'table' ? 'table' : 'variable',
                          },
                        },
                      })
                    }
                    className="h-5 rounded-sm border border-line bg-canvas px-1"
                  >
                    <option value="variable">变量</option>
                    <option value="table">表（预留）</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  键名
                  <input
                    defaultValue={onError.insertData?.key ?? ''}
                    onBlur={(event) =>
                      void saveSettings({ onError: { insertData: { key: event.target.value } } })
                    }
                    className="h-5 min-w-[8rem] flex-1 rounded-sm border border-line bg-canvas px-1"
                  />
                </label>
                <label className="flex items-center gap-2">
                  值
                  <input
                    defaultValue={onError.insertData?.value ?? ''}
                    onBlur={(event) =>
                      void saveSettings({ onError: { insertData: { value: event.target.value } } })
                    }
                    className="h-5 min-w-[8rem] flex-1 rounded-sm border border-line bg-canvas px-1"
                  />
                </label>
              </div>
            ) : null}
          </>
        ) : null}
      </Section>

      <Section title="线段" open={openLine} onToggle={() => setOpenLine((value) => !value)}>
        {canPickBackLine ? (
          <label className="flex items-center gap-2 text-badge text-dim">
            选择线段
            <select
              value={segment}
              onChange={(event) =>
                void saveSettings({ line: { segment: event.target.value === 'back' ? 'back' : 'next' } })
              }
              className="h-5 rounded-sm border border-line bg-canvas px-1"
            >
              <option value="next">连到下一步</option>
              <option value="back">回跳线（back）</option>
            </select>
          </label>
        ) : (
          <p className="text-badge text-faint">样式作用于「到下一步」的连线。</p>
        )}
        <label className="flex items-center gap-2 text-badge text-dim">
          线段标签
          <input
            defaultValue={line.label ?? ''}
            onBlur={(event) => void saveSettings({ line: { label: event.target.value } })}
            className="h-5 min-w-[8rem] flex-1 rounded-sm border border-line bg-canvas px-1"
          />
        </label>
        <CheckRow
          label="动画"
          checked={line.animated === true}
          onChange={(animated) => void saveSettings({ line: { animated } })}
        />
        <label className="flex items-center gap-2 text-badge text-dim">
          线段颜色
          <input
            type="color"
            defaultValue={line.color?.startsWith('#') ? line.color : '#8b95a7'}
            onBlur={(event) => void saveSettings({ line: { color: event.target.value } })}
            className="h-5 w-10 cursor-pointer rounded-sm border border-line bg-canvas p-0"
          />
          <input
            defaultValue={line.color ?? ''}
            placeholder="#8b95a7 或留空用默认"
            onBlur={(event) => void saveSettings({ line: { color: event.target.value.trim() } })}
            className="h-5 min-w-[6rem] flex-1 rounded-sm border border-line bg-canvas px-1"
          />
        </label>
      </Section>
    </div>
  );
}
