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

import { type Box, canvasRectToPixels, containBox, pointToCanvas, screenImageSize } from '@/lib/canvas';
import { commitClickCoordPick } from '@/features/graph/flow/flow-click-coord-pick';
import { commitClickRegionPick } from '@/features/graph/flow/flow-click-region-pick';
import { commitSwipePick } from '@/features/graph/flow/flow-swipe-pick';
import {
  buildSwipeTrack,
  isSwipeGesture,
  SWIPE_MIN_DISTANCE,
  type GesturePoint,
  type GestureSample,
  type SwipeTrack,
} from '@/features/device/touch-gesture';
import { useSessionStore, type FrameState } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';

/** 拖动转发的最小间隔（ms）：约 60Hz，别把每个 move 事件都发一遍 */
const MOVE_THROTTLE_MS = 16;

/**
 * 本帧的"参考分数"：录制草稿要显示一个分，取**重叠最多的识别器分数**。
 *
 * 曾经这里取 `detections[0]`、`ScreenPane` 里取 max —— 同一个草稿在这两条路径上
 * 显示的分数不一样。现在只有这一份。
 */
export function liveScore(frame: FrameState | undefined): number {
  if (!frame || frame.detections.length === 0) {
    return 0;
  }
  return frame.detections.reduce((best, item) => Math.max(best, item.score), 0);
}

