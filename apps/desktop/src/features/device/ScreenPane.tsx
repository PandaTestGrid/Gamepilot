/**
 * 画面栏：空态 / 单画面（真实画面 + 识别覆盖 + 录制框选）/ 多开网格。
 *
 * 数据来源是引擎推来的 `engine.frame`（base64 JPEG + 当帧识别结果 + 节点状态）：
 * 识别框、node/tick/fps 浮层全部是引擎的真实数据，前端只做展示与坐标换算
 * （而且坐标本来就是归一化的，连换算都不需要）。
 */
import {
  ChevronDown,
  ChevronUp,
  Grid2x2,
  Link2,
  Loader2,
  MousePointerClick,
  Power,
  ScanText,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, type PanelImperativeHandle, Separator, usePanelRef } from 'react-resizable-panels';

import { DeviceControls } from '@/features/device/DeviceControls';
import { EmulatorDisplayTabs } from '@/features/device/EmulatorDisplayTabs';
import { connectableDevices } from '@/features/device/device-kinds';
import { DraftForm } from '@/features/device/DraftForm';
import { DraftSelectionBox, SelectionFrame } from '@/features/device/SelectionBox';
import { type SurfaceGesture, useScreenSurface } from '@/features/device/use-screen-surface';
import { powerKeyFor } from '@/features/device/nav-keys';
import type { GesturePoint } from '@/features/device/touch-gesture';
import { simplifyTrack } from '@/features/device/touch-gesture';
import { checkRecognizerName, trimRecognizerName } from '@/features/recognizers/recognizer-name';
import { TemplateThumb } from '@/features/recognizers/TemplateThumb';
import { taskName } from '@/features/graph/task-name';
import { clickTargetMode } from '@/features/graph/flow/flow-click-params';
import { isNormRect } from '@/features/graph/flow/flow-click-region';
import { searchMaterials } from '@/lib/material-search';
import { collectRecognizerUsage, describeRecognizerUsage, nodeRef } from '@/lib/recognizer-usage';
import { SCREEN_LAYOUT } from '@/layout/layout-specs';
import { useLayoutGroup } from '@/layout/useLayoutGroup';
import { GhostButton, PanelShell, StatusDot } from '@/layout/PanelShell';
import { formatResolution } from '@/lib/format';
import { type Box, canvasPointToPixels, canvasRectToPixels } from '@/lib/canvas';
import { devLog, type OcrBoxItem } from '@/lib/rpc';
import { deviceRunLabel } from '@/lib/flow-run-attribution';
import { cn } from '@/lib/utils';
import { sanitizeOcrLabel, useOcrStore } from '@/stores/ocr.store';

const EMPTY_OCR_BOXES: readonly OcrBoxItem[] = [];
const EMPTY_FLOW_STEPS: readonly FlowStep[] = [];

import { activeDevice, connectedDevices, useDeviceStore } from '@/stores/device.store';
import { graphForDevice, useGraphStore } from '@/stores/graph.store';
import { useSessionStore, type FrameState } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { DeviceRuntime, FlowStep, RecognizerView, RecordDraft, RecordMode } from '@/types';

/** 上一次记录的画面栏分支（只在变化时打日志） */
let lastBranchKey = '';
let lastGridSummary = '';
let imgLoadLogs = 0;

/**
 * 素材区收起时的高度：正好放下那一行标题（h-7 = 28px，和详情坞收起条一样）。
 * **不能收到 0** —— 0 的话分隔线会贴在面板底边，鼠标抓不住（CONVENTIONS §12.6-6）。
 * 必须和标题行等高：多出来的像素会把列表顶部漏出来。
 */
const MATERIAL_COLLAPSED_PX = 28;
/** 展开态最小高度：再矮就只剩标题，素材看不见了 */
const MATERIAL_MIN_PX = 96;

/** 画面上的指针：控制=手型、框选=十字、点选=落点准星，三种互不重复。 */
export function screenCursorClass(recordMode: RecordMode, controlMode: boolean): string {
  if (recordMode === 'marquee') {
    return 'cursor-crosshair';
  }
  if (recordMode === 'pick') {
    return 'cursor-pick';
  }
  if (controlMode) {
    return 'cursor-pointer';
  }
  return '';
}

