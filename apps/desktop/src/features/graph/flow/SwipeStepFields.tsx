/**
 * 滑动模块：
 *   - 顶部选择框分「点对点滑动」（两点直线 + 常用方向）和「连续滑动」（录制轨迹）；
 *   - 时长两种方式共用；「按住」只属于连续方式（点对点录制只记起止点与时长）；
 *   - 详细配置（非 compact）里可覆盖拟人贝塞尔轨迹；画布卡片只显示跟随/开关摘要。
 */
import { Move, Route } from 'lucide-react';
import { type ReactNode } from 'react';

import { clampUnitCoord, formatCoordPair } from '@/features/graph/flow/flow-coord-utils';
import { resolveFlowGlobalDefaults } from '@/features/graph/flow/FlowGlobalSettingsDrawer';
import {
  matchingSwipePresetId,
  parseSwipeEasing,
  parseSwipeHoldMs,
  resolveSwipeMode,
  swipeBezierMode,
  swipeTrackPointCount,
  SWIPE_EASING_OPTIONS,
  SWIPE_MODE_OPTIONS,
  SWIPE_PRESETS,
  type SwipeMode,
} from '@/features/graph/flow/flow-swipe-params';
import { cn } from '@/lib/utils';
import { useDeviceStore } from '@/stores/device.store';
import { rawFor, SCRIPT_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useUiStore } from '@/stores/ui.store';

function CoordPair({
  label,
  xKey,
  yKey,
  params,
  compact,
  inputClass,
  onPatch,
}: {
  label: string;
  xKey: 'x' | 'to_x';
  yKey: 'y' | 'to_y';
  params: Record<string, unknown>;
  compact: boolean;
  inputClass: string;
  onPatch: (patch: Record<string, unknown>) => void;
}): ReactNode {
  return (
    <div className={cn('flex flex-wrap items-center gap-1 text-dim', compact && 'text-[11px]')}>
      <span className="w-7 shrink-0 text-faint">{label}</span>
      <label className="flex items-center gap-0.5">
        X
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          className={cn(inputClass, compact ? 'w-12' : 'w-14')}
          value={Number(params[xKey] ?? 0.5)}
          onChange={(event) => onPatch({ [xKey]: clampUnitCoord(Number(event.target.value)) })}
        />
      </label>
      <label className="flex items-center gap-0.5">
        Y
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          className={cn(inputClass, compact ? 'w-12' : 'w-14')}
          value={Number(params[yKey] ?? 0.5)}
          onChange={(event) => onPatch({ [yKey]: clampUnitCoord(Number(event.target.value)) })}
        />
      </label>
    </div>
  );
}

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

