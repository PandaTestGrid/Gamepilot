/**
 * 一块**可以操作的投屏面**：量出画面区、把指针换算成归一化坐标、按开关决定"这次手势是控制还是录制"。
 *
 * 为什么要单独抽出来：用户报的「设备多开时候点击功能失效」——
 * 多开网格里每块瓦片只是一个 `<button onClick=setActive>`，画面区没有任何指针处理，
 * 控制模式点画面不发 `device.touch`，框选/点选也点了没反应（那套只接在单画面分支上）。
 * 单画面里其实已经写全了（黑边换算、限频、轻触/滑动判定、录制的框选与点选），
 * 抽成这一份之后**两条分支共用同一把尺子**，不会再各写一遍、各漏一半。
 *
 * 规矩（`ScreenPane.grid.test.tsx` 逐条守着）：
 *   - 坐标按**画面区**算（`object-contain` 的黑边不算画面，点黑边不响应）；
 *   - 控制模式：按下/拖动/抬手 → `touch(down/move/up)`，拖动约 60Hz 限频；
 *   - 录制模式：框选（marquee）拖矩形 / 点选（pick）取 3% 邻域 → `beginDraft`（草稿跟着**这台设备**走）；
 *   - 多开里点"不是当前设备"的那一格：**这一次手势只切设备、不发触控**（切完再点才发到它）；
 *     但如果当前设备根本不在这一屏里（掉线了），按下就直接控制 —— 否则用户点哪格都没反应，
 *     和原始 bug 同形。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { type Box, canvasRectToPixels, containBox, pointToCanvas } from '@/lib/canvas';
import { isSwipeGesture } from '@/features/device/touch-gesture';
import { useSessionStore, type FrameState } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

/** 拖动转发的最小间隔（ms）：约 60Hz，别把每个 move 事件都发一遍 */
const MOVE_THROTTLE_MS = 16;
/** 点选取落点周围 3% 的邻域 */
const PICK_SIZE = 0.03;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function liveScore(frame: FrameState | undefined): number {
  return frame?.detections?.[0]?.score ?? 0;
}

export interface ScreenSurfaceOptions {
  readonly deviceId: string;
  /** 这块面是不是"当前设备"的 */
  readonly active: boolean;
  /** 当前设备在不在这**一屏**瓦片里（多开时判断"掉线导致没有当前格"） */
  readonly activeInGrid: boolean;
  readonly frame: FrameState | undefined;
  /** 切活动设备（点这一格的头/脚栏，或按下的那一下） */
  readonly onActivate: () => void;
}

export interface ScreenSurface {
  /** 挂到"交互画面区"那层 div 上 */
  readonly viewportRef: React.RefObject<HTMLDivElement | null>;
  /** 挂到 <img> 上（要量 naturalWidth/Height 才能算黑边） */
  readonly imgRef: React.RefObject<HTMLImageElement | null>;
  /** 画面实际显示矩形（容器相对坐标）；还没量出来时是 null */
  readonly imageBox: Box | null;
  /** 正在框选出来的矩形（归一化） */
  readonly selection: readonly [number, number, number, number] | null;
  /** 整块面的视口坐标（草稿弹框定位用） */
  readonly viewportRect: { left: number; top: number } | null;
  /** 选区在视口里的矩形（草稿弹框据此翻转） */
  readonly selectionViewportRect: (
    rect: readonly [number, number, number, number],
  ) => { left: number; top: number; width: number; height: number } | null;
  /** 铺到交互画面区那层 div 上的事件 */
  readonly handlers: {
    readonly onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
    readonly onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
    readonly onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
    readonly onPointerCancel: () => void;
    readonly onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
    readonly onMouseMove: (event: React.MouseEvent<HTMLDivElement>) => void;
    readonly onMouseUp: () => void;
    readonly onMouseLeave: () => void;
  };
}