/** 一次手势的中间态。单画面据此画"轻触波纹 / 滑动轨迹"，网格不用就不传。 */
export interface SurfaceGesture {
  readonly phase: 'down' | 'move' | 'up';
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  readonly swipe: boolean;
  readonly durationMs: number;
  /**
   * 这一笔到目前为止走过的点（归一化，未简化）。
   *
   * 画面上的滑动轨迹就按它画：只给起止点的话，画出来永远是**直线**。
   * 点对点录制只写起止点，所以这里也只给两点 —— 屏幕上那条线就是会写进
   * 步骤的线；连续录制才给真实采样，不然用户会以为点对点也录下了弯线。
   */
  readonly points: readonly GesturePoint[];
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
  /** 手势进行中（按下 / 拖动 / 抬手），给"画面上的辅助"用 */
  readonly onGesture?: (gesture: SurfaceGesture) => void;
  /** 录制态鼠标位置（归一化）；不在框选态时是 null —— 十字准星用 */
  readonly onHover?: (point: [number, number] | null) => void;
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
  onGesture,
  onHover,
}: ScreenSurfaceOptions): ScreenSurface {
  const controlMode = useUiStore((state) => state.controlMode);
  const recordActionMode = useUiStore((state) => state.recordActionMode);
  const recordStep = useSessionStore((state) => state.recordStep);
  const recordMode = useUiStore((state) => state.recordMode);
  const pickSize = useUiStore((state) => state.pickSize);
  const beginDraft = useUiStore((state) => state.beginDraft);
  const touchDevice = useSessionStore((state) => state.touch);

  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imageBox, setImageBox] = useState<Box | null>(null);
  const [viewportRect, setViewportRect] = useState<{ left: number; top: number } | null>(null);

  // 画面的实际显示矩形：object-contain 会有黑边，控制/录制坐标只按画面算。
  // 转横屏后优先用帧分辨率，不要等 <img> decode（naturalWidth 会短暂停在旧竖屏）。
  useEffect(() => {
    const container = viewportRef.current;
    if (!container) {
      return;
    }
    const measure = (): void => {
      const imageSize = screenImageSize(frame?.resolution, imgRef.current);
      if (!imageSize) {
        return;
      }
      const rect = container.getBoundingClientRect();
      const box = containBox({ width: rect.width, height: rect.height }, imageSize);
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

  const controlStart = useRef<{ x: number; y: number; moved: boolean; at: number } | null>(null);
  const lastMoveAt = useRef(0);
  /** 本次按下的采样轨迹（含按下时刻），抬手时折成 path + hold_ms */
  const controlTrack = useRef<GestureSample[]>([]);

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
    const startedAt = performance.now();
    controlStart.current = { x: point[0], y: point[1], moved: false, at: startedAt };
    controlTrack.current = [{ point, at: startedAt }];
    lastMoveAt.current = 0;
    onGesture?.({ phase: 'down', from: point, to: point, swipe: false, durationMs: 0, points: [point] });
    void touchDevice(deviceId, 'down', point[0], point[1]);
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
    // 采样不受限频影响：抬手时要靠"最后一个真的动了"的时刻算按住时长
    controlTrack.current.push({ point, at: now });
    if (now - lastMoveAt.current < MOVE_THROTTLE_MS) {
      return;
    }
    lastMoveAt.current = now;
    void touchDevice(deviceId, 'move', point[0], point[1]);
    const ui = useUiStore.getState();
    // 点对点录制只写起止点；连续录制按住 Shift 时也只画起止直线 ——
    // 屏幕上那条线就是松手后会写进步骤的线。
    const straight =
      ui.pendingFlowSwipeMode === 'track' ? event.shiftKey : ui.pendingFlowSwipeMode === 'single';
    const points: GesturePoint[] =
      ui.pendingFlowSwipeStepId && straight
        ? [
            [start.x, start.y],
            [point[0], point[1]],
          ]
        : controlTrack.current.map((sample) => sample.point);
    onGesture?.({
      phase: 'move',
      from: [start.x, start.y],
      to: point,
      swipe: start.moved,
      durationMs: Math.round(now - start.at),
      points,
    });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = controlStart.current;
    controlStart.current = null;
    if (!start || !controlMode || recordMode !== 'off') {
      controlTrack.current = [];
      return;
    }
    const point = toCanvas(event.clientX, event.clientY, true) ?? [start.x, start.y];
    const releasedAt = performance.now();
    const samples = [...controlTrack.current, { point, at: releasedAt }];
    const track = buildSwipeTrack(samples);
    controlTrack.current = [];
    const completed = touchDevice(deviceId, 'up', point[0], point[1]);
    const pendingSwipeStep = useUiStore.getState().pendingFlowSwipeStepId;
    const pendingSwipeMode = useUiStore.getState().pendingFlowSwipeMode;
    const duration = Math.round(releasedAt - start.at);
    const pathPoints = samples.map((sample) => sample.point);
    // 连续录制按住 Shift：把这一笔锁成起止直线（屏幕上画的和写进步骤的都是直线）；
    // 只对待录的滑动步骤生效，别影响全局「录操作」的手势判定
    const straight = Boolean(pendingSwipeStep) && pendingSwipeMode === 'track' && event.shiftKey;
    // 带上真实走过的点：画圈时起止点几乎重合，只看合位移会把它判成轻点（录不进去）；
    // Shift 直线只看起止距离，画圈但首尾很近的就不算滑动
    const swipe = isSwipeGesture(
      [start.x, start.y],
      point,
      SWIPE_MIN_DISTANCE,
      straight ? undefined : pathPoints,
    );
    // 屏幕轨迹：点对点 / 连续+Shift 只画起止直线
    const feedbackPoints: GesturePoint[] =
      pendingSwipeStep && (pendingSwipeMode === 'single' || straight)
        ? [
            [start.x, start.y],
            [point[0], point[1]],
          ]
        : pathPoints;
    onGesture?.({
      phase: 'up',
      from: [start.x, start.y],
      to: point,
      swipe,
      durationMs: duration,
      points: feedbackPoints,
    });
    // 按下→松手之间真正在移动的时长（按住不动的那段算 hold_ms，不算滑动时长）
    const moveMs = Math.max(0, duration - track.holdMs);
    if (pendingSwipeStep) {
      if (swipe) {
        // 单次录制：只留起止点（传 undefined 会顺手清掉旧的轨迹/按住）。
        // 连续 + Shift：写一条共线三点路径（中点必须显式给，简化算法会把共线点塌回两点）。
        const straightPath: GesturePoint[] = [
          [start.x, start.y],
          [(start.x + point[0]) / 2, (start.y + point[1]) / 2],
          [point[0], point[1]],
        ];
        const recorded: SwipeTrack | undefined =
          pendingSwipeMode === 'track'
            ? straight
              ? { path: straightPath, holdMs: track.holdMs }
              : track
            : undefined;
        void completed.then((ok) =>
          ok
            ? commitSwipePick(
                deviceId,
                pendingSwipeStep,
                start.x,
                start.y,
                point[0],
                point[1],
                moveMs,
                recorded,
              )
            : null,
        );
      } else {
        useSessionStore.setState({ error: '录制滑动：请在画面上按住并拖出明显滑动，轻点不会写入' });
      }
      return;
    }
    if (recordActionMode) {
      // 坐标留 4 位小数：原始归一化值有 15 位，写进脚本后到处是 `0.34210526315789475`
      const round = (value: number): number => Number(value.toFixed(4));
      const action = swipe
        ? {
            type: 'swipe',
            x: round(start.x),
            y: round(start.y),
            to_x: round(point[0]),
            to_y: round(point[1]),
            duration_ms: Math.min(1500, Math.max(80, moveMs)),
            ...(track.path.length >= 3
              ? { path: track.path.map(([x, y]): [number, number] => [round(x), round(y)]) }
              : {}),
            ...(track.holdMs > 0 ? { hold_ms: Math.min(5000, track.holdMs) } : {}),
          }
        : {
            type: duration >= 450 ? 'long_press' : 'click',
            x: round(point[0]),
            y: round(point[1]),
            ...(duration >= 450 ? { duration_ms: duration } : {}),
          };
      void completed.then((ok) => (ok ? recordStep(deviceId, action) : null));
    }
  };

  const onPointerCancel = (): void => {
    const start = controlStart.current;
    controlStart.current = null;
    controlTrack.current = [];
    if (start) {
      void touchDevice(deviceId, 'up', start.x, start.y);
    }
  };

  /* ---------------------------------------------------------------- 录制模式 */

  const [selection, setSelection] = useState<readonly [number, number, number, number] | null>(null);
  const dragStart = useRef<[number, number] | null>(null);

  const toNormalized = (clientX: number, clientY: number): [number, number] | null =>
    toCanvas(clientX, clientY, true);

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (recordMode === 'off') {
      return;
    }
    // 黑边/留白不算画面：从那里按下不能起选区（点选会贴边生成蓝框）
    const start = toCanvas(event.clientX, event.clientY, false);
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
    onHover?.(recordMode === 'marquee' ? current : null);
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
      const pendingCoord = useUiStore.getState().pendingFlowClickCoordStepId;
      if (pendingCoord) {
        void commitClickCoordPick(deviceId, pendingCoord, x, y);
        dragStart.current = null;
        return;
      }
      const size = pickSize || 120;
      const [screenW, screenH] = frame?.resolution ?? [1280, 720];
      // 像素正方形：宽高都取 size 像素，再各自归一化（竖屏不会变成细长条）
      const pickW = screenW > 0 ? size / screenW : 0.1;
      const pickH = screenH > 0 ? size / screenH : 0.1;
      const rx = Math.min(Math.max(0, x - pickW / 2), Math.max(0, 1 - pickW));
      const ry = Math.min(Math.max(0, y - pickH / 2), Math.max(0, 1 - pickH));
      beginDraft({
        rect: [rx, ry, pickW, pickH],
        resolution: [screenW, screenH],
        score: liveScore(frame),
        mode: 'pick',
        pickCenter: [x, y],
      });
      dragStart.current = null;
      return;
    }
    const pendingRegion = useUiStore.getState().pendingFlowClickRegionStepId;
    if (pendingRegion && selection && selection[2] > 0.01 && selection[3] > 0.01) {
      void commitClickRegionPick(deviceId, pendingRegion, selection);
      dragStart.current = null;
      setSelection(null);
      return;
    }
    if (selection && selection[2] > 0.01 && selection[3] > 0.01) {
      beginDraft({ rect: selection, score: liveScore(frame), mode: 'marquee' });
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
