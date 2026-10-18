/**
 * 单个步骤模块卡片（React Flow nodeType = flowStep）。
 */
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { Play, Square, Trash2 } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';

import { FlowStepIcon } from './flow-step-icons';
import { CallStepFields } from '@/features/graph/flow/CallStepFields';
import { ClickStepFields } from '@/features/graph/flow/ClickStepFields';
import { CondStepFields } from '@/features/graph/flow/CondStepFields';
import { LoopStepFields } from '@/features/graph/flow/LoopStepFields';
import { DelayStepFields } from '@/features/graph/flow/DelayStepFields';
import { KeyStepFields } from '@/features/graph/flow/KeyStepFields';
import { SwipeStepFields } from '@/features/graph/flow/SwipeStepFields';
import { SetvarStepFields } from '@/features/graph/flow/SetvarStepFields';
import { TextStepFields } from '@/features/graph/flow/TextStepFields';
import { TriggerStepFields } from '@/features/graph/flow/TriggerStepFields';
import type { FlowStepNodeType } from '@/features/graph/flow/flow-layout';
import { flowLoopRunningTitle } from '@/features/graph/flow/flow-loop-progress';
import { sourcePortsForStepType } from '@/features/graph/flow/flow-step-ports';
import { acceptModuleDrag, isModuleDragEvent, readModuleDragData } from '@/features/graph/flow/module-drag';
import { useFlowDropTarget } from '@/features/graph/flow/useFlowDropTarget';
import { FLOW_EDIT_LOCKED_HINT } from '@/lib/flow-edit-lock';
import { useCurrentWorkflowLive, useCurrentWorkflowRunning } from '@/lib/useLiveWorkflow';
import { mergeStepParams } from '@/lib/merge-step-params';
import { taskName } from '@/features/graph/task-name';
import { RecognizerPicker } from '@/features/recognizers/RecognizerPicker';
import { coerceStr } from '@/lib/coerce';
import { cn } from '@/lib/utils';
import { activeDevice, useDeviceStore } from '@/stores/device.store';
import { graphForDevice, useGraphStore } from '@/stores/graph.store';
import { useLibraryStore } from '@/stores/library.store';
import { useSessionStore } from '@/stores/session.store';

