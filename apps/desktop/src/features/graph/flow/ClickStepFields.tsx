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
  mergeClickTargetParams,
  clickTargetMode,
  type ClickEventKind,
  type ClickTargetMode,
} from '@/features/graph/flow/flow-click-params';
import { isNormRect, type NormRect } from '@/features/graph/flow/flow-click-region';
import { resolveFlowGlobalDefaults } from '@/features/graph/flow/FlowGlobalSettingsDrawer';
import { StepSearchScope } from '@/features/graph/flow/StepSearchScope';
import { RecognizerPicker } from '@/features/recognizers/RecognizerPicker';
import { clampUnitCoord } from '@/features/graph/flow/flow-coord-utils';
import { coerceStr } from '@/lib/coerce';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { rawFor, SCRIPT_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

function optionalNumber(value: unknown): number | '' {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return '';
}

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
  const liveResolution = useSessionStore((state) =>
    activeDeviceId ? state.frames[activeDeviceId]?.resolution : undefined,
  );
  const rawDefaults = useGraphStore((state) => rawFor(state, activeDeviceId || SCRIPT_SCOPE)?.defaults);
  const globalCfg = resolveFlowGlobalDefaults(rawDefaults);
  const inputClass = cn(
    'nodrag nopan rounded-sm border border-line bg-canvas px-1 text-fg focus:border-brand focus:outline-none',
    compact ? 'h-5 min-w-0 flex-1 text-[11px]' : 'h-5 text-badge',
  );

  const setMode = (next: ClickTargetMode): void => {
    onPatch(mergeClickTargetParams(params, next));
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
            value={mode}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'recognizer' || value === 'region' || value === 'coord') {
                setMode(value);
              }
            }}
          >
            {CLICK_TARGET_MODE_OPTIONS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {showImage && mode === 'recognizer' ? (
        <div className={cn('space-y-0.5 border-t border-line pt-1.5', compact && 'text-[11px]')}>
          <RecognizerPicker
            compact={compact}
            previewSide={previewSide}
            flowStepId={stepId}
            value={coerceStr(params.rec)}
            labels={recognizerLabels}
            onChange={(rec) =>
              onPatch({
                by: CLICK_BY_RECOGNIZER,
                rec,
              })
            }
          />
          {!compact ? (
            <StepSearchScope
              value={params.search}
              onChange={(search) => onPatch({ search: search === 'auto' ? undefined : search })}
            />
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

      {showMode && compact ? (
        <div className="text-[10px] text-faint" data-testid="click-human-compact">
          拟人点击：偏移 {coerceStr(params.click_jitter_px, `全局${globalCfg.click_jitter_px}`)}px · 按下{' '}
          {coerceStr(params.tap_duration_ms, `全局${globalCfg.tap_duration_ms}`)}ms
        </div>
      ) : null}

      {showMode && !compact ? (
        <div className="space-y-1.5 border-t border-line/70 pt-1.5" data-testid="click-human-fields">
          <div className="text-faint">拟人点击</div>
          <label className="flex items-center gap-1 text-dim">
            偏移
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              data-testid="click-jitter-px"
              placeholder={`跟随全局 (${globalCfg.click_jitter_px})`}
              value={optionalNumber(params.click_jitter_px)}
              onChange={(event) => {
                const raw = event.target.value.trim();
                onPatch({
                  click_jitter_px:
                    raw === '' ? undefined : Math.min(100, Math.max(0, Math.round(Number(raw) || 0))),
                });
              }}
              className={cn(inputClass, 'w-20 flex-none')}
            />
            <span className="text-faint">px</span>
          </label>
          {eventKind !== 'long_press' ? (
            <label className="flex items-center gap-1 text-dim">
              按下
              <input
                type="number"
                min={10}
                max={2000}
                step={10}
                data-testid="click-tap-duration"
                placeholder={`跟随全局 (${globalCfg.tap_duration_ms})`}
                value={optionalNumber(params.tap_duration_ms)}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  onPatch({
                    tap_duration_ms:
                      raw === '' ? undefined : Math.min(2000, Math.max(10, Math.round(Number(raw) || 10))),
                  });
                }}
                className={cn(inputClass, 'w-20 flex-none')}
              />
              <span className="text-faint">ms</span>
            </label>
          ) : null}
          <label className="flex items-center gap-1 text-dim">
            微移
            <input
              type="number"
              min={0}
              max={40}
              step={1}
              data-testid="click-micro-px"
              placeholder={`跟随全局 (${globalCfg.click_micro_px})`}
              value={optionalNumber(params.click_micro_px)}
              onChange={(event) => {
                const raw = event.target.value.trim();
                onPatch({
                  click_micro_px:
                    raw === '' ? undefined : Math.min(40, Math.max(0, Math.round(Number(raw) || 0))),
                });
              }}
              className={cn(inputClass, 'w-20 flex-none')}
            />
            <span className="text-faint">px</span>
          </label>
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
