/**
 * 「范围内随机」的示意内容：左边是当前设备画面的缩略（按录制时的宽高比画，竖屏/横屏一眼分得清），
 * 右边是读数或可编辑的归一化参数。
 */
import { type ReactNode } from 'react';

import { clampUnitCoord } from '@/features/graph/flow/flow-coord-utils';
import {
  isNormRect,
  normalizeClickRegionRect,
  resolveScreenAspect,
  screenPreviewBoxSize,
  type NormRect,
} from '@/features/graph/flow/flow-click-region';
import { cn } from '@/lib/utils';

/** 屏幕缩略较长边（px） */
const FRAME_LONG_SIDE = { compact: 56, normal: 72 } as const;

function pct(value: number): string {
  return `${Math.round(value * 10000) / 100}%`;
}

function ClickTargetFrame({
  aspect,
  compact,
  children,
  testId = 'click-region-frame',
}: {
  aspect: number;
  compact: boolean;
  children: ReactNode;
  testId?: string;
}): ReactNode {
  const { width, height } = screenPreviewBoxSize(
    aspect,
    compact ? FRAME_LONG_SIDE.compact : FRAME_LONG_SIDE.normal,
  );
  return (
    <div
      className="relative shrink-0 box-border overflow-hidden rounded-[2px] border border-brand bg-white"
      style={{ width, height }}
      data-testid={testId}
      aria-hidden
    >
      {children}
    </div>
  );
}

function RegionMetricInput({
  label,
  value,
  compact,
  inputClass,
  onChange,
}: {
  label: string;
  value: number;
  compact: boolean;
  inputClass: string;
  onChange: (next: number) => void;
}): ReactNode {
  return (
    <label className="flex min-w-0 items-center gap-0.5 text-faint">
      <span className={cn('shrink-0 text-dim', compact ? 'w-3 text-[9px]' : 'w-3.5 text-badge')}>
        {label}
      </span>
      <input
        type="number"
        min={0}
        max={1}
        step={0.01}
        className={cn(inputClass, compact ? 'h-5 w-[3.25rem] px-0.5' : 'h-5 w-14')}
        value={Number(value.toFixed(2))}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function ClickRegionPreview({
  params,
  compact = false,
  className,
  editable = false,
  inputClass,
  onRectChange,
  liveResolution,
}: {
  params: Record<string, unknown>;
  compact?: boolean;
  className?: string;
  editable?: boolean;
  inputClass?: string;
  onRectChange?: (rect: NormRect) => void;
  /** 当前连接设备分辨率，用于修正示意图宽高比 */
  liveResolution?: readonly [number, number] | null;
}): ReactNode {
  const rect = params.rect;

  if (!isNormRect(rect)) {
    return null;
  }
  const [x, y, w, h] = rect;
  const aspect = resolveScreenAspect(params, liveResolution);

  const patchRect = (patch: Partial<{ x: number; y: number; w: number; h: number }>): void => {
    if (!onRectChange) {
      return;
    }
    const next = normalizeClickRegionRect([patch.x ?? x, patch.y ?? y, patch.w ?? w, patch.h ?? h]);
    onRectChange(next);
  };

  return (
    <div
      className={cn('flex min-w-0 items-center gap-2', compact ? 'text-[10px]' : 'text-badge', className)}
      data-testid="click-region-preview"
      title="范围示意：外框 = 屏幕，蓝块 = 随机落点区域"
    >
      <ClickTargetFrame aspect={aspect} compact={compact}>
        <div
          className="absolute bg-brand"
          style={{
            left: pct(x),
            top: pct(y),
            width: pct(w),
            height: pct(h),
          }}
          data-testid="click-region-area"
        />
      </ClickTargetFrame>

      {editable && inputClass ? (
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-1.5 gap-y-0.5">
          <RegionMetricInput
            label="X"
            value={x}
            compact={compact}
            inputClass={inputClass}
            onChange={(next) => patchRect({ x: clampUnitCoord(next) })}
          />
          <RegionMetricInput
            label="Y"
            value={y}
            compact={compact}
            inputClass={inputClass}
            onChange={(next) => patchRect({ y: clampUnitCoord(next) })}
          />
          <RegionMetricInput
            label="W"
            value={w}
            compact={compact}
            inputClass={inputClass}
            onChange={(next) => patchRect({ w: Math.max(0.01, next) })}
          />
          <RegionMetricInput
            label="H"
            value={h}
            compact={compact}
            inputClass={inputClass}
            onChange={(next) => patchRect({ h: Math.max(0.01, next) })}
          />
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-wrap content-center items-baseline gap-x-2 gap-y-0.5">
          <span className="flex shrink-0 items-baseline gap-1.5">
            <span className="text-dim">区域</span>
            <span className="font-mono text-faint">
              {w.toFixed(2)} × {h.toFixed(2)}
            </span>
          </span>
          <span className="font-mono text-faint">
            X {x.toFixed(2)}–{(x + w).toFixed(2)}
          </span>
          <span className="font-mono text-faint">
            Y {y.toFixed(2)}–{(y + h).toFixed(2)}
          </span>
        </div>
      )}
    </div>
  );
}