export function useScreenSurface({
  deviceId,
  active,
  activeInGrid,
  frame,
  onActivate,
}: ScreenSurfaceOptions): ScreenSurface {
  const controlMode = useUiStore((state) => state.controlMode);
  const recordMode = useUiStore((state) => state.recordMode);
  const draft = useUiStore((state) => state.draft);
  const beginDraft = useUiStore((state) => state.beginDraft);
  const touchDevice = useSessionStore((state) => state.touch);

  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imageBox, setImageBox] = useState<Box | null>(null);
  const [viewportRect, setViewportRect] = useState<{ left: number; top: number } | null>(null);

  // 画面的实际显示矩形：object-contain 会有黑边，控制/录制坐标只按画面算
  useEffect(() => {
    const container = viewportRef.current;
    if (!container) {
      return;
    }
    const measure = (): void => {
      const image = imgRef.current;
      if (!image || image.naturalWidth === 0) {
        return;
      }
      // 用 border-box（和指针事件的 getBoundingClientRect 同一参照系），
      // 否则容器那 1px 边框会让坐标差一点点
      const rect = container.getBoundingClientRect();
      const box = containBox(
        { width: rect.width, height: rect.height },
        { width: image.naturalWidth, height: image.naturalHeight },
      );
      setImageBox(box);
      setViewportRect({ left: rect.left, top: rect.top });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [frame?.index, frame?.resolution]);

  /** 指针 → 画面归一化坐标（`clamp=false` 时落在黑边上返回 null：背景不算画面） */
  const toCanvas = useCallback(
    (clientX: number, clientY: number, clamp: boolean): [number, number] | null => {
      const container = viewportRef.current;
      if (!container || !imageBox) {
        return null;
      }
      const rect = container.getBoundingClientRect();
      return pointToCanvas(imageBox, { x: clientX - rect.left, y: clientY - rect.top }, clamp);
    },
    [imageBox],
  );

  const selectionViewportRect = useCallback(
    (rect: readonly [number, number, number, number]) => {
      if (!viewportRect || !imageBox) {
        return null;
      }
      const local = canvasRectToPixels(imageBox, rect) ?? { left: 0, top: 0, width: 0, height: 0 };
      return {
        left: viewportRect.left + local.left,
        top: viewportRect.top + local.top,
        width: local.width,
        height: local.height,
      };
    },
    [imageBox, viewportRect],
  );

  /* ---------------------------------------------------------------- 控制模式 */

  const controlStart = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const lastMoveAt = useRef(0);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (recordMode !== 'off') {
      return; // 录制模式走 mouse 那一套（框选/点选）
    }
    if (!active) {
      // 多开里点别人的格子：先切过去。切完这一下就结束 —— "先切再操作"，
      // 控制关了也一样（那就是纯粹的"只切设备"）。
      onActivate();
      if (activeInGrid || !controlMode) {
        return;
      }
    }
    if (!controlMode) {
      return; // 控制关了：画面只用来切设备，不发触控
    }
    const point = toCanvas(event.clientX, event.clientY, false);
    if (!point) {
      return; // 落在黑边上：背景不算画面
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    controlStart.current = { x: point[0], y: point[1], moved: false };
    lastMoveAt.current = 0;
    touchDevice(deviceId, 'down', point[0], point[1]);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = controlStart.current;
    if (!start) {
      return;
    }
    const point = toCanvas(event.clientX, event.clientY, true);
    if (!point) {
      return;
    }
    // 手势判定用**合位移**（轻触时手抖 1px 也会发 move，按 move 判会把轻触误判成滑动）
    if (!start.moved && isSwipeGesture([start.x, start.y], point)) {
      start.moved = true;
    }
    const now = performance.now();
    if (now - lastMoveAt.current < MOVE_THROTTLE_MS) {
      return;
    }
    lastMoveAt.current = now;
    touchDevice(deviceId, 'move', point[0], point[1]);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = controlStart.current;
    controlStart.current = null;
    if (!start || !controlMode || recordMode !== 'off') {
      return;
    }
    const point = toCanvas(event.clientX, event.clientY, true) ?? [start.x, start.y];
    touchDevice(deviceId, 'up', point[0], point[1]);
  };

  const onPointerCancel = (): void => {
    const start = controlStart.current;
    controlStart.current = null;
    if (start) {
      touchDevice(deviceId, 'up', start.x, start.y);
    }
  };

  /* ---------------------------------------------------------------- 录制模式 */

  const [selection, setSelection] = useState<readonly [number, number, number, number] | null>(null);
  const dragStart = useRef<[number, number] | null>(null);

  const toNormalized = (clientX: number, clientY: number): [number, number] | null =>
    toCanvas(clientX, clientY, true);

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (recordMode === 'off' || draft) {
      return;
    }
    const start = toNormalized(event.clientX, event.clientY);
    if (!start) {
      return; // 画面还没量出来（或没有帧）时先不录
    }
    // 按下那一刻就切设备：接着拖出来的框属于这一格（草稿也跟着它走）
    if (!active) {
      onActivate();
    }
    dragStart.current = start;
    setSelection(null);
  };

  const onMouseMove = (event: React.MouseEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    if (!start || recordMode !== 'marquee') {
      return;
    }
    const current = toNormalized(event.clientX, event.clientY);
    if (!current) {
      return;
    }
    setSelection([
      Math.min(start[0], current[0]),
      Math.min(start[1], current[1]),
      Math.abs(current[0] - start[0]),
      Math.abs(current[1] - start[1]),
    ]);
  };

  const onMouseUp = (): void => {
    if (recordMode === 'pick' && dragStart.current) {
      const [x, y] = dragStart.current;
      beginDraft({
        rect: [clamp01(x - PICK_SIZE / 2), clamp01(y - PICK_SIZE / 2), PICK_SIZE, PICK_SIZE],
        score: liveScore(frame),
      });
      dragStart.current = null;
      return;
    }
    if (selection && selection[2] > 0.01 && selection[3] > 0.01) {
      beginDraft({ rect: selection, score: liveScore(frame) });
    }
    dragStart.current = null;
    setSelection(null);
  };

  return {
    viewportRef,
    imgRef,
    imageBox,
    selection,
    viewportRect,
    selectionViewportRect,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onMouseDown,
      onMouseMove,
      onMouseUp,
      onMouseLeave: onMouseUp,
    },
  };
}
