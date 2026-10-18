/**
 * 录制选区框：展示（框选/点选进行中）+ 编辑（草稿确认前拖动、四角缩放）。
 *
 * 视觉：细实线框 + **四角 3px 实线加粗**（用户要的样式）。
 * 交互：整个框体可拖动位置；四角可拖动改大小。
 * - 点选（pick）保持设备像素正方形：四角缩放时按 32~320px 取方，
 *   并同步 `pickSize`，下次点选沿用新尺寸；
 * - 框选（marquee）四角自由缩放。
 */
import { type HTMLAttributes, type PointerEvent, type ReactNode, useRef } from 'react';

import { type Box, type PixelRect, canvasRectToPixels, pointToCanvas } from '@/lib/canvas';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui.store';
import type { RecordDraft } from '@/types';

export type SelectionRect = readonly [number, number, number, number];
export type SelectionCorner = 'nw' | 'ne' | 'sw' | 'se';
export type SelectionDragKind = 'move' | SelectionCorner;

const MIN_MARQUEE = 0.008;
const MIN_PICK_PX = 32;
const MAX_PICK_PX = 320;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** 整体平移，钳在画面内。 */
export function moveSelection(rect: SelectionRect, dx: number, dy: number): SelectionRect {
  const [x, y, w, h] = rect;
  return [clamp(x + dx, 0, 1 - w), clamp(y + dy, 0, 1 - h), w, h];
}

/** 框选四角自由缩放。 */
export function resizeSelection(
  rect: SelectionRect,
  corner: SelectionCorner,
  dx: number,
  dy: number,
): SelectionRect {
  const [x, y, w, h] = rect;
  const right = x + w;
  const bottom = y + h;
  let nextX = x;
  let nextY = y;
  let nextRight = right;
  let nextBottom = bottom;
  if (corner.includes('w')) {
    nextX = clamp(x + dx, 0, right - MIN_MARQUEE);
  }
  if (corner.includes('e')) {
    nextRight = clamp(right + dx, x + MIN_MARQUEE, 1);
  }
  if (corner.includes('n')) {
    nextY = clamp(y + dy, 0, bottom - MIN_MARQUEE);
  }
  if (corner.includes('s')) {
    nextBottom = clamp(bottom + dy, y + MIN_MARQUEE, 1);
  }
  return [nextX, nextY, nextRight - nextX, nextBottom - nextY];
}

/**
 * 点选四角缩放：以**对角**为锚点，在设备像素空间取正方形，
 * 再各自归一化（竖屏仍是像素方形）。返回新草稿与新的像素边长。
 */
export function resizePickSquare(
  rect: SelectionRect,
  corner: SelectionCorner,
  pointer: readonly [number, number],
  resolution: readonly [number, number],
): { rect: SelectionRect; pickCenter: readonly [number, number]; pickPx: number } {
  const [x, y, w, h] = rect;
  const right = x + w;
  const bottom = y + h;
  const [screenW, screenH] = resolution;

  // 对角（不动的那个角）
  const anchorX = corner === 'nw' || corner === 'sw' ? right : x;
  const anchorY = corner === 'nw' || corner === 'ne' ? bottom : y;
  // 从锚点指向被拖的角
  const dirX = corner === 'ne' || corner === 'se' ? 1 : -1;
  const dirY = corner === 'sw' || corner === 'se' ? 1 : -1;

  const anchorPxX = anchorX * screenW;
  const anchorPxY = anchorY * screenH;
  const pointerPxX = pointer[0] * screenW;
  const pointerPxY = pointer[1] * screenH;
  const wanted = Math.max(Math.abs(pointerPxX - anchorPxX), Math.abs(pointerPxY - anchorPxY));
  const fitX = dirX > 0 ? (1 - anchorX) * screenW : anchorX * screenW;
  const fitY = dirY > 0 ? (1 - anchorY) * screenH : anchorY * screenH;
  const pickPx = clamp(Math.min(wanted, fitX, fitY), MIN_PICK_PX, MAX_PICK_PX);

  const nextW = screenW > 0 ? pickPx / screenW : 0.1;
  const nextH = screenH > 0 ? pickPx / screenH : 0.1;
  const nextX = dirX > 0 ? anchorX : anchorX - nextW;
  const nextY = dirY > 0 ? anchorY : anchorY - nextH;
  const left = clamp(nextX, 0, 1 - nextW);
  const top = clamp(nextY, 0, 1 - nextH);
  return {
    rect: [left, top, nextW, nextH],
    pickCenter: [left + nextW / 2, top + nextH / 2],
    pickPx,
  };
}

const CORNER_CLASS: Record<SelectionCorner, string> = {
  nw: 'left-0 top-0 cursor-nwse-resize border-l-[3px] border-t-[3px]',
  ne: 'right-0 top-0 cursor-nesw-resize border-r-[3px] border-t-[3px]',
  sw: 'left-0 bottom-0 cursor-nesw-resize border-l-[3px] border-b-[3px]',
  se: 'right-0 bottom-0 cursor-nwse-resize border-r-[3px] border-b-[3px]',
};