export function FlowStepNode({ data, selected }: NodeProps<FlowStepNodeType>): ReactNode {
  const { step } = data;
  const { dropTargetId, setDropTargetId } = useFlowDropTarget();
  const isDropTarget = dropTargetId === step.id;
  const insertFlowModuleAfter = useGraphStore((state) => state.insertFlowModuleAfter);
  const selectNode = useGraphStore((state) => state.selectNode);
  const removeFlowStep = useGraphStore((state) => state.removeFlowStep);
  const updateFlowStep = useGraphStore((state) => state.updateFlowStep);
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const device = activeDevice(devices, activeId);
  const deviceKind = device?.kind;
  const canRun = device?.status === 'connected';
  const sessionRunning = useCurrentWorkflowRunning();
  const lockEdits = useCurrentWorkflowLive();
  const runningStartStep = useSessionStore((state) =>
    activeId ? (state.runningStartStep[activeId] ?? null) : null,
  );
  const loopLive = useSessionStore((state) =>
    activeId ? (state.loopProgress[activeId]?.[step.id] ?? null) : null,
  );
  const pausedAt = useSessionStore((state) => (activeId ? (state.paused[activeId] ?? null) : null));
  const hasBreakpoint = useSessionStore((state) =>
    activeId ? (state.breakpoints[activeId]?.includes(step.id) ?? false) : false,
  );
  const isPausedHere = pausedAt === step.id;
  // 触发器上的方块 = 停止整条工作流；绿色高亮（flow-step-running）只看引擎报的当前步骤 data.running
  const showWorkflowStop = sessionRunning && data.isTrigger;
  const showStepStop =
    sessionRunning && !data.isTrigger && (Boolean(data.running) || runningStartStep === step.id);
  const isStepRunning = showWorkflowStop || showStepStop;
  const startRun = useSessionStore((state) => state.startRun);
  const stopRun = useSessionStore((state) => state.stopRun);
  const workflows = useLibraryStore((state) => state.workflows);
  const currentWorkflowRoot = useSessionStore((state) => state.currentWorkflow?.root ?? '');
  const currentWorkflowName = useMemo(() => {
    const matched = workflows.find((item) => item.root === currentWorkflowRoot);
    return matched?.name ?? (currentWorkflowRoot ? taskName(currentWorkflowRoot) : '');
  }, [workflows, currentWorkflowRoot]);
  const graph = useGraphStore((state) => graphForDevice(state, activeId));
  const recognizerLabels = useMemo(
    () => (graph?.recognizers ?? []).map((item) => item.label),
    [graph?.recognizers],
  );
  const params = useMemo(() => ({ ...(step.params ?? {}) }), [step.params]);

  // 这一步骤引用的识别器如果是 OCR，标题下面补一行"读哪段字"。
  // OCR 的名字（region_7 之类）只是标签，真正决定它认什么的是文字；不写出来用户没法核对。
  const ocrSummary = useMemo(() => {
    const rec = typeof params.rec === 'string' ? params.rec : '';
    if (!rec) {
      return '';
    }
    const referenced = graph?.recognizers.find((item) => item.label === rec);
    if (referenced?.type !== 'ocr' || !referenced.text) {
      return '';
    }
    return `读「${referenced.text}」`;
  }, [graph?.recognizers, params.rec]);

  const patchParams = (patch: Record<string, unknown>): void => {
    if (lockEdits) {
      return;
    }
    void updateFlowStep(step.id, { params: mergeStepParams(params, patch) });
  };

  const ports = sourcePortsForStepType(step.type);
  const isClickStep = (step.type === 'click' || step.type === 'hold') && !data.isTrigger;
  const isSwipeStep = step.type === 'swipe' && !data.isTrigger;
  const isWaitStep = step.type === 'wait' && !data.isTrigger;
  const isDelayStep = step.type === 'delay' && !data.isTrigger;
  const isKeyStep = step.type === 'key' && !data.isTrigger;
  const isCondStep = step.type === 'cond' && !data.isTrigger;
  const isLoopStep = step.type === 'loop' && !data.isTrigger;
  const isTextStep = step.type === 'text' && !data.isTrigger;
  const isCallStep = step.type === 'call' && !data.isTrigger;
  const isSetvarStep = step.type === 'setvar' && !data.isTrigger;
  const hasInlinePanel =
    data.isTrigger ||
    isClickStep ||
    isSwipeStep ||
    isWaitStep ||
    isDelayStep ||
    isKeyStep ||
    isCondStep ||
    isLoopStep ||
    isTextStep ||
    isCallStep ||
    isSetvarStep;
  const fieldWrapClass = cn(
    'nodrag nopan mt-2 border-t border-line pt-1.5',
    lockEdits && 'pointer-events-none opacity-60',
  );

  return (
    <div
      data-flow-step-id={step.id}
      onDragOver={(event) => {
        if (isModuleDragEvent(event)) {
          acceptModuleDrag(event);
          event.stopPropagation();
          setDropTargetId(step.id);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropTargetId(null);
        }
      }}
      onDrop={(event) => {
        const module = readModuleDragData(event.dataTransfer);
        setDropTargetId(null);
        if (!module || lockEdits) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void insertFlowModuleAfter(step.id, module).then((newId) => {
          if (newId) {
            selectNode(newId);
          }
        });
      }}
      className={cn(
        // flow-step-card：见 graph.css —— 节点内禁用 transition，避免 WKWebView
        // 在悬停过渡时把节点提升为合成层、把文字重新栅格化（闪/抖）
        'flow-step-card group relative min-w-[200px] rounded-sm px-2.5 py-2 text-fg shadow-sm transition-colors',
        isCondStep ? 'max-w-[228px]' : hasInlinePanel ? 'max-w-[300px]' : 'max-w-[260px]',
        isLoopStep ? 'pb-3' : '',
        data.running && !data.failed
          ? 'flow-step-running'
          : cn('border bg-panel', selected ? 'border-brand ring-1 ring-brand/40' : 'border-line'),
        data.failed ? 'border-failed ring-1 ring-failed/45 !bg-panel' : '',
        isPausedHere ? 'border-warn ring-2 ring-warn/50' : '',
        step.disabled ? 'opacity-45' : '',
        isDropTarget ? 'border-brand border-dashed bg-brand/10 ring-1 ring-brand/50' : '',
      )}
    >
      {!data.isTrigger ? (
        <Handle
          id="in"
          type="target"
          position={Position.Left}
          title={isLoopStep ? '从上一步进入循环' : '拖线到此接入上一步'}
          className="!size-2.5 !rounded-full !border !border-dim !bg-canvas hover:!border-brand hover:!bg-brand"
        />
      ) : null}
      {isLoopStep ? (
        <Handle
          id="back"
          type="target"
          position={Position.Bottom}
          title="循环体回到这里再计一次"
          style={{ left: '68%' }}
          className="!z-20 !size-3.5 !rounded-full !border !border-dim !bg-canvas hover:!border-brand hover:!bg-brand"
        />
      ) : null}
      <div className={cn('flex justify-between gap-2', data.isTrigger ? 'items-center' : 'items-start')}>
        <div className="flex min-w-0 items-start gap-1.5">
          <FlowStepIcon type={step.type} className="mt-0.5 size-3.5 shrink-0 text-dim" strokeWidth={1.75} />
          {hasBreakpoint ? (
            <span
              data-testid="flow-step-breakpoint"
              title="断点：运行到这一步会暂停（右键步骤可清除）"
              className="mt-1 size-2 shrink-0 rounded-full bg-err"
            />
          ) : null}
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              {data.isTrigger ? (
                <span className="rounded-sm bg-brand/15 px-1 text-[10px] text-brand">触发器</span>
              ) : null}
              {data.pending || data.unconnected ? (
                <span
                  title="没接进流程：从上一模块右侧的圆点拖一条线到本模块左侧的圆点。不接上，运行前会提示它没连接"
                  className="rounded-sm bg-warn/15 px-1 text-[10px] text-warn"
                >
                  未连线
                </span>
              ) : null}
            </div>
            <p className="truncate text-ui font-medium leading-snug">
              {isLoopStep && sessionRunning && loopLive ? (
                <span data-testid="flow-loop-progress" className="tabular-nums text-brand">
                  {flowLoopRunningTitle(loopLive)}
                </span>
              ) : (
                data.title
              )}
            </p>
            {ocrSummary ? (
              <p
                data-testid="flow-step-ocr-summary"
                title={`引用的识别器 ${String(params.rec)}：${ocrSummary}`}
                className="truncate text-[10px] leading-snug text-brand/90"
              >
                {ocrSummary}
              </p>
            ) : null}
            {step.type === 'loopbreak' ? (
              <p className="text-[10px] leading-snug text-faint">结束后走循环的「下一步」</p>
            ) : step.type === 'end' ? (
              <p className="text-[10px] leading-snug text-faint">到此为止 · 结束本次执行</p>
            ) : null}
          </div>
        </div>
        <div
          className={cn(
            // 别用 opacity 过渡做悬停反馈：opacity 变化会把这一块提升成合成层，
            // WebKit 会连带把节点文字重新栅格化 —— 鼠标移到节点上文字会闪/抖（实测两帧
            // 位置完全一致、只有抗锯齿灰度变了）。按钮本身已有 hover 颜色，够用。
            'nodrag nopan flex shrink-0 items-center gap-0.5',
            data.isTrigger ? 'mr-1' : '',
          )}
        >
          {/* 「跳出循环」没有出口、只能从循环体内跑到它，单跑没有意义；
              「结束」点一下就把链结束了，同样不给执行按钮 —— 都不给执行按钮 */}
          {step.type === 'loopbreak' || step.type === 'end' ? null : (
            <button
              type="button"
              data-testid="flow-step-run"
              title={
                !canRun
                  ? '请先连接设备'
                  : isStepRunning
                    ? data.isTrigger
                      ? '停止整条工作流'
                      : '停止运行'
                    : '从本模块开始运行'
              }
              aria-label={isStepRunning ? `停止运行模块 ${data.title}` : `运行模块 ${data.title}`}
              disabled={!canRun}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (!activeId || !canRun) {
                  return;
                }
                if (isStepRunning) {
                  void stopRun(activeId);
                } else {
                  void startRun(activeId, step.id);
                }
              }}
              className={cn(
                'flex items-center justify-center rounded-sm disabled:cursor-not-allowed disabled:opacity-40',
                data.isTrigger
                  ? 'size-7 border border-line bg-canvas text-dim hover:border-brand hover:bg-brand/15 hover:text-brand'
                  : 'p-0.5 text-faint hover:bg-raised hover:text-fg',
                isStepRunning && 'border-failed/50 bg-failed/15 text-failed hover:bg-failed/25',
              )}
            >
              {isStepRunning ? (
                <Square
                  className={cn('fill-current', data.isTrigger ? 'size-4' : 'size-3.5')}
                  strokeWidth={1.75}
                />
              ) : (
                <Play
                  className={cn(data.isTrigger ? 'size-4 translate-x-[0.5px]' : 'size-3.5')}
                  strokeWidth={1.75}
                />
              )}
            </button>
          )}
          {!data.isTrigger ? (
            <button
              type="button"
              title={lockEdits ? FLOW_EDIT_LOCKED_HINT : '删除此模块（自动重连上下游）'}
              aria-label={`删除模块 ${data.title}`}
              disabled={lockEdits}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (lockEdits) {
                  return;
                }
                void removeFlowStep(step.id);
              }}
              className="rounded-sm p-0.5 text-faint hover:bg-err/15 hover:text-err disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-faint"
            >
              <Trash2 className="size-3.5" strokeWidth={1.75} />
            </button>
          ) : null}
        </div>
      </div>

      {data.isTrigger ? (
        <div
          className={fieldWrapClass}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <TriggerStepFields
            stepType={step.type}
            params={params}
            compact
            onChangeTypeAndParams={(nextType, nextParams) => {
              if (lockEdits) {
                return;
              }
              void updateFlowStep(step.id, { type: nextType, params: nextParams });
            }}
            onPatchParams={patchParams}
          />
        </div>
      ) : null}

      {isClickStep ? (
        <div
          className={fieldWrapClass}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <ClickStepFields
            stepId={step.id}
            stepType={step.type}
            params={params}
            recognizerLabels={recognizerLabels}
            compact
            part="all"
            onPatch={patchParams}
          />
        </div>
      ) : null}

      {isSwipeStep ? (
        <div
          className={fieldWrapClass}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <SwipeStepFields stepId={step.id} params={params} compact onPatch={patchParams} />
        </div>
      ) : null}

      {isWaitStep ? (
        <div
          className={fieldWrapClass}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <RecognizerPicker
            compact
            flowStepId={step.id}
            value={coerceStr(params.rec)}
            labels={recognizerLabels}
            onChange={(rec) => patchParams({ rec })}
          />
        </div>
      ) : null}

      {isDelayStep ? (
        <div
          className={fieldWrapClass}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <DelayStepFields params={params} compact onPatch={patchParams} />
        </div>
      ) : null}

      {isKeyStep ? (
        <div
          className={fieldWrapClass}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <KeyStepFields params={params} deviceKind={deviceKind} compact onPatch={patchParams} />
        </div>
      ) : null}

      {isCondStep ? (
        <div
          className="nodrag nopan mt-1.5 border-t border-line pt-1"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <CondStepFields
            params={params}
            recognizerLabels={recognizerLabels}
            flowStepId={step.id}
            compact
            onPatch={patchParams}
          />
        </div>
      ) : null}

      {isLoopStep ? (
        <div
          className={fieldWrapClass}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <LoopStepFields params={params} onPatch={patchParams} />
        </div>
      ) : null}

      {isTextStep ? (
        <div
          className={fieldWrapClass}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <TextStepFields params={params} compact onPatch={patchParams} />
        </div>
      ) : null}

      {isCallStep ? (
        <div
          className={fieldWrapClass}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <CallStepFields
            params={params}
            workflows={workflows}
            currentName={currentWorkflowName}
            compact
            onPatch={patchParams}
          />
        </div>
      ) : null}

      {isSetvarStep ? (
        <div
          className={fieldWrapClass}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <SetvarStepFields params={params} compact onPatch={patchParams} />
        </div>
      ) : null}

      {ports.map((port) => {
        const onBottom = port.side === 'bottom';
        const onRight = !onBottom;
        const rightMulti = onRight && ports.filter((item) => item.side !== 'bottom').length > 1;
        const showLabel = port.showLabel ?? rightMulti;
        return (
          <div key={port.id}>
            {showLabel ? (
              <span
                style={{ top: `${port.topPercent}%` }}
                className="pointer-events-none absolute left-full ml-1.5 -translate-y-1/2 whitespace-nowrap rounded-sm border border-line bg-panel px-1 py-0.5 font-mono text-[9px] leading-tight text-dim"
              >
                {port.label}
              </span>
            ) : null}
            <Handle
              id={port.id}
              type="source"
              position={onBottom ? Position.Bottom : Position.Right}
              style={onBottom ? { left: '32%' } : rightMulti ? { top: `${port.topPercent}%` } : undefined}
              title={port.label}
              className="group/handle !z-10 !flex !size-3 !items-center !justify-center !rounded-none !border-0 !bg-transparent"
            >
              <svg
                viewBox="0 0 12 12"
                className={cn(
                  'pointer-events-none size-3 fill-canvas stroke-dim stroke-[1.6] group-hover/handle:fill-brand group-hover/handle:stroke-brand',
                  onBottom && 'rotate-90',
                )}
              >
                <polygon points="2,1.5 10.5,6 2,10.5" strokeLinejoin="round" />
              </svg>
            </Handle>
          </div>
        );
      })}
    </div>
  );
}
