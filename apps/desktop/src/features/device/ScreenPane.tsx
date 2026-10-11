/**
 * 画面栏：空态 / 单画面（真实画面 + 识别覆盖 + 录制框选）/ 多开网格。
 *
 * 数据来源是引擎推来的 `engine.frame`（base64 JPEG + 当帧识别结果 + 节点状态）：
 * 识别框、node/tick/fps 浮层全部是引擎的真实数据，前端只做展示与坐标换算
 * （而且坐标本来就是归一化的，连换算都不需要）。
 */
import { ChevronDown, ChevronUp, Grid2x2, MousePointerSquareDashed, ScanLine } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { Group, Panel, type PanelImperativeHandle, Separator, usePanelRef } from 'react-resizable-panels';

import { DeviceControls } from '@/features/device/DeviceControls';
import { RecordOverlay } from '@/features/device/RecordOverlay';
import { type GesturePoint, isSwipeGesture } from '@/features/device/touch-gesture';
import { checkRecognizerName, trimRecognizerName } from '@/features/recognizers/recognizer-name';
import { SCREEN_LAYOUT } from '@/layout/layout-specs';
import { useLayoutGroup } from '@/layout/useLayoutGroup';
import { GhostButton, PanelShell, StatusDot } from '@/layout/PanelShell';
import { formatResolution } from '@/lib/format';
import { type Box, canvasPointToPixels, canvasRectToPixels, containBox, pointToCanvas } from '@/lib/canvas';
import { devLog } from '@/lib/rpc';
import { cn } from '@/lib/utils';
import { activeDevice, connectedDevices, useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore, type FrameState } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { RecognizerView } from '@/types';

/** 上一次记录的画面栏分支（只在变化时打日志） */
let lastBranchKey = '';
let lastGridSummary = '';
let lastImageBoxKey = '';
let imgLoadLogs = 0;

/**
 * 识别读数区收起时的高度：正好放下那一行标题（h-6 = 24px + 上下各 1px 边框）。
 * **不能收到 0** —— 0 的话分隔线会贴在面板底边，鼠标抓不住（CONVENTIONS §12.6-6）。
 */
const READOUT_COLLAPSED_PX = 26;
/** 展开态最小高度：再矮就只剩标题，读数看不见了 */
const READOUT_MIN_PX = 96;

export function ScreenPane(): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const gridView = useDeviceStore((state) => state.gridView);
  const toggleGrid = useDeviceStore((state) => state.toggleGrid);
  const toggleDevicePopover = useUiStore((state) => state.toggleDevicePopover);
  const recordMode = useUiStore((state) => state.recordMode);
  const frame = useSessionStore((state) => state.frames[activeId]);
  const graph = useGraphStore((state) => state.graphs[activeId]);

  const device = activeDevice(devices, activeId);
  const connected = useMemo(() => connectedDevices(devices), [devices]);
  // 读数区的展开/收起：store 是唯一状态源，面板尺寸跟着它走（和底部抽屉一个规矩）
  const readoutOpen = useUiStore((state) => state.readoutOpen);
  const setReadoutOpen = useUiStore((state) => state.setReadoutOpen);
  const readoutRef = usePanelRef();

  // 画面栏到底渲染了哪一支？"连上了却没画面"第一时间要看的就是这个。
  // 只在分支真正变化时打一条，避免 14fps 下刷屏。
  useEffect(() => {
    const key =
      `${activeId}|${device?.name ?? '-'}|${device?.status ?? '-'}|${String(gridView)}|` +
      `${connected.length}|${String(Boolean(frame))}`;
    if (lastBranchKey !== key) {
      lastBranchKey = key;
      devLog(
        `画面栏分支: activeId=${activeId || '(空)'} 设备=${device?.name ?? '(无)'} 状态=${device?.status ?? '-'} 多开=${String(gridView)} 已连接=${connected.length} 有帧=${String(Boolean(frame))}`,
      );
    }
  }, [activeId, device?.name, device?.status, gridView, connected.length, frame]);
  const recognizers = graph?.recognizers ?? [];
  const confirmedCount = recognizers.filter((item) => item.state !== 'idle').length;
  // 画面 / 识别读数 上下可拖：识别器多的时候读数区要能拖高，单看画面时又要能压扁
  const view = useLayoutGroup(SCREEN_LAYOUT);

  return (
    <PanelShell
      title="画面"
      actions={
        <>
          <GhostButton
            active={recordMode === 'marquee'}
            onClick={() => toggleRecordMode('marquee')}
            title="框选录制：拖一个矩形生成识别器"
          >
            <MousePointerSquareDashed className="size-3" />
            框选
          </GhostButton>
          <GhostButton
            active={recordMode === 'pick'}
            onClick={() => toggleRecordMode('pick')}
            title="点选录制：单击取 3×3% 邻域小模板"
          >
            <ScanLine className="size-3" />
            点选
          </GhostButton>
          <GhostButton
            active={gridView}
            onClick={() => {
              // 不用禁用：点了没反应才是最难排查的。这里直接把原因写在顶部错误条
              if (connected.length === 0) {
                useSessionStore.setState({
                  error: `多开需要至少 1 台已连接设备（当前 ${devices.length} 台设备，0 台已连接）`,
                });
                return;
              }
              toggleGrid();
            }}
            title={`多开网格（当前 ${connected.length} 台已连接 / 共 ${devices.length} 台设备）`}
          >
            <Grid2x2 className="size-3" />
            多开{connected.length > 0 ? ` ${connected.length}` : ''}
          </GhostButton>
          <GhostButton title="当前帧命中的识别器数量">读数 {confirmedCount}</GhostButton>
        </>
      }
    >
      <Group
        id={SCREEN_LAYOUT.id}
        orientation="vertical"
        defaultLayout={view.defaultLayout}
        onLayoutChanged={view.onLayoutChanged}
        groupRef={view.groupRef}
        className="h-full"
      >
        <Panel id="view" defaultSize="70%" minSize="30%" style={{ overflow: 'hidden' }}>
          {/* 画面 + 紧跟其下的设备控制条（返回/桌面/最近任务/电源/控制/录操作）：
              控制条属于"画面"这一格，拖高识别读数时它不会被推走 */}
          <div className="flex h-full min-h-0 flex-col gap-1 bg-canvas p-2">
            <div className="flex min-h-0 flex-1 flex-col">
              {gridView ? (
                <ScreenGrid />
              ) : device?.status === 'connected' ? (
                <SingleScreen
                  deviceId={device.id}
                  deviceName={device.name}
                  resolution={device.resolution}
                  frame={frame}
                />
              ) : (
                <EmptyState onConnect={() => toggleDevicePopover(true)} />
              )}
            </div>
            {device && device.status === 'connected' && (
              <DeviceControls deviceId={device.id} deviceName={device.name} />
            )}
          </div>
        </Panel>
        <Separator
          className="h-px bg-line transition-colors hover:bg-brand"
          title="拖动改高度（拖到底会收起诉数区）· 双击恢复默认"
        />
        {/* 读数区可以收起来：收起时只留 26px 的标题行（展开按钮还在），画面拿走全部高度。
            和底部调试抽屉同一套做法：`collapsible` + panelRef，状态在 ui.store，
            尺寸听 store 的（拖动改尺寸是用户交互，会被布局记忆存下来） */}
        <Panel
          id="readout"
          defaultSize="30%"
          minSize={`${READOUT_MIN_PX}px`}
          collapsible
          collapsedSize={`${READOUT_COLLAPSED_PX}px`}
          panelRef={readoutRef}
          onResize={() => {
            // 拖到底（或拖出来）时面板自己会折叠：把状态同步回 store，
            // 否则标题上的"收起/展开"会和真实状态相反，一点就卡住
            const collapsed = readoutRef.current?.isCollapsed() ?? false;
            if (readoutOpen !== !collapsed) {
              setReadoutOpen(!collapsed);
            }
          }}
          style={{ overflow: 'hidden' }}
        >
          <RecognizerReadout
            deviceId={activeId}
            recognizers={recognizers}
            panelRef={readoutRef}
            onConnect={() => toggleDevicePopover(true)}
          />
        </Panel>
      </Group>
    </PanelShell>
  );
}