export function ScreenPane(): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const activeId = useDeviceStore((state) => state.activeId);
  const gridView = useDeviceStore((state) => state.gridView);
  const toggleGrid = useDeviceStore((state) => state.toggleGrid);
  const toggleDevicePopover = useUiStore((state) => state.toggleDevicePopover);
  const controlMode = useUiStore((state) => state.controlMode);
  const toggleControl = useUiStore((state) => state.toggleControl);
  const ocrStatus = useOcrStore((state) => state.status);
  const ocrDownloading = ocrStatus.state === 'downloading';
  const scanningScreen = useOcrStore((state) => state.scanningScreen);
  const recognizing = useOcrStore((state) => state.recognizing);
  const scanScreenForPick = useOcrStore((state) => state.scanScreenForPick);
  const cancelRecognize = useOcrStore((state) => state.cancelRecognize);
  const ocrScanBusy = scanningScreen || recognizing;
  const pressKey = useSessionStore((state) => state.pressKey);
  const isConnected = useSessionStore((state) => Boolean(state.ready[activeId]));
  const frame = useSessionStore((state) => state.frames[activeId]);
  const graph = useGraphStore((state) => graphForDevice(state, activeId));

  useEffect(() => {
    void useOcrStore.getState().refreshStatus();
  }, []);

  const device = activeDevice(devices, activeId);

  const connected = useMemo(() => connectedDevices(devices), [devices]);
  // 素材区的展开/收起：store 是唯一状态源，面板尺寸跟着它走（和底部抽屉一个规矩）
  const materialOpen = useUiStore((state) => state.materialOpen);
  const setMaterialOpen = useUiStore((state) => state.setMaterialOpen);
  const materialRef = usePanelRef();

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
  // 电源键不是导航键（不在投屏下面那条里）：跟着"设备功能"放面板头。
  // macOS 本机窗口发不了电源键 → 这台设备就不显示
  const powerKey = device ? powerKeyFor(device.kind) : null;
  // 画面 / 素材区 上下可拖：素材多的时候素材区要能拖高，单看画面时又要能压扁
  const view = useLayoutGroup(SCREEN_LAYOUT);

  return (
    <PanelShell
      title="画面"
      actions={
        <>
          <GhostButton
            disabled={ocrDownloading}
            onClick={() => {
              if (ocrScanBusy) {
                void cancelRecognize();
                return;
              }
              if (!isConnected) {
                useSessionStore.setState({
                  error: `设备未连接：先连上设备才能 OCR 识字（当前 ${device?.name ?? '无设备'}）`,
                });
                return;
              }
              void scanScreenForPick(activeId);
            }}
            title={
              ocrDownloading
                ? `${ocrStatus.stage || '正在加载 PP-OCRv4 模型…'} ${Math.round(ocrStatus.progress)}%`
                : ocrScanBusy
                  ? '停止 OCR 扫描（推理在后台结束，不再阻塞界面）'
                  : isConnected
                    ? '扫描当前画面文字'
                    : `设备未连接：先连上设备才能 OCR 识字（当前 ${device?.name ?? '无设备'}）`
            }
          >
            {ocrDownloading || ocrScanBusy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ScanText className="size-3" />
            )}
            {ocrDownloading ? `${Math.round(ocrStatus.progress)}%` : ocrScanBusy ? '停止' : 'OCR'}
          </GhostButton>
          <GhostButton
            active={controlMode}
            onClick={toggleControl}
            title={
              controlMode
                ? '控制已开启：点击画面=轻触，拖拽=滑动（录制元素时自动让位）'
                : '控制已关闭：画面上的操作只用于框选/点选录制'
            }
          >
            <MousePointerClick className="size-3" />
            控制
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
          {/* 电源键：不属于"导航键"，所以不占投屏下面那条；这台设备没有就不显示 */}
          {powerKey && (
            <>
              <span className="mx-0.5 h-3 w-px bg-line" />
              <GhostButton
                disabled={!isConnected}
                onClick={() => void pressKey(activeId, powerKey.id)}
                title={
                  isConnected
                    ? powerKey.hint
                    : `设备未连接：先连上设备才能按键（当前 ${device?.name ?? '无设备'}）`
                }
              >
                <Power className="size-3" />
                {powerKey.label}
              </GhostButton>
            </>
          )}
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
              控制条属于"画面"这一格，拖高素材区时它不会被推走 */}
          <div className="flex h-full min-h-0 flex-col bg-canvas">
            <EmulatorDisplayTabs />
            <div className="flex min-h-0 flex-1 flex-col gap-1 p-2">
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
                  <EmptyState onOpenPanel={() => toggleDevicePopover(true)} />
                )}
              </div>
              {/* 多开时按键条跟着"当前设备那一格"走（见 GridTile），单画面才挂在投屏框下面
                  —— 整片网格里只允许有一条（用户反馈：挂外面看不出按的是哪台设备） */}
              {!gridView && device && device.status === 'connected' && (
                <DeviceControls deviceId={device.id} deviceName={device.name} kind={device.kind} />
              )}
            </div>
          </div>
        </Panel>
        <Separator
          className="h-px bg-line transition-colors hover:bg-brand"
          title="拖动改高度（拖到底会收起素材区）· 双击恢复默认"
        />
        {/* 素材区可以收起来：收起时只留 28px 的标题行（展开按钮还在），画面拿走全部高度。
            和底部调试抽屉同一套做法：`collapsible` + panelRef，状态在 ui.store，
            尺寸听 store 的（拖动改尺寸是用户交互，会被布局记忆存下来） */}
        <Panel
          id="materials"
          defaultSize="30%"
          minSize={`${MATERIAL_MIN_PX}px`}
          collapsible
          collapsedSize={`${MATERIAL_COLLAPSED_PX}px`}
          panelRef={materialRef}
          onResize={() => {
            // 拖到底（或拖出来）时面板自己会折叠：把状态同步回 store，
            // 否则标题上的"收起/展开"会和真实状态相反，一点就卡住
            const collapsed = materialRef.current?.isCollapsed() ?? false;
            if (materialOpen !== !collapsed) {
              setMaterialOpen(!collapsed);
            }
          }}
          style={{ overflow: 'hidden' }}
        >
          <MaterialArea deviceId={activeId} recognizers={recognizers} panelRef={materialRef} />
        </Panel>
      </Group>
    </PanelShell>
  );
}

/* ------------------------------------------------------------------ 空态 */

