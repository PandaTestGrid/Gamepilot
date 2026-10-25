import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

export interface FrameTimelineProps {
  readonly indices: readonly number[];
  readonly cursor: number;
  readonly disabled?: boolean;
  readonly recording?: boolean;
  readonly fps?: number;
  readonly thumbnails?: ReadonlyMap<string, string>;
  readonly recordingId?: string;
  readonly onRequestThumbnail?: (frame: number, recordingId?: string) => void | Promise<void>;
  readonly onSeek: (position: number) => void;
  readonly sliderTestId?: string;
}

const FRAME_WIDTH = 76;
const FRAME_STEP = 78;
const TRACK_PADDING = 4;
const OVERSCAN = 2;
const EMPTY_INDICES: readonly number[] = [];

/** 帧跨度 / 录制时冻结的 fps → `0.8s`；没有可用 fps 时返回 null。 */
export function takeDurationText(indices: readonly number[], recordedFps?: number): string | null {
  const first = indices[0];
  const last = indices.at(-1);
  if (indices.length < 2 || first === undefined || last === undefined || !recordedFps || recordedFps <= 0) {
    return null;
  }
  return `${((last - first) / recordedFps).toFixed(1)}s`;
}

/** 全帧连续轨道，只挂载视口附近的格子；刻度、胶片和滚动条各占独立区域。 */
export const FrameTimeline = memo(function FrameTimeline({
  indices = EMPTY_INDICES,
  cursor,
  disabled = false,
  recording = false,
  fps,
  thumbnails,
  recordingId,
  onRequestThumbnail,
  onSeek,
  sliderTestId = 'yolo-frame-slider',
}: FrameTimelineProps): ReactNode {
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const lastSeekRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ left: 0, width: 800 });
  const total = indices.length;
  const max = Math.max(0, total - 1);
  const clampedCursor = Math.min(max, Math.max(0, cursor));
  const contentWidth = Math.max(8, TRACK_PADDING * 2 + total * FRAME_STEP - 2);

  const syncScroll = useCallback((left: number): void => {
    const track = trackRef.current;
    const scrollbar = scrollRef.current;
    if (!track || !scrollbar) return;
    track.scrollLeft = left;
    if (scrollbar.scrollLeft !== left) scrollbar.scrollLeft = left;
    const width = track.clientWidth || 800;
    // 亚像素滚动直接交给浏览器；只有跨过一个格子才重新渲染虚拟窗口。
    setViewport((previous) =>
      Math.floor(previous.left / FRAME_STEP) === Math.floor(left / FRAME_STEP) && previous.width === width
        ? previous
        : { left, width },
    );
  }, []);

  useEffect(() => {
    const element = trackRef.current;
    if (!element) return;
    const measure = (): void => syncScroll(element.scrollLeft);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [syncScroll]);

  useEffect(() => {
    syncScroll(0);
  }, [recordingId, syncScroll]);

  useEffect(() => {
    const element = trackRef.current;
    // 录制只追加帧，不追赶末尾、不抢走用户正在浏览的位置。
    if (recording || !element || element.clientWidth === 0) return;
    const left = TRACK_PADDING + clampedCursor * FRAME_STEP;
    const right = left + FRAME_WIDTH + TRACK_PADDING;
    if (left < element.scrollLeft) syncScroll(Math.max(0, left - TRACK_PADDING));
    else if (right > element.scrollLeft + element.clientWidth) syncScroll(right - element.clientWidth);
    // 帧数增长不应触发自动跟随，只有明确选帧/播放推进才滚动。
  }, [clampedCursor, recordingId, recording, syncScroll]);

  const firstVisible = Math.max(0, Math.floor(viewport.left / FRAME_STEP) - OVERSCAN);
  const lastVisible = Math.min(total, Math.ceil((viewport.left + viewport.width) / FRAME_STEP) + OVERSCAN);
  const cells = [];
  for (let position = firstVisible; position < lastVisible; position += 1) {
    const frame = indices[position];
    if (frame !== undefined) cells.push({ frame, position });
  }

  const queueRef = useRef<Array<{ frame: number; key: string; recordingId?: string }>>([]);
  const activeRef = useRef(new Set<string>());
  const attemptedRef = useRef(new Set<string>());
  const wantedRef = useRef(new Set<string>());
  const requestRef = useRef(onRequestThumbnail);
  requestRef.current = onRequestThumbnail;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueRef.current = [];
    };
  }, []);

  useEffect(() => {
    const prefix = recordingId ?? 'buffer';
    const wanted = new Set<string>();
    const next = [];
    for (let position = firstVisible; position < lastVisible; position += 1) {
      const frame = indices[position];
      if (frame === undefined) continue;
      const key = `${prefix}:${frame}`;
      wanted.add(key);
      if (thumbnails?.has(key)) {
        attemptedRef.current.delete(key);
      } else if (!activeRef.current.has(key) && !attemptedRef.current.has(key)) {
        next.push({ frame, key, recordingId });
      }
    }
    wantedRef.current = wanted;
    // 离开视口即释放请求记忆，回滚可重取被淘汰/曾失败的缩略图。
    for (const key of attemptedRef.current) {
      if (!wanted.has(key)) attemptedRef.current.delete(key);
    }
    queueRef.current = next;
    const pump = (): void => {
      while (
        mountedRef.current &&
        requestRef.current &&
        activeRef.current.size < 2 &&
        queueRef.current.length
      ) {
        const item = queueRef.current.shift();
        if (!item || !wantedRef.current.has(item.key)) continue;
        activeRef.current.add(item.key);
        attemptedRef.current.add(item.key);
        void Promise.resolve()
          .then(() => requestRef.current?.(item.frame, item.recordingId))
          .catch(() => undefined)
          .finally(() => {
            activeRef.current.delete(item.key);
            pump();
          });
      }
    };
    pump();
  }, [firstVisible, lastVisible, indices, thumbnails, recordingId, onRequestThumbnail]);

  const seekAt = (clientX: number): void => {
    const element = trackRef.current;
    if (!element || disabled || total === 0) return;
    const x = clientX - element.getBoundingClientRect().left + element.scrollLeft - TRACK_PADDING;
    const next = Math.min(max, Math.max(0, Math.floor(x / FRAME_STEP)));
    if (lastSeekRef.current === next) return;
    lastSeekRef.current = next;
    onSeek(next);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || total === 0 || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    draggingRef.current = true;
    lastSeekRef.current = null;
    seekAt(event.clientX);
  };
  const endDrag = (): void => {
    draggingRef.current = false;
    lastSeekRef.current = null;
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (disabled || total === 0) return;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? max
          : event.key === 'ArrowLeft'
            ? Math.max(0, clampedCursor - 1)
            : event.key === 'ArrowRight'
              ? Math.min(max, clampedCursor + 1)
              : null;
    if (next !== null) {
      event.preventDefault();
      onSeek(next);
    }
  };
  const currentFrame = indices[clampedCursor];

  return (
    <div
      data-testid="yolo-frame-timeline"
      className="flex h-full min-h-0 min-w-0 select-none flex-col border border-line bg-canvas"
    >
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="帧时间轴"
        aria-disabled={disabled || total === 0}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={clampedCursor}
        aria-valuetext={currentFrame === undefined ? '无帧' : `第 ${currentFrame} 帧`}
        data-testid="yolo-timeline-track"
        onScroll={(event) => syncScroll(event.currentTarget.scrollLeft)}
        onKeyDown={onKeyDown}
        onWheel={(event) => {
          if (event.ctrlKey || !scrollRef.current) return;
          syncScroll(
            Math.max(
              0,
              Math.min(
                contentWidth - (trackRef.current?.clientWidth || viewport.width),
                scrollRef.current.scrollLeft + (event.deltaX || event.deltaY),
              ),
            ),
          );
        }}
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden focus-visible:outline-1 focus-visible:outline-brand"
      >
        <div
          data-testid="yolo-timeline-content"
          className="relative h-full min-w-full"
          style={{ width: contentWidth }}
        >
          <div
            data-testid="yolo-timeline-ruler"
            className="absolute inset-x-0 top-0 h-5 border-b border-line text-[10px] tabular-nums text-faint"
          >
            {cells
              .filter(({ position }) => position % 2 === 0)
              .map(({ frame, position }) => (
                <span
                  key={frame}
                  className="absolute top-0 h-full border-l border-line pl-1"
                  style={{ left: TRACK_PADDING + position * FRAME_STEP }}
                >
                  {fps && fps > 0 ? `${(position / fps).toFixed(2)}s` : `${position + 1} 帧`}
                </span>
              ))}
          </div>
          <div data-testid="yolo-timeline-filmstrip" className="absolute inset-x-0 top-6 bottom-1">
            {cells.map(({ frame, position }) => {
              const url = thumbnails?.get(`${recordingId ?? 'buffer'}:${frame}`);
              return (
                <div
                  key={`${recordingId ?? 'buffer'}:${frame}`}
                  data-testid="yolo-timeline-thumb"
                  data-position={position}
                  data-selected={position === clampedCursor}
                  title={`第 ${frame} 帧`}
                  className={cn(
                    'absolute inset-y-0 overflow-hidden bg-raised',
                    position === clampedCursor && 'outline-1 -outline-offset-1 outline-brand',
                  )}
                  style={{ left: TRACK_PADDING + position * FRAME_STEP, width: FRAME_WIDTH }}
                >
                  {url ? (
                    <span
                      className="absolute inset-0 bg-contain bg-center bg-no-repeat"
                      style={{ backgroundImage: `url(${url})` }}
                      aria-hidden="true"
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
          {total > 0 ? (
            <div
              data-testid="yolo-timeline-playhead"
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 z-10 w-px bg-brand"
              style={{ left: TRACK_PADDING + clampedCursor * FRAME_STEP }}
            >
              <span className="absolute -left-1 top-0 h-2 w-2 bg-brand" />
            </div>
          ) : (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-badge text-faint">
              还没有录制 · 点录制开始
            </span>
          )}
          <div
            data-testid="yolo-timeline-hit"
            className={cn(
              'absolute inset-0 touch-pan-x',
              disabled ? 'cursor-not-allowed' : 'cursor-ew-resize',
            )}
            onPointerDown={onPointerDown}
            onPointerMove={(event) => {
              if (draggingRef.current) seekAt(event.clientX);
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        </div>
      </div>
      <div
        ref={scrollRef}
        data-testid="yolo-timeline-scrollbar"
        aria-label="横向浏览录制帧"
        className="h-4 shrink-0 overflow-x-scroll overflow-y-hidden border-t border-line bg-panel"
        onScroll={(event) => syncScroll(event.currentTarget.scrollLeft)}
      >
        <div className="h-px" style={{ width: contentWidth }} />
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={clampedCursor}
        data-testid={sliderTestId}
        aria-label="帧进度"
        disabled={disabled || total === 0}
        onChange={(event) => onSeek(Number(event.target.value))}
        className="sr-only"
      />
    </div>
  );
});
