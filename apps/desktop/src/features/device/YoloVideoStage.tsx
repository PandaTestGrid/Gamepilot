import type { PointerEvent as ReactPointerEvent, RefObject, ReactNode } from 'react';

import type { YoloPreviewDet } from '@/lib/rpc';
import { cn } from '@/lib/utils';

export interface VideoMark {
  readonly id: string;
  readonly rect: readonly [number, number, number, number];
  readonly label: string;
  readonly color: string;
  readonly enabled: boolean;
}

export interface VideoPreview {
  readonly dets: readonly YoloPreviewDet[];
  readonly ms: number;
}

export function YoloVideoStage({
  frameAreaRef,
  boxRef,
  fitBox,
  displayUrl,
  marks,
  roi,
  preview,
  previewDevice,
  running,
  inputMode,
  isEditMode,
  dragging,
  resW,
  resH,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onRetry,
}: {
  frameAreaRef: RefObject<HTMLDivElement | null>;
  boxRef: RefObject<HTMLDivElement | null>;
  fitBox: { left: number; top: number; width: number; height: number } | null;
  displayUrl?: string | null;
  marks: readonly VideoMark[];
  roi: readonly [number, number, number, number] | null;
  preview: VideoPreview | null;
  previewDevice: string | null;
  running: boolean;
  inputMode: 'mark' | 'roi' | 'control';
  isEditMode: boolean;
  dragging: readonly [number, number, number, number] | null;
  resW: number;
  resH: number;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onRetry: () => void;
}): ReactNode {
  return (
    <div
      ref={frameAreaRef}
      data-testid="yolo-example-frame"
      className={cn(
        'relative min-h-[140px] w-full flex-1 select-none overflow-hidden bg-canvas transition-colors',
        inputMode === 'control' && 'ring-1 ring-inset ring-brand/70',
      )}
    >
      {displayUrl && fitBox ? (
        <div
          ref={boxRef}
          className="absolute"
          style={{ left: fitBox.left, top: fitBox.top, width: fitBox.width, height: fitBox.height }}
        >
          <img
            src={displayUrl}
            alt={running ? '实时画面' : '冻结画面'}
            draggable={false}
            className="h-full w-full object-contain"
          />
          {preview?.dets.map((det, index) => (
            <div
              key={`d${index}`}
              className="pointer-events-none absolute border border-confirmed bg-confirmed/10"
              style={{
                left: `${(det.bbox[0] / resW) * 100}%`,
                top: `${(det.bbox[1] / resH) * 100}%`,
                width: `${((det.bbox[2] - det.bbox[0]) / resW) * 100}%`,
                height: `${((det.bbox[3] - det.bbox[1]) / resH) * 100}%`,
              }}
            >
              <span className="absolute -top-4 left-0 rounded-[2px] bg-confirmed px-1 text-[9px] leading-4 whitespace-nowrap text-[#0b0d12]">
                {det.class} {det.conf.toFixed(2)}
              </span>
            </div>
          ))}
          {roi ? (
            <div className="pointer-events-none absolute border-2 border-brand" style={{ left: `${roi[0] * 100}%`, top: `${roi[1] * 100}%`, width: `${roi[2] * 100}%`, height: `${roi[3] * 100}%` }} />
          ) : null}
          {marks.map((mark) => (
            <div
              key={mark.id}
              className="pointer-events-none absolute border-2"
              style={{
                left: `${mark.rect[0] * 100}%`,
                top: `${mark.rect[1] * 100}%`,
                width: `${mark.rect[2] * 100}%`,
                height: `${mark.rect[3] * 100}%`,
                borderColor: mark.color,
                backgroundColor: `${mark.color}1a`,
                opacity: running ? 0.25 : mark.enabled ? 1 : 0.35,
              }}
            >
              <span
                className="absolute bottom-0 left-0 rounded-[2px] px-1 text-[9px] leading-4 whitespace-nowrap text-[#0b0d12]"
                style={{ backgroundColor: mark.color }}
              >
                {mark.label}
              </span>
            </div>
          ))}
          {dragging ? (
            <div
              className="pointer-events-none absolute border border-dashed border-brand bg-brand/10"
              style={{
                left: `${dragging[0] * 100}%`,
                top: `${dragging[1] * 100}%`,
                width: `${dragging[2] * 100}%`,
                height: `${dragging[3] * 100}%`,
              }}
            />
          ) : null}
          <div
            data-testid="yolo-draw-layer"
            className={cn(
              'absolute inset-0 touch-none',
              inputMode === 'control'
                ? 'cursor-pointer'
                : running
                  ? 'pointer-events-none'
                  : 'cursor-crosshair',
            )}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
          {inputMode === 'control' ? (
            <div className="pointer-events-none absolute bottom-2 left-2 rounded-sm border border-brand/40 bg-panel/90 px-2 py-1 text-badge font-medium text-brand">
              控制中：点击 = 轻触 · 拖动 = 滑动
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-badge text-faint">
          还没有画面：先连接设备，等画面出来
          <button
            type="button"
            onClick={onRetry}
            className="h-7 rounded-sm border border-line px-3 text-dim hover:bg-raised hover:text-fg"
          >
            重试取画面
          </button>
        </div>
      )}
      <div className="pointer-events-none absolute right-2 top-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] leading-none',
            running
              ? 'border-confirmed/40 bg-panel/90 text-confirmed'
              : inputMode === 'control'
                ? 'border-brand/40 bg-panel/90 text-brand'
                : 'border-line bg-panel/90 text-dim',
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              running ? 'animate-pulse bg-confirmed' : inputMode === 'control' ? 'bg-brand' : 'bg-idle',
            )}
          />
          {running
            ? '实时检测'
            : inputMode === 'control'
              ? '控制中'
              : isEditMode
                ? '参考帧 · 可继续框示例'
                : '已冻结（拖框取材）'}
        </span>
      </div>
      {displayUrl && marks.length === 0 && !running && inputMode === 'mark' ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <span className="rounded-sm border border-brand/40 bg-panel/90 px-2.5 py-1 text-badge leading-none text-brand">
            拖动框住目标 → 生成示例
          </span>
        </div>
      ) : null}
      {preview ? (
        <div className="pointer-events-none absolute right-2 top-10 rounded-sm border border-line bg-panel/90 px-1.5 py-0.5 text-[10px] leading-none text-dim">
          {running ? '' : '上次 '}
          {preview.dets.length} 个目标 · {preview.ms.toFixed(0)}ms{previewDevice ? ` · ${previewDevice}` : ''}
        </div>
      ) : running ? (
        <div className="pointer-events-none absolute right-2 top-10 rounded-sm bg-panel/90 px-1.5 py-0.5 text-[10px] leading-none text-faint">
          等待第一帧…
        </div>
      ) : null}
    </div>
  );
}
