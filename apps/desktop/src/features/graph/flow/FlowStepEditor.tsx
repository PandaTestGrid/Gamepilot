/**
 * 底部选中模块的参数编辑（左：基本信息 + 动作参数；右：图像设置 / 模块设置 + 删除）。
 */
import { Play, Square } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';

import { CallStepFields } from '@/features/graph/flow/CallStepFields';
import { ClickStepFields } from '@/features/graph/flow/ClickStepFields';
import { CondStepFields } from '@/features/graph/flow/CondStepFields';
import { DelayStepFields } from '@/features/graph/flow/DelayStepFields';
import { FlowStepSettingsPanel } from '@/features/graph/flow/FlowStepSettingsPanel';
import { KeyStepFields } from '@/features/graph/flow/KeyStepFields';
import { LoopStepFields } from '@/features/graph/flow/LoopStepFields';
import { SetvarStepFields } from '@/features/graph/flow/SetvarStepFields';
import { StepSearchScope } from '@/features/graph/flow/StepSearchScope';
import { SwipeStepFields } from '@/features/graph/flow/SwipeStepFields';
import { TextStepFields } from '@/features/graph/flow/TextStepFields';
import { TriggerStepFields } from '@/features/graph/flow/TriggerStepFields';
import { isBlockMark } from '@/features/graph/flow/flow-structure';
import { flowStepTitle, isFlowHeadTriggerStep } from '@/features/graph/flow/flow-step-meta';
import { taskName } from '@/features/graph/task-name';
import { RecognizerPicker } from '@/features/recognizers/RecognizerPicker';
import { coerceStr } from '@/lib/coerce';
import { FLOW_EDIT_LOCKED_HINT } from '@/lib/flow-edit-lock';
import { useCurrentWorkflowLive, useCurrentWorkflowRunning } from '@/lib/useLiveWorkflow';
import { mergeStepParams } from '@/lib/merge-step-params';
import { activeDevice, useDeviceStore } from '@/stores/device.store';
import { graphForDevice, useGraphStore } from '@/stores/graph.store';
import { useLibraryStore } from '@/stores/library.store';
import { useSessionStore } from '@/stores/session.store';
import type { FlowStep, GraphData } from '@/types';

const inputCls =
  'h-6 w-full rounded-sm border border-line bg-canvas px-1.5 text-badge text-fg focus:border-brand focus:outline-none';

