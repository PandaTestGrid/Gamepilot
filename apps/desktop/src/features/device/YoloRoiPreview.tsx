/**
 * AI 识别器的 ROI 矢量示意：外框 = 屏幕，半透明块 = 本次搜索区域。
 *
 * 和「范围内随机」的 `ClickRegionPreview` 同一套视觉语言（白底 + brand 边框 + 蓝块），
 * 但这里只读：ROI 在画面上手动画，这里负责让用户一眼确认「范围到底在哪」。
 * 屏幕比例优先用当前画面分辨率；拿不到就按 9:16 画（多数被控端是竖屏）。
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type YoloRoi = readonly [number, number, number, number];

/** 屏幕缩略较长边（px） */
const FRAME_LONG_SIDE = 72;

function pct(value: number): string {
  return `${Math.round(value * 10000) / 100}%`;
}

/** 按宽高比算缩略框尺寸（长边固定，短边按比例）。 */
function boxSize(aspect: number): { width: number; height: number } {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : 9 / 16;
  return safe >= 1
    ? { width: FRAME_LONG_SIDE, height: Math.round(FRAME_LONG_SIDE / safe) }
    : { width: Math.round(FRAME_LONG_SIDE * safe), height: FRAME_LONG_SIDE };
}

export function YoloRoiPreview({
  roi,
  resolution,
  className,
}: {
  /** 归一化 [x, y, w, h]；null = 还没设 ROI（画虚线空态） */
  roi: YoloRoi | null;
  /** 当前画面分辨率，用来决定示意图的宽高比 */
  resolution?: readonly [number, number] | null;
  className?: string;
}): ReactNode {
  const aspect = resolution && resolution[0] > 0 && resolution[1] > 0 ? resolution[0] / resolution[1] : 9 / 16;
  const { width, height } = boxSize(aspect);

  return (
    <div
      data-testid="yolo-roi-preview"
      className={cn('flex min-w-0 items-center gap-2 text-badge', className)}
      title="ROI 示意：外框 = 画面，蓝色块 = 只在其中搜索"
    >
      <div
        aria-hidden
        className={cn(
          'relative shrink-0 overflow-hidden rounded-[2px] border bg-white',
          roi ? 'border-brand' : 'border-dashed border-line bg-canvas',
        )}
        style={{ width, height }}
      >
        {roi ? (
          <div
            data-testid="yolo-roi-area"
            className="absolute border border-brand bg-brand/70"
            style={{
              left: pct(roi[0]),
              top: pct(roi[1]),
              width: pct(roi[2]),
              height: pct(roi[3]),
            }}
          />
        ) : null}
      </div>
      {roi ? (
        <div className="flex min-w-0 flex-1 flex-wrap content-center items-baseline gap-x-2 gap-y-0.5 text-faint">
          <span className="font-mono">
            {roi[2].toFixed(2)} × {roi[3].toFixed(2)}
          </span>
          <span className="font-mono">
            X {roi[0].toFixed(2)}–{(roi[0] + roi[2]).toFixed(2)}
          </span>
          <span className="font-mono">
            Y {roi[1].toFixed(2)}–{(roi[1] + roi[3]).toFixed(2)}
          </span>
        </div>
      ) : (
        <span className="min-w-0 flex-1 text-faint">未设置 ROI · 当前按全屏搜索</span>
      )}
    </div>
  );
}