function EmptyState({ onOpenPanel }: { onOpenPanel: () => void }): ReactNode {
  const devices = useDeviceStore((state) => state.devices);
  const connect = useSessionStore((state) => state.connect);
  const discovered = connectableDevices(devices)
    .filter((device) => device.status !== 'connected')
    .slice(0, 4);

  return (
    // 画面区可上下拖，拖矮时空态会超高：给滚动条。
    // m-auto + 受限宽度：空间够就水平垂直都居中；超出时从顶部开始滚（不会被裁掉）。
    <div className="flex h-full flex-col overflow-auto">
      <div className="m-auto flex w-full max-w-[420px] flex-col items-center gap-3 px-4 py-2">
        <span className="text-panelhead text-dim">还没有连接设备</span>
        <p className="text-center text-badge text-faint">
          点下面列表里的一台设备直接连上 · 安卓先在手机上允许 USB 调试
        </p>
        <button
          type="button"
          onClick={onOpenPanel}
          title="打开设备面板：搜索、按来源分类、手动输 URI"
          className="h-7 rounded-sm bg-brand px-4 text-body font-medium text-[#0b0d12] hover:opacity-90"
        >
          连接设备
        </button>
        <div className="w-full text-badge text-faint">
          {discovered.length > 0 && <div className="mb-1 text-dim">已发现</div>}
          {/* 点一行 = 直接连它（以前点了只是打开设备面板，“没真的连上”，用户反馈过） */}
          {discovered.map((device) => {
            const connecting = device.status === 'connecting';
            return (
              <button
                key={device.id}
                type="button"
                disabled={connecting}
                onClick={() => void connect(device.id, device.uri)}
                title={`${device.uri}\n点一下直接连接`}
                className="flex h-[26px] w-full items-center gap-2 px-1 text-left hover:bg-raised disabled:cursor-wait disabled:opacity-70"
              >
                <StatusDot tone={device.status === 'failed' ? 'failed' : connecting ? 'pending' : 'idle'} />
                <span className="min-w-0 flex-1 truncate text-body text-fg">{device.name}</span>
                <span>{formatResolution(device.resolution)}</span>
                <span className="text-dim">{connecting ? '连接中…' : '→'}</span>
              </button>
            );
          })}
          {discovered.length === 0 && (
            <div className="px-1 py-2">还没发现设备 · 确认手机已插好并允许 USB 调试</div>
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
 * - `swipe` —— 滑动：起点实心点 → 连线 → 终点空心圈 + 箭头，拖动中落点实时更新
 *
 * 只在 `recordActionMode` 为真时出现：这两样东西的用途是"看清这一段会被录成什么"，
 * 正常控制时它们只是糊在投屏上的杂物（用户明确要求过：正常控制一个辅助都不要）。
 *
 * 为什么强调互斥：曾经是"按下闪一个 + 抬手闪一个"，滑动时就成了**两个分开的点击**，
 * 用户看到的是"我点歪了两下"，而实际发生的是"从 A 滑到 B"。
 */
type TouchFeedbackDraft =
  | { readonly kind: 'tap'; readonly point: GesturePoint }
  | {
      readonly kind: 'swipe';
      readonly from: GesturePoint;
      readonly to: GesturePoint;
      /** 真实走过的点：≥3 点画折线（连续滑动），否则画起止直线 */
      readonly points?: readonly GesturePoint[];
    };

type TouchFeedback = TouchFeedbackDraft & { readonly id: number };

/** 辅助在画面上停留多久（ms）：和 `animate-touch-ping` 的时长一致，扩散环播完即收。 */
const FEEDBACK_TTL_MS = 520;
/** 录制滑动时轨迹多留一会儿（看得清自己拖了一条什么线）。 */
const SWIPE_TRAIL_TTL_MS = 1400;

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
  const scanVisual = useOcrStore((state) =>
    state.scanVisual?.deviceId === deviceId ? state.scanVisual : null,
  );
  const pickBoxes = useOcrStore((state) => state.pickBoxes[deviceId] ?? EMPTY_OCR_BOXES);
  // 画面上的鼠标/指针操作按"控制"与"录操作"两个开关决定行为（开关按钮在画面下方的控制条里）
  const controlMode = useUiStore((state) => state.controlMode);
  const recordActionMode = useUiStore((state) => state.recordActionMode);
  const pendingFlowSwipeStepId = useUiStore((state) => state.pendingFlowSwipeStepId);
  const pendingFlowSwipeMode = useUiStore((state) => state.pendingFlowSwipeMode);
  const clearPendingFlowSwipeStep = useUiStore((state) => state.clearPendingFlowSwipeStep);
  const showSwipeRecordGuide = recordActionMode || Boolean(pendingFlowSwipeStepId);
  const draft = useUiStore((state) => state.draft);
  const beginDraft = useUiStore((state) => state.beginDraft);
  // 触控反馈存的是**画面归一化坐标**，渲染时要换算成容器像素（否则有黑边时看起来是偏的）
  const [feedback, setFeedback] = useState<TouchFeedback | null>(null);
  /** 引导条上的实时轨迹点数（简化后）：拖的时候能看见"这一笔已经成线了"。 */
  const liveTrackPoints =
    feedback?.kind === 'swipe' && feedback.points ? simplifyTrack(feedback.points).length : 0;
  const feedbackSeq = useRef(0);
  const feedbackTimer = useRef<number | null>(null);
  /** 录制态的鼠标位置（十字准星读数） */
  const [pointer, setPointer] = useState<[number, number] | null>(null);

  /**
   * 画一次触控反馈（同一时刻只画一个）。
   *
   * 这里是"滑动被画成两个点击"那个 bug 的关键：反馈是**互斥**的两种形态，
   * 抬手时不能在终点再补一个波纹 —— 起点一个 + 终点一个，看起来就是点歪了两下。
   */
  const showFeedback = (next: TouchFeedbackDraft, ttlMs = FEEDBACK_TTL_MS): void => {
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
    }, ttlMs);
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

  /**
   * 画面上的辅助：**只有录操作 / 待录滑动时才画**，正常控制一个都不留。
   *
   * 手势本身（换算、限频、判定轻触/滑动、录成 click 还是 swipe）全在
   * `useScreenSurface` 里 —— 单画面与多开网格共用同一把尺子，这里只管画。
   */
  const onGesture = (gesture: SurfaceGesture): void => {
    const from: GesturePoint = [gesture.from[0], gesture.from[1]];
    const to: GesturePoint = [gesture.to[0], gesture.to[1]];
    if (gesture.phase === 'down') {
      // 按下先闪一下：手感反馈不等抬手（这一下是点还是滑，要拖出去才知道）
      if (showSwipeRecordGuide) {
        showFeedback({ kind: 'tap', point: to });
      }
      return;
    }
    const points = gesture.points.map(([x, y]): GesturePoint => [x, y]);
    if (gesture.phase === 'move') {
      if (!gesture.swipe) {
        return;
      }
      // 从"按一下"变成"拖出去"了：正常控制下把按下那个波纹收掉
      if (showSwipeRecordGuide) {
        showFeedback({ kind: 'swipe', from, to, points }, SWIPE_TRAIL_TTL_MS);
      } else {
        clearFeedback();
      }
      return;
    }
    // 抬手：画最终形态（轻触 = 落点标记，滑动 = 停在终点的轨迹，**不补第二个点击标记**）
    if (showSwipeRecordGuide) {
      showFeedback(
        gesture.swipe ? { kind: 'swipe', from, to, points } : { kind: 'tap', point: to },
        // 录连续滑动时轨迹留久一点：松手 0.5 秒就消失，人会以为"没录上轨迹"
        pendingFlowSwipeStepId ? SWIPE_TRAIL_TTL_MS : FEEDBACK_TTL_MS,
      );
    } else {
      clearFeedback();
    }
    devLog(
      `控制: 手势=${gesture.swipe ? '滑动' : '轻触'} (${from[0].toFixed(3)},${from[1].toFixed(3)})` +
        ` → (${to[0].toFixed(3)},${to[1].toFixed(3)})`,
    );
  };

  const {
    viewportRef: viewport,
    imgRef,
    imageBox,
    selection,
    selectionViewportRect,
    handlers,
  } = useScreenSurface({
    deviceId,
    // 单画面永远是"当前设备"，不存在点别人格子切设备的情况
    active: true,
    activeInGrid: true,
    frame,
    onActivate: () => {},
    onGesture,
    onHover: setPointer,
  });

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
  }, [viewport]);

  // 画面区域变化时记一条：确认控制坐标用的是"画出来的那块"，不是整个容器
  const lastBoxKey = useRef('');
  useEffect(() => {
    if (!imageBox) {
      return;
    }
    const key = `画面区域 ${Math.round(imageBox.left)},${Math.round(imageBox.top)} ${Math.round(imageBox.width)}x${Math.round(imageBox.height)}`;
    if (key !== lastBoxKey.current) {
      lastBoxKey.current = key;
      devLog(`${key}（黑边不参与控制）`);
    }
  }, [imageBox]);

  // 准星读数只在录制态渲染（`recordMode !== 'off'` 那一处），所以退出录制后不用清 state

  const selectedNodeId = useGraphStore((state) => state.selectedNodeId);
  const flowSteps = useGraphStore(
    (state) => graphForDevice(state, deviceId)?.flow?.steps ?? EMPTY_FLOW_STEPS,
  );
  const selectedClickRegion = useMemo(() => {
    if (!selectedNodeId) {
      return null;
    }
    const step = flowSteps.find((item) => item.id === selectedNodeId);
    if (!step || (step.type !== 'click' && step.type !== 'hold')) {
      return null;
    }
    if (clickTargetMode(step.params) !== 'region' || !isNormRect(step.params?.rect)) {
      return null;
    }
    return step.params.rect;
  }, [flowSteps, selectedNodeId]);

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
      data-screen-viewport
      {...handlers}
      data-testid="screen-viewport"
      data-capture-keep
      className={cn(
        'relative min-h-0 w-full flex-1 border border-line bg-[#0b0d12]',
        screenCursorClass(recordMode, controlMode),
      )}
    >
      {frame ? (
        <img
          ref={imgRef}
          /*
           * `imageUrl` 为空串时**必须传 undefined**：React 收到 `src=""` 会告警
           * （空 src 会让浏览器把当前页面再下载一遍）。帧先到、blob URL 后到的那一瞬间就是这种状态。
           */
          src={frame.imageUrl || undefined}
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

      {/* 录制滑动的引导条：点了录制之后**没有任何字**告诉用户该在哪拖，
          用户会以为按钮没反应（实际是左栏收着 / 不知道该拖画面）。这里有字、有取消。 */}
      {pendingFlowSwipeStepId && (
        <div
          data-testid="swipe-record-guide"
          className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-0.5 border-b border-brand/40 bg-canvas/90 px-2 py-1"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-badge text-brand">
              {pendingFlowSwipeMode === 'single'
                ? '录制单次滑动：在画面上拖一下松手'
                : '录制连续滑动：拖出轨迹，松手写入（按住 Shift = 直线）'}
            </span>
            <button
              type="button"
              data-testid="swipe-record-cancel"
              // 指针事件得拦住：不拦的话按到按钮上等于在画面上按下了（会开始拖）
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => clearPendingFlowSwipeStep()}
              className="pointer-events-auto nodrag nopan rounded-sm border border-line bg-canvas px-1.5 py-0.5 text-badge text-dim hover:border-brand/50 hover:text-fg"
            >
              取消
            </button>
          </div>
          <span className="text-badge text-faint" data-testid="swipe-record-progress">
            {pendingFlowSwipeMode === 'single'
              ? '只记起止点与时长（直线）；屏幕上那条线就是它，原来录过的轨迹会被清掉'
              : liveTrackPoints >= 3
                ? `正在记轨迹：${liveTrackPoints} 点（松手写入，屏幕上那条线就是它）`
                : liveTrackPoints > 0
                  ? '拖着走：松手写入轨迹；按住 Shift = 起止直线，到终点停 0.2 秒再松手 = 记「按住」'
                  : '拖出轨迹 = 连续滑动；按住 Shift = 直线；到终点停 0.2 秒再松手 = 记「按住」'}
          </span>
        </div>
      )}

      {/* 录操作辅助（两种形态互斥，**只有录操作时才画**；正常控制一个都不画）：
          轻触 = 落点上的小圆点 + 一圈从中心荡开的扩散环（抬手再播一次 = "这一下录进去了"）；
          滑动 = 起点实心点 → 连线 → 终点空心圈 + 箭头（"这一段会被录成 swipe"）。
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
        <SwipeTrail from={feedback.from} to={feedback.to} points={feedback.points} box={imageBox} />
      )}

      {/* 识别框：绿=投票已确认 / 橙=待确认；坐标是引擎给的归一化值 */}
      {detections.map((item) => {
        const [x, y, w, h] = item.rect;
        const tone = item.ambiguous
          ? 'border-pending border-dashed text-pending'
          : item.state === 'confirmed'
            ? 'border-confirmed text-confirmed'
            : 'border-pending text-pending';
        return (
          <div
            key={item.label}
            className={cn('pointer-events-none absolute border', tone)}
            title={item.ambiguous ? '有多个同分候选：点击会拒绝猜位置，请提高阈值或改回原区域' : undefined}
            style={
              // 引擎给的是"相对画面"的归一化框：黑边不参与
              canvasRectToPixels(imageBox, [x, y, w, h]) ?? { left: 0, top: 0, width: 0, height: 0 }
            }
          >
            <span className="absolute -top-4 left-0 text-badge whitespace-nowrap">
              {item.label} {item.score.toFixed(2)}
              {item.ambiguous ? ' · 多个候选' : ''}
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

      {/* OCR 扫描激光特效（手动点击整屏扫描或框选区域 OCR 时展示） */}
      {scanVisual && imageBox && (
        <div
          data-testid="ocr-scan-effect"
          style={
            scanVisual.rect
              ? (canvasRectToPixels(imageBox, scanVisual.rect) ?? {
                  left: imageBox.left,
                  top: imageBox.top,
                  width: imageBox.width,
                  height: imageBox.height,
                })
              : {
                  left: imageBox.left,
                  top: imageBox.top,
                  width: imageBox.width,
                  height: imageBox.height,
                }
          }
          className="pointer-events-none absolute z-30 overflow-hidden border border-brand/90 bg-brand/10"
        >
          {/* 四角激光取景框装饰 */}
          <span className="absolute top-0 left-0 size-2.5 border-t-2 border-l-2 border-brand" />
          <span className="absolute top-0 right-0 size-2.5 border-t-2 border-r-2 border-brand" />
          <span className="absolute bottom-0 left-0 size-2.5 border-b-2 border-l-2 border-brand" />
          <span className="absolute bottom-0 right-0 size-2.5 border-b-2 border-r-2 border-brand" />
          {/* 科技感网格底纹 */}
          <div
            className="absolute inset-0 opacity-25"
            style={{
              backgroundImage:
                'linear-gradient(to right, rgba(77,163,255,0.28) 1px, transparent 1px), linear-gradient(to bottom, rgba(77,163,255,0.28) 1px, transparent 1px)',
              backgroundSize: '20px 20px',
            }}
          />
          {/* 上下往返扫描激光束 */}
          <div
            data-testid="ocr-scan-beam"
            className="animate-ocr-scan absolute right-0 left-0 h-[2px] bg-brand shadow-[0_0_12px_2px_rgba(77,163,255,0.95)]"
          >
            <div className="absolute right-0 bottom-0 left-0 h-7 bg-gradient-to-t from-brand/35 to-transparent" />
          </div>
          {!scanVisual.rect && (
            <button
              type="button"
              data-testid="ocr-scan-stop"
              className="pointer-events-auto absolute right-2 bottom-2 flex items-center gap-1 rounded-sm border border-brand/40 bg-canvas/90 px-2 py-0.5 text-[10px] font-medium text-brand hover:bg-brand/15"
              onClick={() => void useOcrStore.getState().cancelRecognize()}
            >
              <Loader2 className="size-3 animate-spin" />
              OCR 扫描中… 点击停止
            </button>
          )}
        </div>
      )}

      {/* 点 OCR 扫描后的可点选文字框：点哪个文字框就直接取它的区域并自动填入文字名称 */}
      {!draft &&
        imageBox &&
        pickBoxes.map((item, idx) => {
          const boxStyle = canvasRectToPixels(imageBox, item.rect);
          if (!boxStyle) {
            return null;
          }
          const cleanText = sanitizeOcrLabel(item.text);
          return (
            <button
              key={`${idx}-${item.text}-${item.rect[0]}-${item.rect[1]}`}
              type="button"
              data-testid="ocr-pick-box"
              title={`点击选取「${cleanText}」(${Math.round(item.score * 100)}%)`}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onMouseUp={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                beginDraft({
                  rect: item.rect,
                  resolution: frame?.resolution,
                  score: item.score,
                  mode: 'pick',
                  pickCenter: [item.rect[0] + item.rect[2] / 2, item.rect[1] + item.rect[3] / 2],
                  label: cleanText,
                  // 扫出来的文字直接带进「文字识别」表单：点一下文字框就是想认它
                  kind: 'ocr',
                  text: cleanText,
                });
              }}
              style={boxStyle}
              className="group absolute z-10 cursor-pointer border border-brand/80 bg-brand/15 transition-colors hover:border-2 hover:border-brand hover:bg-brand/30"
            >
              <span className="pointer-events-none absolute -top-4 left-0 max-w-[140px] truncate rounded-xs bg-brand px-1 py-0 text-[10px] leading-4 font-medium text-[#0b0d12] shadow-xs">
                {cleanText}
              </span>
            </button>
          );
        })}

      {/* 框选进行中的选区 */}
      {selection && imageBox && (
        <SelectionFrame
          rectPx={canvasRectToPixels(imageBox, selection) ?? { left: 0, top: 0, width: 0, height: 0 }}
          label={`${selection[2].toFixed(3)} × ${selection[3].toFixed(3)}`}
        />
      )}

      {/* 待确认草稿：可拖动位置、四角改大小 */}
      {draft && imageBox && (!draft.deviceId || draft.deviceId === deviceId) && !selection && (
        <DraftSelectionBox imageBox={imageBox} draft={draft} />
      )}

      {selectedClickRegion && !selection && !draft?.rect && imageBox ? (
        <div
          data-testid="click-region-overlay"
          className="pointer-events-none absolute border-2 border-warn/90 bg-warn/10"
          style={
            canvasRectToPixels(imageBox, selectedClickRegion) ?? {
              left: 0,
              top: 0,
              width: 0,
              height: 0,
            }
          }
        >
          <span className="absolute -top-4 left-0 rounded-xs bg-warn/90 px-1 text-[10px] text-[#0b0d12]">
            随机点击范围
          </span>
        </div>
      ) : null}

      {/* 画面左下角浮层（帧信息 + 运行态**合成一条**）：
          排查"看不见画面/不推进"时这是最直接的证据。
          以前这是两块都锚在 bottom-1 left-1 的浮层 —— 叠在一起，字糊成一团
          （截图里 "node=64 tick=2908 7.7fps 7fps" 就是这么来的） */}
      {frame && (
        <span
          data-testid="frame-overlay"
          className="pointer-events-none absolute bottom-1 left-1 flex max-w-[calc(100%-0.5rem)] flex-wrap items-center gap-x-2 rounded-sm bg-black/55 px-1.5 py-0.5 text-badge text-white/85"
        >
          <span>
            帧 #{frame.index} · {frame.resolution[0]}×{frame.resolution[1]} · {frame.fps.toFixed(1)}fps
          </span>
          <span className="text-white/60">
            node={frame.node ?? '-'} · tick={frame.tick}
            {frame.pending ? ` · pending→${frame.pending}` : ''}
          </span>
        </span>
      )}

      {draft && imageBox && (!draft.deviceId || draft.deviceId === deviceId) && !selection && (
        <DraftForm deviceId={deviceId} anchor={selectionViewportRect(draft.rect)} />
      )}
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
 * 滑动轨迹（**只在录操作时出现**）：起点实心点 → 连线 → 终点空心圈 + 方向箭头。
 *
 * 用一条"从这里滑到那里"的轨迹，而不是两个点：点和点的组合传达的是**两次点击**，
 * 轨迹传达的才是**一次滑动**。拖动过程中落点实时更新，所以看得见自己滑了多远。
 *
 * 样式与轻触反馈同一套：品牌色本体 + canvas 描边垫层（亮底投屏上也清晰），线段在端点圆环处截断。
 */
function SwipeTrail({
  from,
  to,
  points,
  box,
}: {
  from: GesturePoint;
  to: GesturePoint;
  /** 真实走过的采样点：≥3 点时画折线（连续滑动），否则画起止直线 */
  points?: readonly GesturePoint[];
  box: Box;
}): ReactNode {
  const start = canvasPointToPixels(box, from);
  const end = canvasPointToPixels(box, to);
  if (!start || !end) {
    return null;
  }
  // 用录制那一套简化（RDP + ≤32 点）再画：屏幕上这条线 = 会写进 `path` 的线。
  // 直线拖完简化成 2 点 ⇒ 走直线分支，不会因为"直线上多采了几个点"就画成折线。
  const shaped = simplifyTrack(points ?? []);
  const traced = shaped
    .map((point) => canvasPointToPixels(box, point))
    .filter((point): point is { left: number; top: number } => point !== null);
  const tracedPath = traced.length >= 3 ? traced : null;

  const START_R = 3.5;
  const END_R = 7;
  const ARROW_R = 4.5;

  // 方向与长度都按"真实轨迹"算：折线用最后一小段定方向，直线就是整段
  const last = tracedPath?.[tracedPath.length - 1] ?? end;
  const prev = tracedPath?.[tracedPath.length - 2] ?? start;
  const dx = last.left - prev.left;
  const dy = last.top - prev.top;
  const tail = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const pathSpan = tracedPath
    ? tracedPath.reduce(
        (total, point, index) =>
          index === 0
            ? 0
            : total +
              Math.hypot(point.left - tracedPath[index - 1]!.left, point.top - tracedPath[index - 1]!.top),
        0,
      )
    : Math.hypot(end.left - start.left, end.top - start.top);
  // 太短的轨迹不放箭头：箭头会盖在两个圆点上，反而看不清（刚过阈值的滑动就属于这种）
  const showArrow = pathSpan > 34;
  const arrowLead = showArrow ? ARROW_R + 3 : 0;

  const ux = tail > 0 ? dx / tail : 1;
  const uy = tail > 0 ? dy / tail : 0;
  const trimStart = !tracedPath && pathSpan > START_R + END_R + arrowLead + 2;
  const lineStart = trimStart
    ? { x: start.left + ux * START_R, y: start.top + uy * START_R }
    : { x: start.left, y: start.top };
  const lineEnd = trimStart
    ? { x: end.left - ux * (END_R + arrowLead), y: end.top - uy * (END_R + arrowLead) }
    : { x: end.left, y: end.top };
  const arrowPath = 'M 0 -3.25 L 6.5 0 L 0 3.25 Z';
  const arrowAt = `translate(${last.left} ${last.top}) rotate(${angle}) translate(${END_R + 1.5} 0)`;
  const polyline = tracedPath?.map((point) => `${point.left},${point.top}`).join(' ');
  return (
    <svg
      data-testid="touch-swipe"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full text-brand"
      shapeRendering="geometricPrecision"
    >
      {/* 起止直线（测试读起止像素坐标；连续滑动时只当透明兜底，看得见的是下面的折线） */}
      <line
        data-testid="touch-swipe-line"
        x1={start.left}
        y1={start.top}
        x2={end.left}
        y2={end.top}
        className="stroke-brand"
        strokeWidth={2}
        strokeLinecap="round"
        strokeOpacity={0.92}
        visibility={polyline ? 'hidden' : undefined}
      />

      {polyline ? (
        <>
          {/* 连续滑动：按真实采样点画折线（这条线就是会被录进 path 的东西） */}
          <polyline
            points={polyline}
            className="fill-none stroke-canvas"
            strokeWidth={4.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity={0.72}
          />
          <polyline
            data-testid="touch-swipe-path"
            points={polyline}
            className="fill-none stroke-brand"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity={0.95}
          />
        </>
      ) : (
        <>
          {/* 垫层：线段 */}
          <line
            x1={lineStart.x}
            y1={lineStart.y}
            x2={lineEnd.x}
            y2={lineEnd.y}
            className="stroke-canvas"
            strokeWidth={4.5}
            strokeLinecap="round"
            strokeOpacity={0.72}
          />
          <line
            x1={lineStart.x}
            y1={lineStart.y}
            x2={lineEnd.x}
            y2={lineEnd.y}
            className="stroke-brand"
            strokeWidth={2}
            strokeLinecap="round"
            strokeOpacity={0.92}
          />
        </>
      )}

      {/* 起点：与轻触落点同尺度的实心点 */}
      <circle cx={start.left} cy={start.top} r={START_R + 2.25} className="fill-canvas" fillOpacity={0.65} />
      <circle cx={start.left} cy={start.top} r={START_R} className="fill-brand" />
      <circle
        cx={start.left}
        cy={start.top}
        r={START_R}
        className="fill-none stroke-canvas"
        strokeWidth={2}
        strokeOpacity={0.55}
      />

      {/* 终点：空心圈 + 方向箭头 */}
      <circle
        cx={end.left}
        cy={end.top}
        r={END_R + 2}
        className="fill-none stroke-canvas"
        strokeWidth={3.5}
        strokeOpacity={0.65}
      />
      <circle
        cx={end.left}
        cy={end.top}
        r={END_R}
        className="fill-none stroke-brand"
        strokeWidth={2}
        strokeOpacity={0.95}
      />
      {showArrow && <path d={arrowPath} transform={arrowAt} className="fill-canvas" fillOpacity={0.65} />}
      {showArrow && <path d={arrowPath} transform={arrowAt} className="fill-brand" />}
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
  // 这个订阅必须放在下面的早退**之前**：hooks 不能有条件地调用
  const draft = useUiStore((state) => state.draft);

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

  // 草稿归属的设备这一屏里还有没有它的格子（掉线时没有 → 浮层要兜底，否则草稿摸不到）
  const draftHasTile = Boolean(draft?.deviceId && connected.some((item) => item.id === draft.deviceId));

  return (
    <>
      {/*
        行高给**下限 132px**：当前设备那格多一条按键条（约 30px），头/脚栏又都是 shrink-0，
        `minmax(0, 1fr)` 在面板矮的时候会把画面压到接近 0（"多开看不到画面"的第二形态）。
        放不下就让它自己滚（overflow-auto），宁可滚动也不要压没画面。
      */}
      <div
        ref={gridRef}
        data-testid="screen-grid"
        className="grid h-full min-h-0 gap-1 overflow-auto"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridAutoRows: 'minmax(132px, 1fr)',
          gridTemplateRows: `repeat(${Math.ceil(connected.length / columns)}, minmax(132px, 1fr))`,
        }}
      >
        {connected.map((device) => (
          <GridTile
            key={device.id}
            deviceId={device.id}
            name={device.name}
            kind={device.kind}
            resolution={device.resolution}
            frame={frames[device.id]}
            link={links[device.id]}
            active={device.id === activeId}
            activeInGrid={connected.some((item) => item.id === activeId)}
            onActivate={() => setActive(device.id)}
            draft={draft?.deviceId === device.id ? draft : null}
          />
        ))}
      </div>

      {/* 草稿归属的设备掉线了（这一屏里没有它的格子）：浮层兜底挂在面板上，
          保证"确定并写入状态图"始终有且只有一个入口，草稿不会卡在 store 里 */}
      {draft && !draftHasTile && <DraftForm deviceId={draft.deviceId ?? activeId} />}
    </>
  );
}

/**
 * 多开里的一格：**头栏 / 脚栏只切设备**，中间的画面区才是"操作这台设备"的地方
 * （坐标换算与录制逻辑和单画面共用 `useScreenSurface`）。
 *
 * 为什么按键条（返回/桌面/最近任务）挂在**这一格里面**：挂整片网格外面时，
 * 看不出按的是哪台设备、离画面也远（用户反馈）。
 */
function GridTile({
  deviceId,
  name,
  kind,
  resolution,
  frame,
  link,
  active,
  activeInGrid,
  onActivate,
  draft,
}: {
  deviceId: string;
  name: string;
  kind: DeviceRuntime['kind'];
  resolution: readonly [number, number] | null;
  frame: FrameState | undefined;
  link: { channel: string; note: string } | undefined;
  active: boolean;
  activeInGrid: boolean;
  onActivate: () => void;
  draft: RecordDraft | null;
}): ReactNode {
  const { viewportRef, imgRef, imageBox, selection, selectionViewportRect, handlers } = useScreenSurface({
    deviceId,
    active,
    activeInGrid,
    frame,
    onActivate,
  });
  const recoverImage = useSessionStore((state) => state.recoverImage);
  const liveRoots = useSessionStore((state) => state.runningWorkflowRoots[deviceId]);
  const recordMode = useUiStore((state) => state.recordMode);
  const controlMode = useUiStore((state) => state.controlMode);
  const liveName = deviceRunLabel((liveRoots ?? []).map(taskName));

  return (
    <div
      data-testid={`grid-tile-${deviceId}`}
      // `@container`：按键条的文字在窄格子里要收成图标（`@[210px]:inline`）
      className={cn(
        '@container relative flex min-h-0 flex-col items-stretch border bg-[#0b0d12]',
        active ? 'border-brand' : 'border-line',
      )}
    >
      <button
        type="button"
        data-testid={`grid-head-${deviceId}`}
        onClick={onActivate}
        className="flex h-6 shrink-0 items-center gap-2 border-b border-line bg-panel px-2 text-left"
      >
        <StatusDot tone="confirmed" />
        <span className={cn('min-w-0 truncate text-body', liveName && 'text-brand')}>{name}</span>
        <span className="flex-1" />
        {liveName ? (
          <span
            className="max-w-[5rem] shrink-0 truncate text-badge text-brand"
            title={`运行中 · ${liveName}`}
          >
            {liveName}
          </span>
        ) : (
          <span className="shrink-0 text-badge text-faint">{frame ? `${frame.fps}fps` : '—'}</span>
        )}
      </button>

      <div
        ref={viewportRef}
        data-testid={`grid-screen-${deviceId}`}
        data-screen-viewport
        data-capture-keep
        {...handlers}
        className={cn(
          'relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden',
          screenCursorClass(recordMode, controlMode),
        )}
      >
        {frame ? (
          <img
            ref={imgRef}
            // 空串会给 React 告警（浏览器会把当前页面当成图片地址再拉一遍），传 undefined
            src={frame.imageUrl || undefined}
            alt={`${name} 画面`}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
            draggable={false}
            onError={() => {
              devLog(`多开瓦片 ${deviceId} img 加载失败 url=${frame.imageUrl.slice(0, 24) || '(空)'}`);
              void recoverImage(deviceId);
            }}
          />
        ) : (
          <span className="flex flex-col items-center gap-1 text-badge text-faint">
            <span>{name} · 等待首帧…</span>
            <span>通道 {link ? link.channel : '-'} · 若一直如此看顶部红条</span>
          </span>
        )}

        {/* 框选进行中的选区：和单画面同一套换算（黑边不进选区） */}
        {selection && imageBox && (
          <SelectionFrame
            rectPx={canvasRectToPixels(imageBox, selection) ?? { left: 0, top: 0, width: 0, height: 0 }}
            label={`${selection[2].toFixed(3)} × ${selection[3].toFixed(3)}`}
          />
        )}

        {/* 待确认草稿：可拖动位置、四角改大小 */}
        {draft && imageBox && !selection && <DraftSelectionBox imageBox={imageBox} draft={draft} />}

        {/* 录制草稿表单：只画在**草稿归属的那一格**里（切到别的格子看一眼也不搬家） */}
        {draft && !selection && <DraftForm deviceId={deviceId} anchor={selectionViewportRect(draft.rect)} />}
      </div>

      <button
        type="button"
        data-testid={`grid-foot-${deviceId}`}
        onClick={onActivate}
        className="flex h-5 shrink-0 items-center justify-between border-t border-line px-2 text-badge text-faint"
      >
        <span>{formatResolution(resolution)}</span>
        <span>{frame ? `帧 #${frame.index} · ${frame.fps.toFixed(1)}fps` : '无帧'}</span>
      </button>

      {/* 按键条跟着**当前设备**那一格走（整片网格里只有一条） */}
      {active && <DeviceControls deviceId={deviceId} deviceName={name} kind={kind} />}
    </div>
  );
}

/* ---------------------------------------------------------- 底部素材区 */

/** 这一帧"命中"了吗：待确认/稳定都算命中，只有 idle 是没命中。 */
function isHit(item: RecognizerView): boolean {
  return item.state !== 'idle';
}

/** 导出只为单测直接渲染这一格（不用把 <img> 量测、指针坐标那一整套搭起来）。 */
export function MaterialArea({
  deviceId,
  recognizers,
  panelRef,
}: {
  deviceId: string;
  recognizers: readonly RecognizerView[];
  /** 自己那一格的面板句柄：收起/展开是命令式的（Panel 的 collapse/expand） */
  panelRef: React.RefObject<PanelImperativeHandle | null>;
}): ReactNode {
  // 筛选放 store：换设备/面板重挂之后选择还在（和 controlMode 那些一个规矩）
  const filter = useUiStore((state) => state.materialFilter);
  const setFilter = useUiStore((state) => state.setMaterialFilter);
  const open = useUiStore((state) => state.materialOpen);
  const setOpen = useUiStore((state) => state.setMaterialOpen);
  const beginOcr = useUiStore((state) => state.beginOcrRecognizerCapture);
  const rename = useSessionStore((state) => state.renameRecognizer);
  const removeRecognizer = useSessionStore((state) => state.removeRecognizer);
  const graph = useGraphStore((state) => graphForDevice(state, deviceId));
  const selectedNodeId = useGraphStore((state) => state.selectedNodeId);
  const focusNode = useGraphStore((state) => state.focusNode);
  // 正在改名的行：值 + 校验错误（null = 可以提交）
  const [editing, setEditing] = useState<{ label: string; value: string; error: string | null } | null>(null);
  const [query, setQuery] = useState('');
  // 这次编辑是否已经了结（提交成功 / Esc 取消）：输入框卸载时浏览器还会补一个 blur，
  // 不挡住的话同一个改名会发两遍（第二遍必然报"识别器不存在"）
  const finished = useRef(false);

  const hits = useMemo(() => recognizers.filter(isHit), [recognizers]);
  const rows = useMemo(() => {
    const pool = filter === 'hit' ? hits : recognizers;
    return searchMaterials(pool, query, (item) =>
      describeRecognizerUsage(collectRecognizerUsage(graph, item.label)),
    );
  }, [filter, hits, recognizers, query, graph]);
  const searchActive = query.trim().length > 0;

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
    // 高度由上方分隔线决定；列表自己滚动（素材一多，撑开会把画面挤没）
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-panel">
      <div className="flex h-7 shrink-0 items-center gap-2 px-2 text-badge text-faint">
        {/* 标题本身就是收起/展开的开关：收起后画面拿走全部高度，这一行还留着（点得到） */}
        <button
          type="button"
          data-testid="material-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title={
            open ? '收起素材区（画面更高；也可以把上面的横线拖到底）' : '展开素材区（缩略图 · 分数 · 改名）'
          }
          className="flex h-5 items-center gap-1 rounded-sm px-1 text-dim hover:bg-raised hover:text-fg"
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
          素材区
        </button>
        {open ? (
          <label className="flex min-w-0 flex-1 items-center gap-0.5 rounded-sm border border-line bg-canvas px-1">
            <Search className="size-3 shrink-0 text-faint" strokeWidth={2} />
            <input
              data-testid="material-search"
              value={query}
              spellCheck={false}
              aria-label="搜索素材"
              title="按名字搜索：支持拼音、拆词、模糊相近"
              placeholder="搜索"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setQuery('');
                  event.currentTarget.blur();
                }
              }}
              className="h-[18px] min-w-0 flex-1 bg-transparent text-badge text-fg outline-none placeholder:text-faint"
            />
            {searchActive ? (
              <button
                type="button"
                data-testid="material-search-clear"
                title="清除搜索"
                aria-label="清除搜索"
                onClick={() => setQuery('')}
                className="flex size-3.5 shrink-0 items-center justify-center rounded-sm text-faint hover:text-fg"
              >
                <X className="size-2.5" strokeWidth={2} />
              </button>
            ) : null}
          </label>
        ) : (
          <span className="flex-1" />
        )}
        {open ? (
          /* 全部 / 命中：素材一多，"这一帧谁在命中"才是要看的信息 */
          <span className="flex shrink-0 items-center overflow-hidden rounded-sm border border-line">
            {(
              [
                ['all', `全部 ${recognizers.length}`],
                ['hit', `命中 ${hits.length}`],
              ] as const
            ).map(([id, text]) => (
              <button
                key={id}
                type="button"
                data-testid={`material-filter-${id}`}
                aria-pressed={filter === id}
                title={id === 'hit' ? '只看这一帧命中的（待确认 + 稳定）' : '显示全部素材'}
                onClick={() => setFilter(id)}
                className={cn('h-[18px] px-1.5', filter === id ? 'bg-active text-fg' : 'hover:text-fg')}
              >
                {text}
              </button>
            ))}
          </span>
        ) : (
          <span data-testid="material-hit-summary" className={hits.length > 0 ? 'text-confirmed' : undefined}>
            命中 {hits.length}
          </span>
        )}
        {/* 文字识别是独立识别器，入口放在它自己的列表旁：不用先框一块再在表单里改「识别方式」 */}
        {open ? (
          <button
            type="button"
            data-testid="material-ocr-new"
            title="新建文字识别（OCR）：在画面栏框住要读字的区域，填上要认的字"
            onClick={() => beginOcr()}
            className="flex h-[18px] shrink-0 items-center gap-0.5 rounded-sm border border-line px-1.5 text-badge text-dim hover:border-brand hover:text-brand"
          >
            <ScanText className="size-3" strokeWidth={2} />
            文字
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.map((item) => {
            const editingThis = editing?.label === item.label;
            const pass = item.score >= item.threshold;
            // 谁在用它：被引用着就删不掉（引擎会拒绝），所以按钮先置灰并写清原因
            const usage = collectRecognizerUsage(graph, item.label);
            const blocked = usage.total > 0;
            const usageText = describeRecognizerUsage(usage);
            const jumpTargets = [
              ...usage.flowSteps.map((step) => ({
                id: step.id,
                label: `模块 · ${step.label}（${step.id}）`,
              })),
              ...usage.nodes.map((node) => ({
                id: node.id,
                label: `界面 · ${nodeRef(node)}`,
              })),
            ];
            const jumpToNextTarget = (): void => {
              if (jumpTargets.length === 0) {
                return;
              }
              const currentIdx = jumpTargets.findIndex((target) => target.id === selectedNodeId);
              const nextTarget =
                currentIdx >= 0 ? jumpTargets[(currentIdx + 1) % jumpTargets.length] : jumpTargets[0];
              if (nextTarget) {
                focusNode(nextTarget.id);
              }
            };
            return (
              <div key={item.label} className="border-b border-line/60 px-2 py-1 hover:bg-raised">
                <div className="flex h-[30px] items-center gap-2">
                  {item.type === 'template' && item.template ? (
                    <TemplateThumb label={item.label} />
                  ) : item.type === 'ocr' && item.template ? (
                    // OCR 也存一块证据截图（spec.template）：给用户看它读的是哪一块，
                    // 右下角小图标标明"文字识别"，别和图像模板混在一起
                    <span
                      className="relative inline-flex shrink-0"
                      title={`OCR 识别器：读「${item.text ?? ''}」`}
                    >
                      <TemplateThumb label={item.label} />
                      <ScanText className="absolute -right-0.5 -bottom-0.5 size-3 rounded-[2px] bg-panel p-[1px] text-brand" />
                    </span>
                  ) : (
                    <span
                      className="flex size-[26px] shrink-0 items-center justify-center rounded-sm border border-line bg-raised"
                      title={
                        item.type === 'color'
                          ? '颜色识别器（纯色区域自动降级）'
                          : item.type === 'ocr'
                            ? `OCR 识别器：读「${item.text ?? ''}」`
                            : '识别器'
                      }
                    >
                      {item.type === 'ocr' ? <ScanText className="size-3.5 text-brand" /> : null}
                    </span>
                  )}
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
                        if (finished.current) {
                          finished.current = false;
                          return;
                        }
                        submitRename(item.label, editing.value);
                      }}
                      className={cn(
                        'h-[20px] w-28 shrink-0 rounded-sm border bg-canvas px-1 text-body text-fg outline-none',
                        editing.error ? 'border-failed' : 'border-brand',
                      )}
                    />
                  ) : (
                    <button
                      type="button"
                      data-testid="recognizer-name"
                      title="双击改名（引用它的节点/边会一起改）"
                      onDoubleClick={() => beginRename(item.label)}
                      className="w-28 shrink-0 truncate text-left text-body hover:text-brand"
                    >
                      {item.label}
                    </button>
                  )}
                  <span className={cn('shrink-0 text-body', pass ? 'text-confirmed' : 'text-dim')}>
                    {item.score.toFixed(2)}
                  </span>
                  <span className="shrink-0 text-badge text-faint">
                    {item.state === 'confirmed' ? '稳定' : item.state === 'pending' ? '待确认' : '未命中'}
                  </span>
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
                  <div className="group relative inline-flex shrink-0">
                    <button
                      type="button"
                      data-testid="recognizer-usage-badge"
                      disabled={jumpTargets.length === 0}
                      title={jumpTargets.length > 0 ? `${usageText}（点击定位到对应模块）` : usageText}
                      aria-label={usageText}
                      onClick={jumpToNextTarget}
                      className={cn(
                        'inline-flex h-5 shrink-0 items-center gap-0.5 rounded-sm border px-1 text-[10px]',
                        blocked
                          ? 'cursor-pointer border-pending/40 bg-pending/10 text-pending hover:border-pending hover:bg-pending/20'
                          : 'cursor-default border-line text-faint',
                      )}
                    >
                      <Link2 className="size-2.5 shrink-0" strokeWidth={2} />
                      <span>{usage.total > 0 ? usage.total : '0'}</span>
                    </button>
                    <div
                      role="tooltip"
                      className=" absolute right-0 bottom-full z-30 hidden pb-1 group-hover:block"
                    >
                      <div className="w-max max-w-[260px] rounded-sm border border-line bg-panel px-2 py-1.5 text-left text-[11px] leading-snug whitespace-normal text-fg shadow-md">
                        {jumpTargets.length > 0 ? (
                          <div className="flex flex-col gap-0.5">
                            <div className="text-[10px] text-faint">正在被引用（点击跳转）：</div>
                            {jumpTargets.map((target) => (
                              <button
                                key={target.id}
                                type="button"
                                data-testid="recognizer-usage-target"
                                onClick={() => focusNode(target.id)}
                                className={cn(
                                  'truncate rounded-sm px-1 py-0.5 text-left hover:bg-raised hover:text-brand',
                                  selectedNodeId === target.id && 'bg-active text-brand',
                                )}
                              >
                                {target.label}
                              </button>
                            ))}
                            {usage.edges.map((edge) => (
                              <div key={edge.id} className="px-1 py-0.5 text-dim">
                                {edge.id}（{edge.reasons.join(' + ')}）
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-faint">{usageText}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid="recognizer-remove"
                    disabled={blocked}
                    aria-label={`删除 ${item.label}`}
                    title={
                      blocked
                        ? `删不掉：${usageText}。先到工作流里把这些引用去掉（节点的进入条件 / 边的判断条件 / 动作目标）`
                        : `删除 ${item.label}（模板文件一起删）`
                    }
                    onClick={() => {
                      void removeRecognizer(deviceId, item.label);
                    }}
                    className={cn(
                      'inline-flex size-5 shrink-0 items-center justify-center rounded-sm',
                      blocked ? 'cursor-not-allowed text-faint opacity-50' : 'text-failed hover:bg-raised',
                    )}
                  >
                    <Trash2 className="size-3" strokeWidth={2} />
                  </button>
                </div>
              </div>
            );
          })}
          {recognizers.length === 0 && (
            <div className="px-2 py-3 text-badge text-faint">
              还没有素材 · 打开「框选」在画面上拖一个矩形录一个
            </div>
          )}
          {recognizers.length > 0 && rows.length === 0 && searchActive && (
            <div className="px-2 py-3 text-badge text-faint">没有与「{query.trim()}」相近的素材</div>
          )}
          {recognizers.length > 0 && rows.length === 0 && !searchActive && (
            <div className="px-2 py-3 text-badge text-faint">
              这一帧没有命中的素材 · 切到「全部」看全部 {recognizers.length} 个
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