export function FlowStepEditor({ step, graph: graphProp }: { step: FlowStep; graph?: GraphData }): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const device = activeDevice(devices, activeId);
  const deviceKind = device?.kind;
  const canRun = device?.status === 'connected';
  /** 「跳出循环」没有出口：从它单跑没意义，执行按钮直接禁用 */
  const isLoopbreakStep = step.type === 'loopbreak';
  /** 「结束」跑一下就是把链结束掉，没有单跑的意义 */
  const isEndStep = step.type === 'end';
  const cannotRunAlone = isLoopbreakStep || isEndStep;
  const sessionRunning = useCurrentWorkflowRunning();
  const lockEdits = useCurrentWorkflowLive();
  const runningStartStep = useSessionStore((state) =>
    activeId ? (state.runningStartStep[activeId] ?? null) : null,
  );
  const liveStepId = useGraphStore((state) =>
    activeId ? (state.liveByDevice[activeId]?.node ?? null) : null,
  );
  const startRun = useSessionStore((state) => state.startRun);
  const stopRun = useSessionStore((state) => state.stopRun);
  const storeGraph = useGraphStore((state) => graphForDevice(state, activeId));
  const graph = graphProp ?? storeGraph;
  const updateFlowStep = useGraphStore((state) => state.updateFlowStep);
  const removeFlowStep = useGraphStore((state) => state.removeFlowStep);
  const workflows = useLibraryStore((state) => state.workflows);
  const currentWorkflowRoot = useSessionStore((state) => state.currentWorkflow?.root ?? '');
  const currentWorkflowName = useMemo(() => {
    const matched = workflows.find((item) => item.root === currentWorkflowRoot);
    return matched?.name ?? (currentWorkflowRoot ? taskName(currentWorkflowRoot) : '');
  }, [workflows, currentWorkflowRoot]);

  const steps = graph?.flow?.steps ?? [];
  const index = steps.findIndex((item) => item.id === step.id);
  const isHeadTrigger = index >= 0 && isFlowHeadTriggerStep(step, index);
  const running = sessionRunning && (isHeadTrigger || liveStepId === step.id || runningStartStep === step.id);
  const recognizerLabels = useMemo(
    () => (graph?.recognizers ?? []).map((item) => item.label),
    [graph?.recognizers],
  );
  const params = useMemo(() => ({ ...(step.params ?? {}) }), [step.params]);
  const patchParams = (patch: Record<string, unknown>): void => {
    if (lockEdits) {
      return;
    }
    void updateFlowStep(step.id, { params: mergeStepParams(params, patch) });
  };

  return (
    <div className="grid grid-cols-1 gap-3 p-2 text-badge sm:grid-cols-2" data-testid="flow-step-editor">
      <div className="min-w-0 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="font-medium text-fg">{flowStepTitle(step)}</span>
          <span className="font-mono text-[10px] text-faint">{step.id}</span>
        </div>

        {isHeadTrigger ? (
          <TriggerStepFields
            stepType={step.type}
            params={params}
            onChangeTypeAndParams={(nextType, nextParams) => {
              if (lockEdits) {
                return;
              }
              void updateFlowStep(step.id, { type: nextType, params: nextParams });
            }}
            onPatchParams={patchParams}
          />
        ) : isBlockMark(step.type) ? null : (
          <label className="flex items-center gap-1.5 text-dim">
            <input
              type="checkbox"
              checked={Boolean(step.disabled)}
              disabled={lockEdits}
              onChange={(e) => void updateFlowStep(step.id, { disabled: e.target.checked })}
            />
            {step.type === 'loop' ? '跳过整个循环' : step.type === 'cond' ? '跳过整个条件' : '跳过此模块'}
          </label>
        )}

        {step.type === 'click' || step.type === 'hold' ? (
          <ClickStepFields
            stepId={step.id}
            stepType={step.type}
            params={params}
            recognizerLabels={recognizerLabels}
            part="mode"
            onPatch={patchParams}
          />
        ) : null}

        {step.type === 'swipe' ? (
          <SwipeStepFields stepId={step.id} params={params} onPatch={patchParams} />
        ) : null}

        {step.type === 'delay' ? <DelayStepFields params={params} onPatch={patchParams} /> : null}

        {step.type === 'key' ? (
          <KeyStepFields params={params} deviceKind={deviceKind} onPatch={patchParams} />
        ) : null}

        {step.type === 'wait' ? (
          <div className="grid grid-cols-2 gap-1.5">
            <label className="block space-y-0.5">
              <span className="text-faint">超时 (ms)</span>
              <input
                type="number"
                min={100}
                step={500}
                value={Number(params.timeout_ms ?? 10000)}
                onChange={(e) => patchParams({ timeout_ms: Math.max(100, Number(e.target.value) || 10000) })}
                className={inputCls}
              />
            </label>
            <label className="block space-y-0.5">
              <span className="text-faint">稳定帧数</span>
              <input
                type="number"
                min={1}
                max={30}
                value={Number(params.stable_frames ?? 2)}
                onChange={(e) => patchParams({ stable_frames: Math.max(1, Number(e.target.value) || 2) })}
                className={inputCls}
              />
            </label>
          </div>
        ) : null}

        {step.type === 'text' ? <TextStepFields params={params} onPatch={patchParams} /> : null}

        {step.type === 'call' ? (
          <CallStepFields
            params={params}
            workflows={workflows}
            currentName={currentWorkflowName}
            onPatch={patchParams}
          />
        ) : null}

        {step.type === 'loop' ? <LoopStepFields params={params} onPatch={patchParams} /> : null}

        {step.type === 'setvar' ? <SetvarStepFields params={params} onPatch={patchParams} /> : null}

        {isEndStep ? (
          <p className="text-[10px] leading-snug text-faint">
            到此为止：执行到这里就结束本次运行，不会再走后面的步骤（条件/循环的某一支要提前收尾时用）。
          </p>
        ) : null}

        {!isHeadTrigger ? <FlowStepSettingsPanel step={step} allSteps={steps} /> : null}

        <div className="flex items-center gap-1.5 pt-1">
          <button
            type="button"
            data-testid="flow-step-editor-run"
            disabled={!canRun || cannotRunAlone}
            title={
              isLoopbreakStep
                ? '「跳出循环」没有出口，只能从循环体内跑到这里，单跑没有意义'
                : isEndStep
                  ? '「结束」单跑就是把链结束掉，没有意义'
                  : !canRun
                    ? '请先连接设备'
                    : running
                      ? '停止运行'
                      : '从本模块开始运行'
            }
            onClick={() => {
              if (!activeId || !canRun) {
                return;
              }
              if (running) {
                void stopRun(activeId);
              } else {
                void startRun(activeId, step.id);
              }
            }}
            className={
              running
                ? 'inline-flex h-6 items-center gap-1 rounded-sm border border-err/40 bg-err/10 px-2 text-badge text-err hover:bg-err/20 disabled:cursor-not-allowed disabled:opacity-40'
                : 'inline-flex h-6 items-center gap-1 rounded-sm border border-line px-2 text-badge text-ok hover:bg-ok/10 disabled:cursor-not-allowed disabled:opacity-40'
            }
          >
            {running ? (
              <>
                <Square className="size-3 fill-current" strokeWidth={1.75} />
                停止运行
              </>
            ) : (
              <>
                <Play className="size-3" strokeWidth={1.75} />
                从此模块运行
              </>
            )}
          </button>
          {!isHeadTrigger ? (
            <button
              type="button"
              disabled={lockEdits}
              title={lockEdits ? FLOW_EDIT_LOCKED_HINT : '删除此模块'}
              onClick={() => void removeFlowStep(step.id)}
              className="h-6 rounded-sm border border-line px-2 text-badge text-err hover:bg-err/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              删除模块
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-w-0 space-y-1.5 border-t border-line pt-2 @[480px]:border-t-0 @[480px]:border-l @[480px]:pt-0 @[480px]:pl-3">
        <div className="text-faint">图像配置</div>

        {step.type === 'click' || step.type === 'hold' ? (
          <ClickStepFields
            stepId={step.id}
            stepType={step.type}
            params={params}
            recognizerLabels={recognizerLabels}
            previewSide
            part="image"
            onPatch={patchParams}
          />
        ) : null}

        {step.type === 'wait' ? (
          <div className="space-y-1">
            <RecognizerPicker
              previewSide
              flowStepId={step.id}
              value={coerceStr(params.rec)}
              labels={recognizerLabels}
              onChange={(rec) => patchParams({ rec })}
            />
            <StepSearchScope
              value={params.search}
              onChange={(search) => patchParams({ search: search === 'auto' ? undefined : search })}
            />
          </div>
        ) : null}

        {step.type === 'cond' ? (
          <CondStepFields
            params={params}
            recognizerLabels={recognizerLabels}
            flowStepId={step.id}
            previewSide
            onPatch={patchParams}
          />
        ) : null}

        {step.type !== 'click' && step.type !== 'hold' && step.type !== 'wait' && step.type !== 'cond' ? (
          <p className="text-badge text-faint">此模块不需要图像配置。</p>
        ) : null}
      </div>
    </div>
  );
}