export function SwipeStepFields({
  stepId,
  params,
  onPatch,
  compact = false,
  className,
}: {
  stepId: string;
  params: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
  compact?: boolean;
  className?: string;
}): ReactNode {
  const beginRecordSwipe = useUiStore((state) => state.beginRecordSwipeForFlowStep);
  const recordingSwipe = useUiStore((state) => state.pendingFlowSwipeStepId === stepId);
  const recordingMode = useUiStore((state) => state.pendingFlowSwipeMode);
  const activeId = useDeviceStore((state) => state.activeId);
  const rawDefaults = useGraphStore((state) => rawFor(state, activeId || SCRIPT_SCOPE)?.defaults);
  const globalCfg = resolveFlowGlobalDefaults(rawDefaults);
  const bezierMode = swipeBezierMode(params);
  const inputClass = cn(
    'nodrag nopan rounded-sm border border-line bg-canvas px-1 text-fg focus:border-brand focus:outline-none',
    compact ? 'h-5 text-[11px]' : 'h-5 text-badge',
  );
  const activePreset = matchingSwipePresetId(params);
  const bezierOn = bezierMode === 'on' || (bezierMode === 'global' && globalCfg.swipe_bezier);
  const trackPoints = swipeTrackPointCount(params);
  const holdMs = parseSwipeHoldMs(params);
  const mode = resolveSwipeMode(params);
  const fromLabel = formatCoordPair(params.x, params.y);
  const toLabel = formatCoordPair(params.to_x, params.to_y);
  const recordButtonClass = (active: boolean): string =>
    cn(
      'nodrag nopan flex items-center justify-center gap-1 rounded-sm border px-1.5 py-0.5 transition-colors',
      compact ? 'text-[10px]' : 'text-badge',
      active
        ? 'border-brand bg-active text-brand'
        : 'border-line bg-canvas text-dim hover:border-brand/50 hover:bg-raised hover:text-fg',
    );

  return (
    <div
      className={cn('nodrag nopan space-y-1 text-badge', className)}
      onClick={(event) => event.stopPropagation()}
      data-testid="swipe-step-fields"
    >
      <label className={cn('flex items-center gap-1 text-dim', compact && 'text-[11px]')}>
        方式
        <select
          data-testid="swipe-mode-select"
          title="点对点 = 起止两点走直线；连续 = 回放整条轨迹（录制时按住 Shift = 直线）"
          value={mode}
          onChange={(event) => {
            const next = event.target.value as SwipeMode;
            if (next === 'point') {
              // 切回点对点：留着旧轨迹/末端按住的话，回放还是会按 path 走弧线或拖住不放
              onPatch({ swipe_mode: 'point', path: undefined, hold_ms: undefined });
            } else {
              onPatch({ swipe_mode: 'track' });
            }
          }}
          className={cn(inputClass, 'min-w-0 flex-1')}
        >
          {SWIPE_MODE_OPTIONS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>

      {mode === 'point' ? (
        <>
          <div className={cn('flex flex-wrap gap-0.5', compact && 'text-[10px]')}>
            {SWIPE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() =>
                  onPatch({
                    ...preset.params,
                    duration_ms: Number(params.duration_ms ?? 300),
                    // 预设 = 标准直线滑动：留着旧轨迹的话回放还走上一把的弧线
                    path: undefined,
                  })
                }
                className={cn(
                  'nodrag nopan rounded-sm border px-1.5 py-0.5 text-dim hover:border-brand/50 hover:bg-raised',
                  activePreset === preset.id ? 'border-brand bg-active text-brand' : 'border-line bg-canvas',
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <CoordPair
            label="起点"
            xKey="x"
            yKey="y"
            params={params}
            compact={compact}
            inputClass={inputClass}
            onPatch={onPatch}
          />
          <CoordPair
            label="终点"
            xKey="to_x"
            yKey="to_y"
            params={params}
            compact={compact}
            inputClass={inputClass}
            onPatch={onPatch}
          />
        </>
      ) : null}

      <label className={cn('flex items-center gap-1 text-dim', compact && 'text-[11px]')}>
        时长
        <input
          type="number"
          min={50}
          step={50}
          className={cn(inputClass, compact ? 'w-16' : 'w-20')}
          value={Number(params.duration_ms ?? 300)}
          onChange={(event) =>
            onPatch({ duration_ms: Math.max(50, Math.round(Number(event.target.value) || 300)) })
          }
        />
        <span className="text-faint">ms</span>
      </label>

      {mode === 'track' ? (
        <>
          <label className={cn('flex items-center gap-1 text-dim', compact && 'text-[11px]')}>
            按住
            <input
              type="number"
              min={0}
              max={5000}
              step={100}
              data-testid="swipe-hold-ms"
              placeholder="0"
              title="到终点后按住不动多久（推摇杆、长按拖拽用；0 = 松手就结束）"
              className={cn(inputClass, compact ? 'w-16' : 'w-20')}
              value={optionalNumber(params.hold_ms)}
              onChange={(event) => {
                const raw = event.target.value.trim();
                onPatch({
                  hold_ms: raw === '' ? undefined : Math.min(5000, Math.max(0, Math.round(Number(raw) || 0))),
                });
              }}
            />
            <span className="text-faint">ms</span>
          </label>
          {compact ? null : (
            <div className="text-[10px] text-faint">
              到终点后不松手再停多久（推摇杆用它；0 = 松手就结束）。「录制连续」时停在终点 0.2
              秒会自动填进来。
            </div>
          )}
        </>
      ) : null}

      {mode === 'track' ? (
        trackPoints >= 3 ? (
          <div className="flex items-center gap-1 text-dim" data-testid="swipe-track">
            <SwipePathPreview path={params.path} />
            <span className="text-faint">
              连续轨迹 {trackPoints} 点{holdMs > 0 ? ` · 按住 ${holdMs}ms` : ''}
            </span>
            <button
              type="button"
              data-testid="swipe-track-clear"
              title="丢掉录下来的轨迹，重新录一条"
              className="nodrag nopan rounded-sm border border-line bg-canvas px-1.5 py-0.5 text-dim hover:border-brand/50 hover:bg-raised hover:text-fg"
              onClick={() => onPatch({ path: undefined, swipe_mode: 'track' })}
            >
              清除
            </button>
          </div>
        ) : (
          <div className="text-[10px] text-faint" data-testid="swipe-track-empty">
            还没有轨迹：点下面的「录制连续」，在画面上拖出轨迹（按住 Shift = 起止直线）。没录轨迹前，回放按{' '}
            {fromLabel} → {toLabel} 的直线走。
          </div>
        )
      ) : null}

      <div className="grid grid-cols-1 gap-1">
        {mode === 'point' ? (
          <button
            type="button"
            data-testid="swipe-record-single"
            data-capture-keep
            title="拖一下就松手：只记起止点与时长（直线，最常用）"
            className={recordButtonClass(recordingSwipe && recordingMode === 'single')}
            onClick={() => beginRecordSwipe(stepId, 'single')}
          >
            <Move className="size-3 shrink-0" strokeWidth={1.75} />
            {recordingSwipe && recordingMode === 'single' ? '单次录制中…' : '录制单次'}
          </button>
        ) : (
          <button
            type="button"
            data-testid="swipe-record-track"
            data-capture-keep
            title="拖出轨迹：记轨迹与末端按住（推摇杆）；按住 Shift = 起止直线"
            className={recordButtonClass(recordingSwipe && recordingMode === 'track')}
            onClick={() => beginRecordSwipe(stepId, 'track')}
          >
            <Route className="size-3 shrink-0" strokeWidth={1.75} />
            {recordingSwipe && recordingMode === 'track' ? '连续录制中…' : '录制连续'}
          </button>
        )}
      </div>
      {compact ? null : (
        <div className="text-[10px] text-faint">
          {mode === 'point'
            ? '点对点 = 拖一下就松手，只记起止点与时长，按直线（可开拟人贝塞尔）回放。'
            : '连续 = 拖出轨迹；按住 Shift 拖 = 起止直线；到终点先停 0.2 秒再松手会记「按住」。'}
        </div>
      )}

      {mode === 'track' ? (
        compact ? null : (
          <div className="text-[10px] text-faint" data-testid="swipe-bezier-track-note">
            连续滑动按录制的轨迹回放；有轨迹后不再套拟人贝塞尔。
          </div>
        )
      ) : compact ? (
        <div className="text-[10px] text-faint" data-testid="swipe-bezier-compact">
          拟人轨迹：
          {bezierMode === 'off'
            ? '关（直线匀速）'
            : bezierMode === 'on'
              ? '开'
              : globalCfg.swipe_bezier
                ? '跟随全局（开）'
                : '跟随全局（关）'}
        </div>
      ) : (
        <div className="space-y-1.5 border-t border-line/70 pt-1.5" data-testid="swipe-bezier-fields">
          <div className="text-faint">拟人贝塞尔轨迹</div>
          <label className="flex items-center gap-1 text-dim">
            模式
            <select
              data-testid="swipe-bezier-mode"
              value={bezierMode}
              onChange={(event) => {
                const next = event.target.value;
                if (next === 'on') {
                  onPatch({ bezier: true });
                } else if (next === 'off') {
                  onPatch({ bezier: false });
                } else {
                  onPatch({ bezier: undefined });
                }
              }}
              className={cn(inputClass, 'w-full')}
            >
              <option value="global">跟随全局（{globalCfg.swipe_bezier ? '开' : '关'}）</option>
              <option value="on">强制拟人轨迹</option>
              <option value="off">强制直线匀速</option>
            </select>
          </label>
          {bezierOn ? (
            <>
              <label className="flex items-center gap-1 text-dim">
                阶数
                <input
                  type="number"
                  min={1}
                  max={8}
                  step={1}
                  data-testid="swipe-bezier-order"
                  placeholder={`跟随全局 (${globalCfg.swipe_bezier_order})`}
                  value={optionalNumber(params.bezier_order)}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    onPatch({
                      bezier_order:
                        raw === '' ? undefined : Math.min(8, Math.max(1, Math.round(Number(raw) || 1))),
                    });
                  }}
                  className={cn(inputClass, 'w-20')}
                />
              </label>
              <label className="flex items-center gap-1 text-dim">
                波动
                <input
                  type="number"
                  min={0}
                  max={80}
                  step={1}
                  data-testid="swipe-bezier-deviation"
                  placeholder={`跟随全局 (${globalCfg.swipe_bezier_deviation_px})`}
                  value={optionalNumber(params.bezier_deviation_px)}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    onPatch({
                      bezier_deviation_px:
                        raw === '' ? undefined : Math.min(80, Math.max(0, Math.round(Number(raw) || 0))),
                    });
                  }}
                  className={cn(inputClass, 'w-20')}
                />
                <span className="text-faint">px</span>
              </label>
              <label className="flex items-center gap-1 text-dim">
                位置
                <input
                  type="number"
                  min={0.05}
                  max={0.95}
                  step={0.05}
                  data-testid="swipe-bezier-bias"
                  placeholder={`跟随全局 (${globalCfg.swipe_bezier_bias})`}
                  value={optionalNumber(params.bezier_bias)}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    onPatch({
                      bezier_bias:
                        raw === ''
                          ? undefined
                          : Math.min(0.95, Math.max(0.05, Number(Number(raw).toFixed(2)))),
                    });
                  }}
                  className={cn(inputClass, 'w-20')}
                />
              </label>
              <label className="flex items-center gap-1 text-dim">
                速度
                <select
                  data-testid="swipe-bezier-easing"
                  value={
                    typeof params.bezier_easing === 'string' || typeof params.bezier_easing === 'number'
                      ? parseSwipeEasing(params.bezier_easing)
                      : ''
                  }
                  onChange={(event) => {
                    const next = event.target.value;
                    onPatch({ bezier_easing: next === '' ? undefined : next });
                  }}
                  className={cn(inputClass, 'min-w-0 flex-1')}
                >
                  <option value="">
                    跟随全局（{SWIPE_EASING_OPTIONS.find((item) => item.id === globalCfg.swipe_easing)?.label}
                    ）
                  </option>
                  {SWIPE_EASING_OPTIONS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1 text-dim">
                摆动
                <input
                  type="number"
                  min={0}
                  max={8}
                  step={1}
                  data-testid="swipe-bezier-wobble"
                  placeholder={`跟随全局 (${globalCfg.swipe_end_wobble})`}
                  value={optionalNumber(params.bezier_end_wobble)}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    onPatch({
                      bezier_end_wobble:
                        raw === '' ? undefined : Math.min(8, Math.max(0, Math.round(Number(raw) || 0))),
                    });
                  }}
                  className={cn(inputClass, 'w-20')}
                />
                <span className="text-faint">次</span>
              </label>
              <label className="flex items-center gap-1 text-dim">
                摆幅
                <input
                  type="number"
                  min={0}
                  max={80}
                  step={1}
                  data-testid="swipe-bezier-wobble-px"
                  placeholder={`跟随全局 (${globalCfg.swipe_end_wobble_px})`}
                  value={optionalNumber(params.bezier_end_wobble_px)}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    onPatch({
                      bezier_end_wobble_px:
                        raw === '' ? undefined : Math.min(80, Math.max(0, Math.round(Number(raw) || 0))),
                    });
                  }}
                  className={cn(inputClass, 'w-20')}
                />
                <span className="text-faint">px</span>
              </label>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * 轨迹缩略图：把 `path` 原样画成一条小折线。
 *
 * 只写「连续轨迹 32 点」的话，用户没法确认录的到底是不是自己想要那条线
 * （"我说要连续滑动，怎么看起来还是单次"）；画出来一眼就能对上。
 */
function SwipePathPreview({ path }: { path: unknown }): ReactNode {
  if (!Array.isArray(path) || path.length < 2) {
    return null;
  }
  const points = path
    .map((point) =>
      Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number'
        ? `${point[0] * 100},${point[1] * 100}`
        : null,
    )
    .filter((point): point is string => point !== null);
  if (points.length < 2) {
    return null;
  }
  return (
    <svg
      data-testid="swipe-track-preview"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="h-5 w-8 shrink-0 rounded-sm border border-line bg-canvas text-brand"
    >
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