function toggleRecordMode(mode: 'marquee' | 'pick'): void {
  const state = useUiStore.getState();
  state.setRecordMode(state.recordMode === mode ? 'off' : mode);
}

/* ------------------------------------------------------------------ 空态 */

function EmptyState({ onConnect }: { onConnect: () => void }): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const discovered = devices.filter((device) => device.status !== 'connected').slice(0, 4);

  return (
    // 画面区被拖矮时（上下可拖了）空态内容会超出高度：给滚动条，
    // 用 m-auto 而不是 justify-center —— 居中 + 溢出会把顶部的引导文字裁掉且滚不到
    <div className="flex h-full flex-col overflow-auto">
      <div className="m-auto flex flex-col items-center gap-3">
        <span className="text-panelhead text-dim">还没有连接设备</span>
        <ol className="w-[420px] space-y-1 text-badge text-faint">
          <li>1. 点下面的「连接设备」，选一台手机（USB 调试已授权）或 Mock 设备</li>
          <li>2. 连上后点画面栏的「框选」，在画面上拖一个矩形 → 生成识别器</li>
          <li>3. 录好节点后点顶栏「运行」，状态机就会按你的状态图跑</li>
        </ol>
        <button
          type="button"
          onClick={onConnect}
          className="h-7 rounded-sm bg-brand px-4 text-body font-medium text-[#0b0d12] hover:opacity-90"
        >
          连接设备
        </button>
        <div className="w-80 text-badge text-faint">
          <div className="mb-1 text-dim">已发现（点「连接设备」刷新/连接）</div>
          {discovered.map((device) => (
            <button
              key={device.id}
              type="button"
              onClick={onConnect}
              className="flex h-[26px] w-full items-center gap-2 px-1 text-left hover:bg-raised"
            >
              <StatusDot tone={device.status === 'failed' ? 'failed' : 'idle'} />
              <span className="min-w-0 flex-1 truncate text-body text-fg">{device.name}</span>
              <span>{formatResolution(device.resolution)}</span>
              <span className="text-dim">→</span>
            </button>
          ))}
          {discovered.length === 0 && (
            <div className="px-1 py-2">还没扫描到设备 · 确认手机已插好并允许 USB 调试</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- 单画面 */

/**
 * 「录操作」时的触控辅助（不是控制反馈 —— 正常控制画面上必须干干净净）。
 *
 * 两种形态**互斥**，同一时刻只画一个：
 * - `tap`   —— 轻触：落点上一个小圆点 + 一圈从中心荡开的扩散环
 * - `swipe` —— 滑动：起点实心点 →（虚线）→ 终点空心圈 + 箭头，拖动中落点实时更新
 *
 * 只在 `recordActionMode` 为真时出现：这两样东西的用途是"看清这一段会被录成什么"，
 * 正常控制时它们只是糊在投屏上的杂物（用户明确要求过：正常控制一个辅助都不要）。
 *
 * 为什么强调互斥：曾经是"按下闪一个 + 抬手闪一个"，滑动时就成了**两个分开的点击**，
 * 用户看到的是"我点歪了两下"，而实际发生的是"从 A 滑到 B"。
 */
type TouchFeedbackDraft =
  | { readonly kind: 'tap'; readonly point: GesturePoint }
  | { readonly kind: 'swipe'; readonly from: GesturePoint; readonly to: GesturePoint };

type TouchFeedback = TouchFeedbackDraft & { readonly id: number };

/** 辅助在画面上停留多久（ms）：和 `animate-touch-ping` 的时长一致，扩散环播完即收。 */
const FEEDBACK_TTL_MS = 520;

function SingleScreen({
  deviceId,
  deviceName,
  resolution,
  frame,
}: {
  deviceId: string;
  deviceName: string;
  resolution: readonly [number, number] | null;
  frame: FrameState | undefined;
}): ReactNode {
  const recordMode = useUiStore((state) => state.recordMode);
  // 画面上的鼠标/指针操作按"控制"与"录操作"两个开关决定行为（开关按钮在画面下方的控制条里）
  const controlMode = useUiStore((state) => state.controlMode);
  const recordActionMode = useUiStore((state) => state.recordActionMode);
  const touchDevice = useSessionStore((state) => state.touch);
  const recordStep = useSessionStore((state) => state.recordStep);
  const recordStart = useRef<{ x: number; y: number; at: number } | null>(null);
  const draft = useUiStore((state) => state.draft);
  const beginDraft = useUiStore((state) => state.beginDraft);
  const viewport = useRef<HTMLDivElement>(null);
  // 控制模式下的鼠标操作：按下→抬起是轻触，拖拽是滑动
  const controlStart = useRef<{ x: number; y: number; at: number; moved: boolean } | null>(null);
  const lastMoveAt = useRef(0);
  // 触控反馈存的是**画面归一化坐标**，渲染时要换算成容器像素（否则有黑边时看起来是偏的）
  const [feedback, setFeedback] = useState<TouchFeedback | null>(null);
  const feedbackSeq = useRef(0);
  const feedbackTimer = useRef<number | null>(null);

  /**
   * 画一次触控反馈（同一时刻只画一个）。
   *
   * 这里是"滑动被画成两个点击"那个 bug 的关键：反馈是**互斥**的两种形态，
   * 抬手时不能在终点再补一个波纹 —— 起点一个 + 终点一个，看起来就是点歪了两下。
   */
  const showFeedback = (next: TouchFeedbackDraft): void => {
    feedbackSeq.current += 1;
    const id = feedbackSeq.current;
    const value: TouchFeedback = { ...next, id };
    if (feedbackTimer.current !== null) {
      window.clearTimeout(feedbackTimer.current);
    }
    setFeedback(value);
    feedbackTimer.current = window.setTimeout(() => {
      feedbackTimer.current = null;
      setFeedback((current) => (current?.id === id ? null : current));
    }, FEEDBACK_TTL_MS);
  };

  /** 立刻收掉反馈（拖动开始时要把"按下那一下"的波纹抹掉，正常控制不给滑动留痕迹）。 */
  const clearFeedback = (): void => {
    if (feedbackTimer.current !== null) {
      window.clearTimeout(feedbackTimer.current);
      feedbackTimer.current = null;
    }
    setFeedback(null);
  };

  // 卸载时把定时器收掉：换设备/关面板后不该再有 setState
  useEffect(
    () => () => {
      if (feedbackTimer.current !== null) {
        window.clearTimeout(feedbackTimer.current);
      }
    },
    [],
  );

  // 画面的实际显示矩形（容器相对坐标）：object-contain 会有黑边，控制坐标只按画面算
  const [imageBox, setImageBox] = useState<Box | null>(null);
  // 容器在视口里的位置（量测时存下来，渲染期只用 state，不碰 ref）
  const [viewportRect, setViewportRect] = useState<{ left: number; top: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const container = viewport.current;
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
      // 记录一次：确认控制坐标用的确实是"画出来的那块区域"，而不是整个容器
      if (box) {
        const key = `画面区域 ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`;
        if (key !== lastImageBoxKey) {
          lastImageBoxKey = key;
          devLog(`${key}（容器 ${Math.round(rect.width)}x${Math.round(rect.height)}，黑边不参与控制）`);
        }
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [frame?.index, frame?.resolution]);

  /** 鼠标位置 → 画面归一化坐标（clamp=false 时落在黑边上返回 null：背景不算） */
  const toCanvas = (clientX: number, clientY: number, clamp: boolean): [number, number] | null => {
    const container = viewport.current;
    if (!container || !imageBox) {
      return null;
    }
    const rect = container.getBoundingClientRect();
    return pointToCanvas(imageBox, { x: clientX - rect.left, y: clientY - rect.top }, clamp);
  };

  /** 选区的"视口坐标"矩形：弹框要据此做碰撞翻转（跟手，不跳到固定位置）。 */
  const selectionViewportRect = (rect: readonly [number, number, number, number]) => {
    const box = viewportRect;
    if (!box || !imageBox) {
      return null;
    }
    const local = canvasRectToPixels(imageBox, rect) ?? { left: 0, top: 0, width: 0, height: 0 };
    return {
      left: box.left + local.left,
      top: box.top + local.top,
      width: local.width,
      height: local.height,
    };
  };

  const [selection, setSelection] = useState<[number, number, number, number] | null>(null);
  const dragStart = useRef<[number, number] | null>(null);
  const [pointer, setPointer] = useState<[number, number] | null>(null);

  /**
   * 录制坐标：**相对画面区域**（不是容器）。
   *
   * 原来按容器算，有黑边时框选能把黑边框进来 —— 录出来的模板会带一圈黑边，
   * 匹配自然不准。现在统一用 imageBox 换算，并且钳在画面内（框不出画面）。
   */
  const toNormalized = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): [number, number] | null => {
      const container = viewport.current;
      if (!container || !imageBox) {
        return null;
      }
      const rect = container.getBoundingClientRect();
      return pointToCanvas(imageBox, { x: event.clientX - rect.left, y: event.clientY - rect.top }, true);
    },
    [imageBox],
  );

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (recordMode === 'off' || draft) {
      return;
    }
    const start = toNormalized(event);
    if (!start) {
      return; // 画面还没量出来（或没有帧）时先不录
    }
    dragStart.current = start;
    setSelection(null);
  };

  const onMouseMove = (event: React.MouseEvent<HTMLDivElement>): void => {
    const current = toNormalized(event);
    setPointer(recordMode === 'marquee' ? current : null);
    const start = dragStart.current;
    if (!current) {
      return;
    }
    if (!start || recordMode !== 'marquee') {
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
      beginDraft({ rect: [clamp01(x - 0.015), clamp01(y - 0.015), 0.03, 0.03], score: liveScore(frame) });
      dragStart.current = null;
      return;
    }
    if (selection && selection[2] > 0.01 && selection[3] > 0.01) {
      beginDraft({ rect: selection, score: liveScore(frame) });
    }
    dragStart.current = null;
    setSelection(null);
  };

  const detections = frame?.detections ?? [];
  const recoverImage = useSessionStore((state) => state.recoverImage);

  // 画面容器尺寸诊断：只在前几秒打几次，用来确认"容器真的被压成 0 高度"这类布局问题
  useEffect(() => {
    const node = viewport.current;
    if (!node) {
      return;
    }
    let ticks = 0;
    const report = (): void => {
      ticks += 1;
      if (ticks <= 3) {
        devLog(`画面容器 ${node.clientWidth}x${node.clientHeight}`);
      }
    };
    report();
    const timer = setInterval(report, 1500);
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => {
      clearInterval(timer);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={viewport}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onPointerDown={(event) => {
        if (!controlMode || recordMode !== 'off') {
          return;
        }
        const point = toCanvas(event.clientX, event.clientY, false);
        if (!point) {
          return; // 落在黑边上：背景区域不算
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        // 诊断：把"点了哪里 → 换算成画面哪里"打出来，偏差能一眼看出在哪一步
        if (imageBox) {
          const rect = event.currentTarget.getBoundingClientRect();
          devLog(
            `控制: 鼠标(${Math.round(event.clientX - rect.left)},${Math.round(event.clientY - rect.top)})` +
              ` 容器 ${Math.round(rect.width)}x${Math.round(rect.height)}` +
              ` 画面 ${Math.round(imageBox.left)},${Math.round(imageBox.top)} ${Math.round(imageBox.width)}x${Math.round(imageBox.height)}` +
              ` → 归一化(${point[0].toFixed(3)},${point[1].toFixed(3)})`,
          );
        }
        controlStart.current = { x: point[0], y: point[1], at: performance.now(), moved: false };
        recordStart.current = { x: point[0], y: point[1], at: performance.now() };
        lastMoveAt.current = 0;
        // 按下先闪一下：手感反馈不等抬手（这一下是点还是滑，要拖出去才知道）。
        // 只有录操作时才画 —— 正常控制不给投屏加任何东西
        if (recordActionMode) {
          showFeedback({ kind: 'tap', point });
        }
        touchDevice(deviceId, 'down', point[0], point[1]);
      }}
      onPointerMove={(event) => {
        const start = controlStart.current;
        if (!start) {
          return;
        }
        const point = toCanvas(event.clientX, event.clientY, true);
        if (!point) {
          return;
        }
        // 手势判定用**合位移**，不是"有没有 move 事件"：轻触时手抖 1px 也会发 move，
        // 按 move 判会把所有轻触都误判成滑动
        if (!start.moved && isSwipeGesture([start.x, start.y], point)) {
          start.moved = true;
          // 从"按一下"变成"拖出去"了：正常控制下把按下那个波纹收掉 ——
          // 画面要干净，滑动不留在投屏上（只有录操作时才画轨迹）
          if (!recordActionMode) {
            clearFeedback();
          }
        }
        // 实时滑动：拖动过程中直接转发 move（约 60Hz 限频），不是松手后合成一次滑动
        const now = performance.now();
        if (now - lastMoveAt.current < 16) {
          return;
        }
        lastMoveAt.current = now;
        touchDevice(deviceId, 'move', point[0], point[1]);
        if (start.moved && recordActionMode) {
          // 轨迹跟着指针走：起点不动、落点实时更新 —— 一眼看出"这一段会被录成滑动"
          showFeedback({ kind: 'swipe', from: [start.x, start.y], to: point });
        }
      }}
      onPointerUp={(event) => {
        const start = controlStart.current;
        controlStart.current = null;
        if (!start || !controlMode || recordMode !== 'off') {
          return;
        }
        const point = toCanvas(event.clientX, event.clientY, true) ?? [start.x, start.y];
        const from: GesturePoint = [start.x, start.y];
        const swipe = isSwipeGesture(from, point);
        if (recordActionMode) {
          // 录操作：手指抬起来了，画面上留一份"这一段会录成什么"的辅助 ——
          // 轻触 = 落点上的点击标记，滑动 = 停在终点的轨迹（**不补第二个点击标记**，
          // 起点一个 + 终点一个就是"一次滑动看起来像点了两下"的根因）
          showFeedback(swipe ? { kind: 'swipe', from, to: point } : { kind: 'tap', point });
        } else {
          // 正常控制：画面上不留任何痕迹（辅助只在录操作时出现）
          clearFeedback();
        }
        // 诊断：手势的判定结果（和画面上看到的反馈必须一致）
        devLog(
          `控制: 手势=${swipe ? '滑动' : '轻触'} (${from[0].toFixed(3)},${from[1].toFixed(3)})` +
            ` → (${point[0].toFixed(3)},${point[1].toFixed(3)})`,
        );
        touchDevice(deviceId, 'up', point[0], point[1]);
        // 录操作：抬手时把这一个手势写成脚本里的一步（点了=click，拖了=swipe）。
        // 判定用上面同一个 `swipe`：画面上画成什么样，录下来就是什么样
        const origin = recordStart.current;
        recordStart.current = null;
        if (recordActionMode && origin) {
          const durationMs = Math.round(performance.now() - origin.at);
          if (swipe) {
            void recordStep(deviceId, {
              type: 'swipe',
              x: Number(origin.x.toFixed(4)),
              y: Number(origin.y.toFixed(4)),
              to_x: Number(point[0].toFixed(4)),
              to_y: Number(point[1].toFixed(4)),
              duration_ms: Math.min(1500, Math.max(80, durationMs)),
            });
          } else {
            void recordStep(deviceId, {
              type: 'click',
              x: Number(point[0].toFixed(4)),
              y: Number(point[1].toFixed(4)),
            });
          }
        }
      }}
      onPointerCancel={() => {
        const start = controlStart.current;
        controlStart.current = null;
        if (start) {
          // 已发出的 move 收个尾；画面上的轨迹不用管，它自己会过期消失
          touchDevice(deviceId, 'up', start.x, start.y);
        }
      }}
      data-testid="screen-viewport"
      className={cn(
        'relative min-h-0 w-full flex-1 border border-line bg-[#0b0d12]',
        (recordMode !== 'off' || controlMode) && 'cursor-crosshair',
      )}
    >
      {frame ? (
        <img
          ref={imgRef}
          src={frame.imageUrl}
          alt={`${deviceName} 实时画面`}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          draggable={false}
          onLoad={(event) => {
            if (imgLoadLogs < 3) {
              imgLoadLogs += 1;
              const rect = event.currentTarget.getBoundingClientRect();
              devLog(
                `画面栏 img 加载成功 ${event.currentTarget.naturalWidth}x${event.currentTarget.naturalHeight}` +
                  ` 渲染尺寸 ${Math.round(rect.width)}x${Math.round(rect.height)}`,
              );
            }
          }}
          onError={() => void recoverImage(deviceId)}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-faint">
          <span className="text-body">
            {deviceName} · {formatResolution(resolution)}
          </span>
          <span className="text-badge">等待首帧…</span>
        </div>
      )}

      {/* 画面实际显示区域：黑边之外不响应控制，画条线让可点范围一目了然 */}
      {imageBox && controlMode && recordMode === 'off' && (
        <span
          className="pointer-events-none absolute border border-brand/30"
          style={{ left: imageBox.left, top: imageBox.top, width: imageBox.width, height: imageBox.height }}
        />
      )}

      {/* 录操作辅助（两种形态互斥，**只有录操作时才画**；正常控制一个都不画）：
          轻触 = 落点上的小圆点 + 一圈从中心荡开的扩散环（抬手再播一次 = "这一下录进去了"）；
          滑动 = 起点实心点 → 虚线 → 终点空心圈 + 箭头（"这一段会被录成 swipe"）。
          **滑动抬手时绝不补点击标记** —— 否则一次滑动会画出两个"点击" */}
      {feedback?.kind === 'tap' && (
        <span
          key={feedback.id}
          data-testid="touch-tap"
          className="pointer-events-none absolute animate-touch-fade"
          style={feedbackPointStyle(imageBox, feedback.point)}
        >
          {/* 扩散环：位移和缩放都在 keyframes 里（动画会盖掉 transform 工具类） */}
          <span className="absolute animate-touch-ping rounded-full border-2 border-brand size-7" />
          {/* 中心点：真正的落点。带一圈暗色描边，压在亮画面上也看得清 */}
          <span className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand ring-2 ring-canvas/55 size-[7px]" />
        </span>
      )}
      {feedback?.kind === 'swipe' && imageBox && (
        // 不给 key：拖动中每一步都在更新落点，重挂 SVG 是白扔性能（改属性就够）
        <SwipeTrail from={feedback.from} to={feedback.to} box={imageBox} />
      )}

      {/* 画面角标：一眼看出"有没有帧、多大、多少帧率"。排查"看不见画面"时这是最直接的证据 */}
      {frame && (
        <span className="pointer-events-none absolute bottom-1 left-1 rounded-sm bg-black/55 px-1.5 py-0.5 text-badge text-white/85">
          帧 #{frame.index} · {frame.resolution[0]}×{frame.resolution[1]} · {frame.fps.toFixed(1)}fps
        </span>
      )}

      {/* 识别框：绿=投票已确认 / 橙=待确认；坐标是引擎给的归一化值 */}
      {detections.map((item) => {
        const [x, y, w, h] = item.rect;
        const tone =
          item.state === 'confirmed' ? 'border-confirmed text-confirmed' : 'border-pending text-pending';
        return (
          <div
            key={item.label}
            className={cn('pointer-events-none absolute border', tone)}
            style={
              // 引擎给的是"相对画面"的归一化框：黑边不参与
              canvasRectToPixels(imageBox, [x, y, w, h]) ?? { left: 0, top: 0, width: 0, height: 0 }
            }
          >
            <span className="absolute -top-4 left-0 text-badge whitespace-nowrap">
              {item.label} {item.score.toFixed(2)}
            </span>
          </div>
        );
      })}

      {/* 录制态：十字准星 + 归一化坐标读数 */}
      {recordMode !== 'off' && pointer && (
        <>
          <div
            className="pointer-events-none absolute w-px bg-brand/30"
            style={
              imageBox
                ? {
                    left: imageBox.left + pointer[0] * imageBox.width,
                    top: imageBox.top,
                    height: imageBox.height,
                  }
                : { left: 0, top: 0, height: 0 }
            }
          />
          <div
            className="pointer-events-none absolute h-px bg-brand/30"
            style={
              imageBox
                ? {
                    left: imageBox.left,
                    top: imageBox.top + pointer[1] * imageBox.height,
                    width: imageBox.width,
                  }
                : { left: 0, top: 0, width: 0 }
            }
          />
          <div className="pointer-events-none absolute top-1 left-1 rounded-sm bg-canvas/80 px-1.5 py-0.5 text-badge text-brand">
            ({pointer[0].toFixed(3)}, {pointer[1].toFixed(3)})
          </div>
        </>
      )}

      {/* 框选矩形 */}
      {selection && (
        <div
          className="pointer-events-none absolute border border-dashed border-brand bg-brand/10"
          style={canvasRectToPixels(imageBox, selection) ?? { left: 0, top: 0, width: 0, height: 0 }}
        >
          <span className="absolute -bottom-4 left-0 text-badge text-brand">
            {selection[2].toFixed(3)} × {selection[3].toFixed(3)}
          </span>
        </div>
      )}

      {/* 运行态浮层：全部来自引擎帧 */}
      {frame && (
        <div className="pointer-events-none absolute bottom-1 left-1 rounded-sm bg-canvas/80 px-1.5 py-0.5 text-badge text-dim">
          node={frame.node ?? '-'} · tick={frame.tick} · {frame.fps}fps
          {frame.pending ? ` · pending→${frame.pending}` : ''}
        </div>
      )}

      {draft && imageBox && <RecordOverlay deviceId={deviceId} anchor={selectionViewportRect(draft.rect)} />}
    </div>
  );
}

/**
 * 反馈点的绝对定位：按**实际画面区域**换算（有黑边时用容器百分比会飘到黑边上）。
 * 画面还没量出来时退回容器百分比：宁可偏一点，也别"点了完全没反馈"。
 */
function feedbackPointStyle(box: Box | null, point: GesturePoint): CSSProperties {
  const pixels = canvasPointToPixels(box, point);
  return pixels
    ? { left: pixels.left, top: pixels.top }
    : { left: `${point[0] * 100}%`, top: `${point[1] * 100}%` };
}

/**
 * 滑动轨迹（**只在录操作时出现**）：起点实心点 → 虚线 → 终点空心圈 + 方向箭头。
 *
 * 用一条"从这里滑到那里"的轨迹，而不是两个点：点和点的组合传达的是**两次点击**，
 * 轨迹传达的才是**一次滑动**。拖动过程中落点实时更新，所以看得见自己滑了多远。
 *
 * 两处样式上的讲究：
 * - 每个形状都先铺一层**暗色垫层**：投屏内容可能是白底/亮色，单画蓝线会糊在画面里；
 * - 终点带一个顺着方向的**箭头**：滑动的"方向"是它和点击最大的区别，必须一眼看出来。
 */
function SwipeTrail({ from, to, box }: { from: GesturePoint; to: GesturePoint; box: Box }): ReactNode {
  const start = canvasPointToPixels(box, from);
  const end = canvasPointToPixels(box, to);
  if (!start || !end) {
    return null;
  }
  const dx = end.left - start.left;
  const dy = end.top - start.top;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  // 太短的轨迹不放箭头：箭头会盖在两个圆点上，反而看不清（刚过阈值的滑动就属于这种）
  const arrow = Math.hypot(dx, dy) > 34;
  const arrowPath = 'M 0 -4.5 L 8.5 0 L 0 4.5 Z';
  const arrowAt = `translate(${end.left} ${end.top}) rotate(${angle}) translate(15 0)`;
  return (
    <svg
      data-testid="touch-swipe"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full text-brand"
    >
      {/* 暗色垫层（比本体粗一圈）：保证在亮画面上也看得清 */}
      <line
        x1={start.left}
        y1={start.top}
        x2={end.left}
        y2={end.top}
        className="stroke-canvas"
        strokeOpacity={0.5}
        strokeWidth={5}
        strokeLinecap="round"
      />
      <circle
        cx={start.left}
        cy={start.top}
        r={6.5}
        className="stroke-canvas"
        strokeOpacity={0.5}
        strokeWidth={3}
        fill="none"
      />
      <circle
        cx={end.left}
        cy={end.top}
        r={11.5}
        className="stroke-canvas"
        strokeOpacity={0.5}
        strokeWidth={3}
        fill="none"
      />
      {arrow && <path d={arrowPath} transform={arrowAt} className="fill-canvas" fillOpacity={0.5} />}

      {/* 本体：起点实心点 → 虚线 → 终点空心圈 */}
      <line
        data-testid="touch-swipe-line"
        x1={start.left}
        y1={start.top}
        x2={end.left}
        y2={end.top}
        className="stroke-brand"
        strokeWidth={2}
        strokeDasharray="6 5"
        strokeLinecap="round"
      />
      <circle cx={start.left} cy={start.top} r={5} className="fill-brand" />
      <circle cx={end.left} cy={end.top} r={10} className="stroke-brand" strokeWidth={2.5} fill="none" />
      {arrow && <path d={arrowPath} transform={arrowAt} className="fill-brand" />}
    </svg>
  );
}

/* --------------------------------------------------------------- 多开网格 */

function ScreenGrid(): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const setActive = useDeviceStore((state) => state.setActive);
  const frames = useSessionStore((state) => state.frames);
  const links = useSessionStore((state) => state.links);
  const connected = useMemo(() => connectedDevices(devices), [devices]);
  const columns = connected.length >= 4 ? 2 : 1;
  const gridRef = useRef<HTMLDivElement>(null);

  // 每块瓦片的帧状态：多开看不到画面时，先分清是"没帧"还是"有帧但没渲染"
  useEffect(() => {
    const summary = connected
      .map((device) => {
        const frame = frames[device.id];
        const urlKind = !frame?.imageUrl ? '空' : frame.imageUrl.startsWith('blob:') ? 'blob' : 'data';
        return `${device.name}=#${frame?.index ?? '-'}/${urlKind}/${frame ? frame.fps.toFixed(0) : '0'}fps`;
      })
      .join(' ');
    if (summary && summary !== lastGridSummary) {
      lastGridSummary = summary;
      devLog(`多开瓦片状态: ${summary}`);
    }
  });

  // 网格尺寸诊断：多开"看不到画面"时，先看容器和瓦片有没有高度（曾经塌成 0）
  useEffect(() => {
    const node = gridRef.current;
    if (!node) {
      return;
    }
    const tile = node.firstElementChild as HTMLElement | null;
    devLog(
      `多开网格: ${connected.length} 台 容器 ${node.clientWidth}x${node.clientHeight} 首瓦片 ${tile?.clientWidth ?? 0}x${tile?.clientHeight ?? 0}`,
    );
  }, [connected.length, columns]);

  if (connected.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-badge text-faint">
        <span>多开网格里还没有设备</span>
        <span>先在设备面板连接一台（0 台设备时没有画面可显示）</span>
      </div>
    );
  }

  return (
    <div
      ref={gridRef}
      className="grid h-full min-h-0 gap-1"
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        // 行高必须显式 1fr：默认 auto 行会被瓦片里绝对定位的 <img> 撑成 0 高度，
        // 表现就是"多开看不到画面"（和单画面之前那个塌陷是同一类问题）
        gridAutoRows: 'minmax(0, 1fr)',
        gridTemplateRows: `repeat(${Math.ceil(connected.length / columns)}, minmax(0, 1fr))`,
      }}
    >
      {connected.map((device) => {
        const frame = frames[device.id];
        const link = links[device.id];
        return (
          <button
            key={device.id}
            type="button"
            onClick={() => setActive(device.id)}
            className={cn(
              // items-stretch 必须显式写：<button> 的浏览器默认样式里有 align-items:center，
              // 而瓦片中间层只有绝对定位的 <img>（内容宽度 0），居中布局下会被压成 0 宽
              // —— 图加载成功却完全看不见，这就是"多开看不到设备投屏"的真凶
              'relative flex min-h-0 flex-col items-stretch border bg-[#0b0d12] text-left',
              device.id === activeId ? 'border-brand' : 'border-line hover:border-dim',
            )}
          >
            <span className="flex h-6 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
              <StatusDot tone="confirmed" />
              <span className="text-body">{device.name}</span>
              <span className="flex-1" />
              <span className="text-badge text-faint">{frame ? `${frame.fps}fps` : '—'}</span>
            </span>
            <span className="relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden">
              {frame ? (
                <img
                  src={frame.imageUrl}
                  alt={`${device.name} 画面`}
                  className="absolute inset-0 h-full w-full object-contain"
                  draggable={false}
                  onLoad={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    devLog(
                      `多开瓦片 ${device.id} img 加载成功 ${event.currentTarget.naturalWidth}x${event.currentTarget.naturalHeight}` +
                        ` 渲染尺寸 ${Math.round(rect.width)}x${Math.round(rect.height)}`,
                    );
                  }}
                  onError={() => {
                    devLog(`多开瓦片 ${device.id} img 加载失败 url=${frame.imageUrl.slice(0, 24) || '(空)'}`);
                    void useSessionStore.getState().recoverImage(device.id);
                  }}
                />
              ) : (
                <span className="flex flex-col items-center gap-1 text-badge text-faint">
                  <span>{device.name} · 等待首帧…</span>
                  <span>通道 {link ? link.channel : '-'} · 若一直如此看顶部红条</span>
                </span>
              )}
            </span>
            <span className="flex h-5 shrink-0 items-center justify-between border-t border-line px-2 text-badge text-faint">
              <span>{formatResolution(device.resolution)}</span>
              <span>{frame ? `帧 #${frame.index} · ${frame.fps.toFixed(1)}fps` : '无帧'}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------- 底部识别读数 */

/** 这一帧"命中"了吗：待确认/稳定都算命中，只有 idle 是没命中。 */
function isHit(item: RecognizerView): boolean {
  return item.state !== 'idle';
}

/** 导出只为单测直接渲染这一格（不用把 <img> 量测、指针坐标那一整套搭起来）。 */
export function RecognizerReadout({
  deviceId,
  recognizers,
  panelRef,
  onConnect,
}: {
  deviceId: string;
  recognizers: readonly RecognizerView[];
  /** 自己那一格的面板句柄：收起/展开是命令式的（Panel 的 collapse/expand） */
  panelRef: React.RefObject<PanelImperativeHandle | null>;
  onConnect: () => void;
}): ReactNode {
  // 筛选放 store：换设备/面板重挂之后选择还在（和 controlMode 那些一个规矩）
  const filter = useUiStore((state) => state.readoutFilter);
  const setFilter = useUiStore((state) => state.setReadoutFilter);
  const open = useUiStore((state) => state.readoutOpen);
  const setOpen = useUiStore((state) => state.setReadoutOpen);
  const rename = useSessionStore((state) => state.renameRecognizer);
  // 正在改名的行：值 + 校验错误（null = 可以提交）
  const [editing, setEditing] = useState<{ label: string; value: string; error: string | null } | null>(null);
  // 这次编辑是否已经了结（提交成功 / Esc 取消）：输入框卸载时浏览器还会补一个 blur，
  // 不挡住的话同一个改名会发两遍（第二遍必然报"识别器不存在"）
  const finished = useRef(false);

  const hits = recognizers.filter(isHit);
  const rows = filter === 'hit' ? hits : recognizers;

  // ui.store 是唯一状态源；面板尺寸跟着它走（和底部调试抽屉同一套做法）。
  // 注意依赖是 `open`：拖动折叠回写 store 之后，这里也会跟着走一次（幂等）
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    if (open) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [open, panelRef]);

  const beginRename = (label: string): void => {
    finished.current = false;
    setEditing({ label, value: label, error: null });
  };

  /**
   * 提交（回车 / 点别处都走这里）。
   *
   * 校验不过**不关输入框**：把原因留在原地接着改。"悄无声息地什么都不做"
   * 是最难用的一种交互 —— 用户只会觉得改名没生效。
   */
  const submitRename = (label: string, value: string): void => {
    const error = checkRecognizerName(value, {
      current: label,
      existing: recognizers.map((item) => item.label),
    });
    if (error) {
      setEditing({ label, value, error });
      return;
    }
    finished.current = true;
    setEditing(null);
    const name = trimRecognizerName(value);
    if (name !== label) {
      // 真正的改名交给引擎：它会连引用一起改（前端只做即时校验）
      void rename(deviceId, label, name);
    }
  };

  return (
    // 高度由上方分隔线决定；列表自己滚动（识别器可能有几十个，撑开会把画面挤没）
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-6 shrink-0 items-center gap-2 px-2 text-badge text-faint">
        {/* 标题本身就是收起/展开的开关：收起后画面拿走全部高度，这一行还留着（点得到） */}
        <button
          type="button"
          data-testid="readout-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title={
            open ? '收起诉数区（画面更高；也可以把上面的横线拖到底）' : '展开识别读数（筛选 · 双击名字改名）'
          }
          className="flex h-[18px] items-center gap-1 rounded-sm px-1 text-dim hover:bg-raised hover:text-fg"
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
          识别读数
        </button>
        <span className="flex-1" />
        {open ? (
          /* 全部 / 命中：识别器一多，"这一帧谁在命中"才是要看的信息 */
          <span className="flex items-center overflow-hidden rounded-sm border border-line">
            {(
              [
                ['all', `全部 ${recognizers.length}`],
                ['hit', `命中 ${hits.length}`],
              ] as const
            ).map(([id, text]) => (
              <button
                key={id}
                type="button"
                data-testid={`readout-filter-${id}`}
                aria-pressed={filter === id}
                title={id === 'hit' ? '只看这一帧命中的（待确认 + 稳定）' : '显示全部识别器'}
                onClick={() => setFilter(id)}
                className={cn('h-[18px] px-1.5', filter === id ? 'bg-active text-fg' : 'hover:text-fg')}
              >
                {text}
              </button>
            ))}
          </span>
        ) : (
          // 收起时筛选按钮没意义（列表都没了），但"命中几个"还是值得一眼看到
          <span data-testid="readout-hit-summary" className={hits.length > 0 ? 'text-confirmed' : undefined}>
            命中 {hits.length}
          </span>
        )}
        <button type="button" onClick={onConnect} className="hover:text-fg">
          查看设备
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.map((item) => {
          const editingThis = editing?.label === item.label;
          return (
            <div key={item.label} className="group/row flex h-[26px] items-center gap-2 px-2 hover:bg-raised">
              <StatusDot
                tone={
                  item.state === 'confirmed' ? 'confirmed' : item.state === 'pending' ? 'pending' : 'idle'
                }
              />
              {editingThis ? (
                <input
                  autoFocus
                  data-testid="recognizer-name-input"
                  value={editing.value}
                  aria-label={`${item.label} 改名`}
                  aria-invalid={Boolean(editing.error)}
                  title={editing.error ?? '回车保存 · Esc 取消'}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) =>
                    setEditing({ label: item.label, value: event.target.value, error: null })
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      submitRename(item.label, editing.value);
                    } else if (event.key === 'Escape') {
                      finished.current = true;
                      setEditing(null);
                    }
                  }}
                  onBlur={() => {
                    // 已经提交/取消过了（卸载时会补一个 blur）：别再提交一次
                    if (finished.current) {
                      finished.current = false;
                      return;
                    }
                    submitRename(item.label, editing.value);
                  }}
                  className={cn(
                    'h-[20px] w-32 shrink-0 rounded-sm border bg-canvas px-1 text-body text-fg outline-none',
                    editing.error ? 'border-failed' : 'border-brand',
                  )}
                />
              ) : (
                <button
                  type="button"
                  data-testid="recognizer-name"
                  title="双击改名（引用它的节点/边会一起改）"
                  onDoubleClick={() => beginRename(item.label)}
                  className="w-32 shrink-0 truncate text-left text-body hover:text-brand"
                >
                  {item.label}
                </button>
              )}
              <span className="shrink-0 text-body text-dim">{item.score.toFixed(2)}</span>
              {/* 校验失败的原因就写在行里（截断显示，完整内容看 title）：别让它"什么都没发生" */}
              {editingThis && editing.error ? (
                <span
                  className="min-w-0 flex-1 truncate text-right text-badge text-failed"
                  title={editing.error}
                >
                  {editing.error}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              <span className="shrink-0 text-badge text-faint">
                {item.state === 'confirmed' ? '稳定' : item.state === 'pending' ? '待确认' : '未命中'}
              </span>
            </div>
          );
        })}
        {recognizers.length === 0 && (
          <div className="px-2 py-3 text-badge text-faint">还没有识别器 · 打开「框选」在画面上拖一个矩形</div>
        )}
        {recognizers.length > 0 && rows.length === 0 && (
          <div className="px-2 py-3 text-badge text-faint">
            这一帧没有命中的识别器 · 切到「全部」看全部 {recognizers.length} 个
          </div>
        )}
      </div>
    </div>
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 录制时给草稿一个"本帧分数"参考值：取重叠最多的识别器分数。 */
function liveScore(frame: FrameState | undefined): number {
  if (!frame || frame.detections.length === 0) {
    return 0;
  }
  return frame.detections.reduce((best, item) => Math.max(best, item.score), 0);
}
