/**
 * 点击模块：点击事件（点击 / 双击 / 长按）+ 点击方式（图像 / 坐标点 / 范围内随机）—— 画布节点与侧栏编辑器共用。
 */
import { Crosshair, MapPin, X } from 'lucide-react';
import { type ReactNode } from 'react';

import { ClickRegionPreview } from '@/features/graph/flow/ClickRegionPreview';
import {
  CLICK_BY_COORD,
  CLICK_BY_RECOGNIZER,
  CLICK_BY_REGION,
  CLICK_EVENT_OPTIONS,
  CLICK_TARGET_MODE_OPTIONS,
  clickEventKind,
  clickEventPatch,
  clickSelectValue,
  clickTargetKind,
  clickTargetMode,
  mergeClickTargetParams,
  type ClickEventKind,
  type ClickTargetKind,
  type ClickTargetMode,
} from '@/features/graph/flow/flow-click-params';
import { isNormRect, type NormRect } from '@/features/graph/flow/flow-click-region';
import { StepSearchScope } from '@/features/graph/flow/StepSearchScope';
import { StepSelectionStrategy } from '@/features/graph/flow/StepSelectionStrategy';
import { RecognizerPicker } from '@/features/recognizers/RecognizerPicker';
import { clampUnitCoord } from '@/features/graph/flow/flow-coord-utils';
import { coerceStr } from '@/lib/coerce';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { graphForDevice, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

export function ClickStepFields({
  stepId,
  stepType = 'click',
  params,
  recognizerLabels,
  onPatch,
  compact = false,
  previewSide = false,
  part = 'all',
  className,
}: {
  stepId: string;
  stepType?: string;
  params: Record<string, unknown>;
  recognizerLabels: readonly string[];
  onPatch: (patch: Record<string, unknown>) => void;
  compact?: boolean;
  /** 详情栏：图像预览放右侧 */
  previewSide?: boolean;
  /**
   * 详情坞左右分栏时拆开渲染：
   *  - `mode`：只要「点击事件」+「点击方式」+ 坐标输入（左栏）
   *  - `image`：只要图像配置（模板选择 / 录制 / 预览，右栏）
   *  - `all`：全部（画布节点里就这样用）
   */
  part?: 'all' | 'mode' | 'image';
  className?: string;
}): ReactNode {
  const mode = clickTargetMode(params);
  const eventKind = clickEventKind(params, stepType);
  const beginPickRegion = useUiStore((state) => state.beginPickClickRegionForFlowStep);
  const beginPickCoord = useUiStore((state) => state.beginPickClickCoordForFlowStep);
  const pickingRegion = useUiStore(
    (state) => state.pendingFlowClickRegionStepId === stepId && state.recordMode !== 'off',
  );
  const pickingCoord = useUiStore(
    (state) => state.pendingFlowClickCoordStepId === stepId && state.recordMode === 'pick',
  );
  const activeDeviceId = useDeviceStore((state) => state.activeId);
  const graph = useGraphStore((state) => graphForDevice(state, activeDeviceId));
  const recognizer = graph?.recognizers.find((item) => item.label === params.rec);
  const isAi = recognizer?.type === 'yolo';
  /** 识别类点击的细分：图像识别 / AI 识别（旧图没有 ai 字段时按识别器类型推断）。 */
  const kind = clickTargetKind(params, recognizer?.type);
  /**
   * 识别器选择器只列当前细分类的识别器：以前图像模板和 AI 标记图片混在同一个网格里，
   * 用户看不出点的是哪一类。没有 graph（理论上的空态）才退回父级给的整份标签。
   */
  const kindLabels = graph
    ? graph.recognizers
        .filter((item) => (kind === 'ai' ? item.type === 'yolo' : item.type !== 'yolo'))
        .map((item) => item.label)
    : recognizerLabels;
  const selectValue = clickSelectValue(params, recognizer?.type);
  const roi = recognizer?.roi;
  const aiFullScreen = isAi && (!roi || (roi[0] === 0 && roi[1] === 0 && roi[2] === 1 && roi[3] === 1));
  const liveResolution = useSessionStore((state) =>
    activeDeviceId ? state.frames[activeDeviceId]?.resolution : undefined,
  );
  const inputClass = cn(
    'nodrag nopan rounded-sm border border-line bg-canvas px-1 text-fg focus:border-brand focus:outline-none',
    compact ? 'h-5 min-w-0 flex-1 text-[11px]' : 'h-5 text-badge',
  );

  const setMode = (next: ClickTargetMode): void => {
    onPatch(mergeClickTargetParams(params, next, kind));
  };

  /** 切换「图像识别 / AI 识别」：顺手清掉不属于新细分类的识别器引用。 */
  const setKind = (next: ClickTargetKind): void => {
    const current = coerceStr(params.rec).trim();
    const currentType = graph?.recognizers.find((item) => item.label === current)?.type;
    const matches = next === 'ai' ? currentType === 'yolo' : currentType !== undefined && currentType !== 'yolo';
    onPatch({
      ...mergeClickTargetParams(params, 'recognizer', next),
      rec: matches ? current : '',
    });
  };

  const setEvent = (next: ClickEventKind): void => {
    onPatch(clickEventPatch(next, params));
  };

  const showMode = part !== 'image';
  const showImage = part !== 'mode';

  const coordInputs = (
    <div className={cn('flex flex-wrap items-center gap-1 text-dim', compact && 'text-[11px]')}>
      <span className="text-faint">归一化</span>
      <label className="flex min-w-0 items-center gap-0.5">
        <span className={cn('shrink-0 text-faint', compact ? 'w-3 text-[9px]' : 'w-3.5')}>X</span>
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          data-testid="click-coord-x"
          className={cn(inputClass, compact ? 'h-5 w-full px-0.5' : 'w-16')}
          value={Number(params.x ?? 0.5)}
          onChange={(event) =>
            onPatch({ by: CLICK_BY_COORD, rec: '', x: clampUnitCoord(Number(event.target.value)) })
          }
        />
      </label>
      <label className="flex min-w-0 items-center gap-0.5">
        <span className={cn('shrink-0 text-faint', compact ? 'w-3 text-[9px]' : 'w-3.5')}>Y</span>
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          data-testid="click-coord-y"
          className={cn(inputClass, compact ? 'h-5 w-full px-0.5' : 'w-16')}
          value={Number(params.y ?? 0.5)}
          onChange={(event) =>
            onPatch({ by: CLICK_BY_COORD, rec: '', y: clampUnitCoord(Number(event.target.value)) })
          }
        />
      </label>
    </div>
  );

  return (
    <div
      className={cn('nodrag nopan space-y-1 text-badge', className)}
      onClick={(event) => event.stopPropagation()}
      data-testid={part === 'image' ? 'click-step-image' : 'click-step-fields'}
    >
      {showMode && (
        <div className={cn('flex items-center gap-1 text-dim', compact && 'text-[11px]')}>
          <span className="shrink-0">事件</span>
          <div className="flex flex-1 gap-0.5" role="group" aria-label="点击事件">
            {CLICK_EVENT_OPTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid={`click-event-${item.id}`}
                onClick={() => setEvent(item.id)}
                className={cn(
                  'nodrag nopan flex-1 rounded-sm border px-1 py-0.5 text-center transition-colors hover:border-brand/50 hover:bg-raised',
                  compact ? 'text-[10px]' : 'text-badge',
                  eventKind === item.id
                    ? 'border-brand bg-active text-brand'
                    : 'border-line bg-canvas text-dim',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {showMode && eventKind === 'long_press' && (
        <label className={cn('flex items-center gap-1 text-dim', compact && 'text-[11px]')}>
          时长
          <input
            type="number"
            min={50}
            step={50}
            data-testid="click-duration-input"
            className={cn(inputClass, compact ? 'w-16 flex-none' : 'w-20 flex-none')}
            value={Number(params.duration_ms ?? 600)}
            onChange={(event) =>
              onPatch({
                event: 'long_press',
                duration_ms: Math.max(50, Math.round(Number(event.target.value) || 600)),
              })
            }
          />
          <span className="text-faint">ms</span>
        </label>
      )}

      {showMode && (
        <label
          className={cn('block space-y-0.5 text-dim', compact && 'text-[11px]')}
          data-testid="click-target-mode-field"
        >
          <span className="text-faint">点击方式</span>
          <select
            data-testid="click-target-mode-select"
            className={cn(inputClass, 'block w-full max-w-none')}
            value={selectValue ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'image' || value === 'ai') {
                setKind(value);
              } else if (value === 'region' || value === 'coord') {
                setMode(value);
              }
            }}
          >
            {selectValue === null && (
              <option value="" disabled>
                请选择有效点击方式
              </option>
            )}
            {CLICK_TARGET_MODE_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {mode === null && (
        <p role="alert" className="text-badge text-err">
          无效点击方式，请重新选择；旧中文协议值不再支持。
        </p>
      )}

      {showImage && mode === 'recognizer' ? (
        <div className={cn('space-y-0.5 border-t border-line pt-1.5', compact && 'text-[11px]')}>
          {!compact ? (
            <div className="flex items-center justify-between gap-2 text-faint">
              <span>{kind === 'ai' ? 'AI 识别器' : '图像识别器'}</span>
              <span className="tabular-nums">{kindLabels.length} 个</span>
            </div>
          ) : null}
          <RecognizerPicker
            compact={compact}
            previewSide={previewSide}
            flowStepId={stepId}
            value={coerceStr(params.rec)}
            labels={kindLabels}
            onChange={(rec) =>
              onPatch({
                by: CLICK_BY_RECOGNIZER,
                ai: kind === 'ai' ? true : undefined,
                rec,
              })
            }
          />
          {kindLabels.length === 0 ? (
            <p className="text-[10px] leading-snug text-faint">
              {kind === 'ai'
                ? '还没有 AI 识别器：到素材区点「新建 AI 识别器」。'
                : '还没有图像识别器：点「录制」在画面栏框选一个模板。'}
            </p>
          ) : null}
          {isAi && !compact ? (
            <p className="pt-2 text-badge font-medium text-dim">本步点击策略</p>
          ) : null}
          <StepSelectionStrategy
            compact={compact}
            value={params.strategy}
            index={params.index}
            onChange={(patch) => onPatch(patch)}
          />
          {!compact ? (
            aiFullScreen ? (
              <div data-testid="ai-search-fullscreen" className="space-y-1 pt-1 text-badge">
                <div className="flex justify-between gap-2 text-dim">
                  <span>搜索范围</span><span className="text-fg">全屏</span>
                </div>
                <p className="text-[10px] leading-snug text-dim">
                  未设置独立搜索区域；标记图片仅用于识别目标外观。
                </p>
              </div>
            ) : (
              <StepSearchScope value={params.search} onChange={(search) => onPatch({ search })} />
            )
          ) : null}
        </div>
      ) : null}

      {showMode && mode === 'coord' ? (
        <div data-testid="click-coord-field" className="space-y-1 border-t border-line pt-1.5">
          {coordInputs}
          <button
            type="button"
            data-testid="click-coord-pick"
            data-capture-keep
            title="在画面栏单击一次，落点写入坐标"
            className={cn(
              'nodrag nopan flex w-full items-center justify-center gap-1 rounded-sm border px-1.5 py-0.5 transition-colors',
              compact ? 'text-[10px]' : 'text-badge',
              pickingCoord
                ? 'border-brand bg-active text-brand'
                : 'border-line bg-canvas text-dim hover:border-brand/50 hover:bg-raised hover:text-fg',
            )}
            onClick={() => beginPickCoord(stepId)}
          >
            <MapPin className="size-3 shrink-0" strokeWidth={1.75} />
            {pickingCoord ? '在画面单击落点…' : '点选坐标'}
          </button>
        </div>
      ) : null}

      {showMode && mode === 'region' ? (
        <div data-testid="click-region-field" className="space-y-1 border-t border-line pt-1.5">
          {isNormRect(params.rect) ? (
            <ClickRegionPreview
              params={params}
              compact={compact}
              liveResolution={liveResolution}
              editable
              inputClass={inputClass}
              onRectChange={(rect: NormRect) =>
                onPatch({
                  by: CLICK_BY_REGION,
                  rec: '',
                  rect: [...rect],
                })
              }
            />
          ) : (
            <div
              data-testid="click-region-empty"
              className={cn(
                'flex min-w-0 items-center justify-center rounded-sm border border-dashed border-line px-2 py-2 text-center text-faint',
                compact ? 'text-[10px]' : 'text-badge',
              )}
            >
              在画面拖框，或先框选范围
            </div>
          )}
          <div className="flex gap-1">
            <button
              type="button"
              data-testid="click-region-pick"
              data-capture-keep
              title="在画面栏拖一个矩形，之后每次点击都落在框内随机位置"
              className={cn(
                'nodrag nopan flex min-w-0 flex-1 items-center justify-center gap-1 rounded-sm border px-1.5 py-0.5 transition-colors',
                compact ? 'text-[10px]' : 'text-badge',
                pickingRegion
                  ? 'border-brand bg-active text-brand'
                  : 'border-line bg-canvas text-dim hover:border-brand/50 hover:bg-raised hover:text-fg',
              )}
              onClick={() => beginPickRegion(stepId)}
            >
              <Crosshair className="size-3 shrink-0" strokeWidth={1.75} />
              {pickingRegion ? '在画面拖框…' : '框选范围'}
            </button>
            {isNormRect(params.rect) ? (
              <button
                type="button"
                title="清空范围，改回画面正中点击"
                className={cn(
                  'nodrag nopan flex shrink-0 items-center justify-center gap-1 rounded-sm border border-line bg-canvas px-1.5 py-0.5 text-faint hover:border-err/50 hover:bg-raised hover:text-err',
                  compact ? 'text-[10px]' : 'text-badge',
                )}
                onClick={() =>
                  onPatch({
                    by: CLICK_BY_COORD,
                    rect: undefined,
                    screenAspect: undefined,
                    preview: undefined,
                    x: 0.5,
                    y: 0.5,
                  })
                }
              >
                <X className="size-3 shrink-0" strokeWidth={1.75} />
                清除
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {part === 'image' && mode === 'coord' && (
        <p className="text-badge text-faint">
          当前是「坐标点」方式，没有图像配置；左侧把点击方式改成「图像」即可选择模板。
        </p>
      )}
      {part === 'image' && mode === 'region' && (
        <p className="text-badge text-faint">随机范围在左侧配置；在画面栏拖框后会更新示意图。</p>
      )}
    </div>
  );
}