interface SelectionFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, 'style'> {
  rectPx: PixelRect;
  label?: ReactNode;
  rootRef?: React.Ref<HTMLDivElement>;
  /** 传了某角的 handler，那一个角才可拖；否则只展示。 */
  cornerHandlers?: Partial<Record<SelectionCorner, (event: PointerEvent<HTMLSpanElement>) => void>>;
}

/** 选区的纯展示层：四角加粗实线 + 细实线框。 */
export function SelectionFrame({
  rectPx,
  label,
  rootRef,
  cornerHandlers,
  children,
  className,
  ...rest
}: SelectionFrameProps): ReactNode {
  return (
    <div
      {...rest}
      ref={rootRef}
      className={cn('pointer-events-none absolute z-20', className)}
      style={rectPx}
    >
      <div className="absolute inset-0 border border-brand/70 bg-brand/10" />
      {children}
      {(Object.keys(CORNER_CLASS) as SelectionCorner[]).map((corner) => {
        const handler = cornerHandlers?.[corner];
        return (
          <span
            key={corner}
            aria-hidden
            data-corner={corner}
            className={cn(
              'absolute size-3.5 border-brand',
              CORNER_CLASS[corner],
              handler && 'pointer-events-auto',
            )}
            onPointerDown={handler}
            onMouseDown={handler ? (event) => event.stopPropagation() : undefined}
          />
        );
      })}
      {label ? (
        <span className="absolute -bottom-4 left-0 rounded-xs bg-[#0b0d12]/70 px-1 text-badge text-brand">
          {label}
        </span>
      ) : null}
    </div>
  );
}

interface DraftSelectionBoxProps {
  imageBox: Box;
  draft: RecordDraft;
}

interface DragState {
  kind: SelectionDragKind;
  start: readonly [number, number];
  rect: SelectionRect;
  pointerId: number;
  target: HTMLElement;
}

/** 草稿选区：可拖动整体位置、四角改大小。 */
export function DraftSelectionBox({ imageBox, draft }: DraftSelectionBoxProps): ReactNode {
  const updateDraft = useUiStore((state) => state.updateDraft);
  const setPickSize = useUiStore((state) => state.setPickSize);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const rectPx = canvasRectToPixels(imageBox, draft.rect);
  if (!rectPx) {
    return null;
  }

  const toNormalized = (clientX: number, clientY: number): [number, number] | null => {
    const viewport = rootRef.current?.closest('[data-screen-viewport]');
    if (!(viewport instanceof HTMLElement)) {
      return null;
    }
    const rect = viewport.getBoundingClientRect();
    return pointToCanvas(imageBox, { x: clientX - rect.left, y: clientY - rect.top }, true);
  };

  const begin = (event: PointerEvent<HTMLElement>, kind: SelectionDragKind): void => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const start = toNormalized(event.clientX, event.clientY);
    if (!start) {
      return;
    }
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind,
      start,
      rect: draft.rect,
      pointerId: event.pointerId,
      target,
    };
  };

  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const point = toNormalized(event.clientX, event.clientY);
    if (!point) {
      return;
    }
    event.preventDefault();
    const dx = point[0] - drag.start[0];
    const dy = point[1] - drag.start[1];

    if (drag.kind === 'move') {
      const rect = moveSelection(drag.rect, dx, dy);
      const pickCenter =
        draft.mode === 'pick' ? ([rect[0] + rect[2] / 2, rect[1] + rect[3] / 2] as const) : undefined;
      updateDraft({ rect, ...(pickCenter ? { pickCenter } : {}) });
      return;
    }

    if (draft.mode === 'pick' && draft.resolution) {
      const next = resizePickSquare(drag.rect, drag.kind, point, draft.resolution);
      updateDraft({ rect: next.rect, pickCenter: next.pickCenter });
      // 下一次点选沿用这个尺寸；setPickSize 会围绕新的 pickCenter 重算，
      // 与上面算出的 rect 一致（这里先写 draft，确保它读到新中心）。
      setPickSize(next.pickPx);
      return;
    }

    updateDraft({ rect: resizeSelection(drag.rect, drag.kind, dx, dy) });
  };

  const end = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    try {
      drag.target.releasePointerCapture(drag.pointerId);
    } catch {
      // 元素已卸载/浏览器已释放：忽略
    }
  };

  const isPick = draft.mode === 'pick';
  const label =
    isPick && draft.resolution
      ? `${Math.round(draft.rect[2] * draft.resolution[0])}×${Math.round(
          draft.rect[3] * draft.resolution[1],
        )} px`
      : `${draft.rect[2].toFixed(3)} × ${draft.rect[3].toFixed(3)}`;

  return (
    <SelectionFrame
      data-testid="draft-selection-box"
      rootRef={rootRef}
      rectPx={rectPx}
      label={label}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onMouseDown={(event) => event.stopPropagation()}
      cornerHandlers={{
        nw: (event) => begin(event, 'nw'),
        ne: (event) => begin(event, 'ne'),
        sw: (event) => begin(event, 'sw'),
        se: (event) => begin(event, 'se'),
      }}
    >
      <div
        aria-hidden
        data-drag="move"
        className="pointer-events-auto absolute inset-0 cursor-move"
        onPointerDown={(event) => begin(event, 'move')}
        onMouseDown={(event) => event.stopPropagation()}
      />
    </SelectionFrame>
  );
}
