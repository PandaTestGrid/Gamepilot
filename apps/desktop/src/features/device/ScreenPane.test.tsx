/**
 * 画面栏控制手势的**反馈**测试。
 *
 * 守的是一个真实 bug：滑动（按下 → 拖出去 → 抬手）原来会画出**两个点击波纹** ——
 * 起点闪一个、抬手在终点再闪一个，看起来像"我点歪了两下"，
 * 而实际发生的是一次滑动。现在的规则：
 *
 * - 轻触：按下闪波纹，抬手在同一个位置再闪一下（"点进去了"）
 * - 滑动：**不补波纹**；轨迹（起点实心点 → 终点空心圈）只在「录操作」开着时画 ——
 *   那是"这一段会被录成 swipe"的预览，正常控制滑完不留痕迹
 *
 * 另外守住"画面反馈"和"录操作"用同一把尺子：画成滑动，录下来就必须是 swipe。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreenPane, screenCursorClass } from '@/features/device/ScreenPane';
import { useDeviceStore } from '@/stores/device.store';
import { WORKFLOW_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useOcrStore } from '@/stores/ocr.store';
import { useSessionStore, type FrameState } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { RecognizerView } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const DEVICE = 'mock:1';
/** 录制要落盘进当前工作流。 */
const WORKFLOW_PROJECT = {
  root: '/p/甲/斗技',
  graphPath: '/p/甲/斗技/graph.json',
  nodes: 0,
  edges: 0,
  recognizers: 0,
  templates: 0,
};
const DEVICE_NAME = 'Mock 竖屏';
/**
 * 画面 720x1280（竖屏）放进 400x640 的容器：等比缩放后画面是 360x640，
 * 左右各 20px 黑边。**故意留黑边** —— 反馈点必须按画面算，不能按容器百分比。
 */
const CONTAINER = { width: 400, height: 640 };
const IMAGE = { width: 720, height: 1280 };
const IMAGE_LEFT = 20;

function frameAt(index: number): FrameState {
  return {
    imageUrl: 'data:image/jpeg;base64,AAAA',
    index,
    resolution: [IMAGE.width, IMAGE.height],
    node: null,
    pending: null,
    tick: 0,
    fps: 12,
    captureMs: 1,
    detections: [],
    ts: 0,
  };
}

/** 按真实签名打桩（`session.store.touch` / `recordStep` / `renameRecognizer`）：断言里才不用碰 any。 */
type TouchMock = (deviceId: string, phase: string, x: number, y: number) => Promise<boolean>;
type RecordStepMock = (deviceId: string, action: Record<string, unknown>) => Promise<string | null>;
type RenameMock = (
  deviceId: string,
  label: string,
  to: string,
) => Promise<{ refs: { nodes: number; edges: number; scores: number } } | null>;

/** 素材区列表的样例：一个未命中、一个稳定、一个待确认（"命中"= 后两个）。 */
function recognizer(label: string, state: RecognizerView['state'], score: number): RecognizerView {
  return {
    label,
    type: 'template',
    template: `templates/${label}.png`,
    score,
    threshold: 0.82,
    roi: [0.1, 0.1, 0.2, 0.1],
    search: 'region',
    samples: state === 'confirmed' ? 3 : 0,
    state,
  };
}

const MATERIAL_ROWS: readonly RecognizerView[] = [
  recognizer('main_region_1', 'idle', 0),
  recognizer('main_region_2', 'confirmed', 1),
  recognizer('start_btn', 'pending', 0.9),
];

/** 每测试一条独立用例：都从"控制开着、没在录制"开始。 */
function renderScreen(
  options: {
    recordAction?: boolean;
    recognizers?: readonly RecognizerView[];
    /** 设备是否已连接（默认连上；测"未连接"时显式给 false） */
    ready?: boolean;
  } = {},
): {
  viewport: HTMLElement;
  touch: ReturnType<typeof vi.fn<TouchMock>>;
  recordStep: ReturnType<typeof vi.fn<RecordStepMock>>;
  rename: ReturnType<typeof vi.fn<RenameMock>>;
} {
  const touch = vi.fn<TouchMock>(() => Promise.resolve(true));
  const recordStep = vi.fn<RecordStepMock>(() => Promise.resolve('e_1'));
  const rename = vi.fn<RenameMock>(() => Promise.resolve({ refs: { nodes: 0, edges: 0, scores: 0 } }));
  useSessionStore.setState({
    ready: { [DEVICE]: options.ready ?? true },
    frames: { [DEVICE]: frameAt(1) },
    touch,
    recordStep,
    renameRecognizer: rename,
    currentWorkflow: WORKFLOW_PROJECT,
  });
  useGraphStore.setState({
    graphs: {
      [DEVICE]: {
        deviceId: DEVICE,
        nodes: [],
        edges: [],
        recognizers: options.recognizers ?? [],
        variables: [],
        activeNodeId: null,
        pendingNodeId: null,
      },
    },
  });
  useDeviceStore.setState({
    activeId: DEVICE,
    gridView: false,
    devices: [
      {
        id: DEVICE,
        name: DEVICE_NAME,
        uri: 'mock:1',
        kind: 'android',
        status: 'connected',
        resolution: [IMAGE.width, IMAGE.height],
        fps: 12,
      },
    ],
  });
  useUiStore.setState({
    controlMode: true,
    recordMode: 'off',
    recordActionMode: options.recordAction ?? false,
    draft: null,
  });
  useOcrStore.setState({
    scanningScreen: false,
    scanVisual: null,
    pickBoxes: {},
    lastError: null,
    status: { ...useOcrStore.getState().status, state: 'not_downloaded', progress: 0, stage: '' },
  });

  render(<ScreenPane />);

  // 把容器尺寸和画面尺寸喂给组件：jsdom 没有布局，`object-contain` 的换算得手工指定
  const viewport = screen.getByTestId('screen-viewport');
  viewport.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      ...CONTAINER,
      right: CONTAINER.width,
      bottom: CONTAINER.height,
      x: 0,
      y: 0,
    }) as DOMRect;
  const img = screen.getByAltText(`${DEVICE_NAME} 实时画面`);
  Object.defineProperty(img, 'naturalWidth', { value: IMAGE.width, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: IMAGE.height, configurable: true });
  // 帧号变化 → 触发一次量测（真实环境里由 ResizeObserver / 新帧驱动；jsdom 里是空实现）
  act(() => {
    useSessionStore.setState({ frames: { [DEVICE]: frameAt(2) } });
  });

  return { viewport, touch, recordStep, rename };
}

/** 一次滑动：按下 → 拖两步（隔开 20ms 绕开 16ms 限频）→ 抬手。 */
async function swipe(viewport: HTMLElement, from: Point, to: Point): Promise<void> {
  fireEvent.pointerDown(viewport, { clientX: from.x, clientY: from.y, pointerId: 1, button: 0 });
  fireEvent.pointerMove(viewport, {
    clientX: (from.x + to.x) / 2,
    clientY: (from.y + to.y) / 2,
    pointerId: 1,
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  fireEvent.pointerMove(viewport, { clientX: to.x, clientY: to.y, pointerId: 1 });
  fireEvent.pointerUp(viewport, { clientX: to.x, clientY: to.y, pointerId: 1 });
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** 画面归一化点 → 容器像素（和组件里的换算同一套：画面区域 360x640，左边 20px 黑边）。 */
function pixel(x: number, y: number): Point {
  return { x: IMAGE_LEFT + x * (CONTAINER.width - IMAGE_LEFT * 2), y: y * CONTAINER.height };
}

describe('画面栏控制手势的反馈', () => {
  beforeEach(() => {
    useSessionStore.setState({ ready: {}, frames: {}, touch: vi.fn(), recordStep: vi.fn() });
    useUiStore.setState({ materialFilter: 'all' });
  });

  it('录操作·轻触：按下就有点击标记（落在画面坐标上，不是容器百分比）', () => {
    const { viewport } = renderScreen({ recordAction: true });

    fireEvent.pointerDown(viewport, { clientX: 110, clientY: 320, pointerId: 1, button: 0 });

    // (110, 320) → 归一化 (0.25, 0.5) → 画回画面像素还是 (110, 320)：黑边没参与换算
    expect(screen.getByTestId('touch-tap')).toHaveStyle({ left: '110px', top: '320px' });
    expect(screen.queryByTestId('touch-swipe')).toBeNull();
  });

  it('录操作·轻触抬手：还是那一个标记（同一个位置），没有轨迹', () => {
    const { viewport, touch } = renderScreen({ recordAction: true });

    fireEvent.pointerDown(viewport, { clientX: 110, clientY: 320, pointerId: 1, button: 0 });
    fireEvent.pointerUp(viewport, { clientX: 110, clientY: 320, pointerId: 1 });

    expect(screen.getAllByTestId('touch-tap')).toHaveLength(1);
    expect(screen.getByTestId('touch-tap')).toHaveStyle({ left: '110px', top: '320px' });
    expect(screen.queryByTestId('touch-swipe')).toBeNull();
    expect(touch.mock.calls.map((call) => call[1])).toEqual(['down', 'up']);
  });

  it('正常控制：**一个辅助都不画**（轻触/滑动都没有），但手势照常发给设备', async () => {
    const { viewport, touch } = renderScreen();

    // 轻触：按下、抬手都不画
    fireEvent.pointerDown(viewport, { clientX: 110, clientY: 320, pointerId: 1, button: 0 });
    expect(screen.queryByTestId('touch-tap')).toBeNull();
    fireEvent.pointerUp(viewport, { clientX: 110, clientY: 320, pointerId: 1 });
    expect(screen.queryByTestId('touch-tap')).toBeNull();
    expect(screen.queryByTestId('touch-swipe')).toBeNull();

    // 滑动：同样什么都不画
    await swipe(viewport, pixel(0.25, 0.16), pixel(0.75, 0.78));
    expect(screen.queryByTestId('touch-tap')).toBeNull();
    expect(screen.queryByTestId('touch-swipe')).toBeNull();

    // 控制本身不受影响（画面上不画 ≠ 不控制）
    const phases = touch.mock.calls.map((call) => call[1]);
    expect(phases[0]).toBe('down');
    expect(phases).toContain('move');
    expect(phases.at(-1)).toBe('up');
    expect(phases.filter((phase) => phase === 'up')).toHaveLength(2);
  });

  it('录制滑动时拖动中画的是**真实轨迹**（折线），不是起止直线', async () => {
    const { viewport } = renderScreen();
    useUiStore.setState({ pendingFlowSwipeStepId: 'sw1', pendingFlowSwipeMode: 'track' });

    fireEvent.pointerDown(viewport, { clientX: 110, clientY: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(viewport, { clientX: 180, clientY: 500, pointerId: 1 });
    // move 有节流（约 60fps）：两次 move 之间要隔一点时间，否则第二段直接被吞掉
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    fireEvent.pointerMove(viewport, { clientX: 240, clientY: 440, pointerId: 1 });

    // 引导条同时报数：拖的过程中就能看出"已经成线了"（否则用户不知道该继续拖还是能松手）
    expect(screen.getByTestId('swipe-record-progress')).toHaveTextContent('正在记轨迹：3 点');

    const drawn = screen.getByTestId('touch-swipe-path');
    // 折线三个点：中间那个拐点只可能来自真实采样，直线画不出来
    expect((drawn.getAttribute('points') ?? '').split(' ')).toHaveLength(3);
    // 起止直线只是给测试读坐标的兜底，这时候不该再露出来
    expect(screen.getByTestId('touch-swipe-line')).toHaveAttribute('visibility', 'hidden');
  });

  it('直线拖完照样画直线（折线上多采的几个点不会把它画成折线）', async () => {
    const { viewport } = renderScreen({ recordAction: true });
    await swipe(viewport, pixel(0.25, 0.16), pixel(0.75, 0.78));
    expect(screen.queryByTestId('touch-swipe-path')).toBeNull();
    expect(screen.getByTestId('touch-swipe-line')).not.toHaveAttribute('visibility');
  });

  it('录操作·滑动：轨迹（起点→落点）带方向箭头，抬手后停在终点', async () => {
    const { viewport } = renderScreen({ recordAction: true });
    const start = pixel(0.25, 0.16);
    const end = pixel(0.75, 0.78);

    await swipe(viewport, start, end);

    const trail = screen.getByTestId('touch-swipe');
    const line = trail.querySelector('[data-testid="touch-swipe-line"]');
    expect(line).toHaveAttribute('x1', String(start.x));
    expect(line).toHaveAttribute('y1', String(start.y));
    expect(line).toHaveAttribute('x2', String(end.x));
    expect(line).toHaveAttribute('y2', String(end.y));
    // 方向箭头：终点处按滑动方向旋转（向左下 → atan2(500-100, 290-110) ≈ 65.8°）
    const arrow = trail.querySelector('path');
    expect(arrow?.getAttribute('transform')).toContain(
      `rotate(${(Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI})`,
    );
    // 滑动过程中点击标记已被轨迹取代：不是"起点一个点 + 终点一个点"
    expect(screen.queryByTestId('touch-tap')).toBeNull();
  });

  it('录操作·滑动抬手：**不会** 在终点再补一个点击标记（原 bug）', async () => {
    const { viewport, touch } = renderScreen({ recordAction: true });
    const start = pixel(0.25, 0.16);
    const end = pixel(0.75, 0.78);

    await swipe(viewport, start, end);

    expect(screen.queryByTestId('touch-tap')).toBeNull();
    const line = screen.getByTestId('touch-swipe-line');
    expect(line).toHaveAttribute('x2', String(end.x));
    expect(line).toHaveAttribute('y2', String(end.y));

    const phases = touch.mock.calls.map((call) => call[1]);
    expect(phases[0]).toBe('down');
    expect(phases).toContain('move');
    expect(phases.at(-1)).toBe('up');
  });

  it('录操作·手抖 1~2px 不算滑动：还是一枚点击标记，不出轨迹', async () => {
    const { viewport } = renderScreen({ recordAction: true });
    const start = pixel(0.5, 0.5);

    fireEvent.pointerDown(viewport, { clientX: start.x, clientY: start.y, pointerId: 1, button: 0 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    fireEvent.pointerMove(viewport, { clientX: start.x + 1, clientY: start.y + 1, pointerId: 1 });
    fireEvent.pointerUp(viewport, { clientX: start.x + 1, clientY: start.y + 1, pointerId: 1 });

    expect(screen.getAllByTestId('touch-tap')).toHaveLength(1);
    expect(screen.queryByTestId('touch-swipe')).toBeNull();
  });

  it('录操作：画成滑动就录成 swipe，画成轻触就录成 click（同一把尺子）', async () => {
    const { viewport, recordStep } = renderScreen({ recordAction: true });

    await swipe(viewport, pixel(0.5, 0.8), pixel(0.5, 0.2));

    const swipeCall = recordStep.mock.calls.at(-1);
    expect(swipeCall?.[0]).toBe(DEVICE);
    expect(swipeCall?.[1]).toMatchObject({ type: 'swipe', x: 0.5, y: 0.8, to_x: 0.5, to_y: 0.2 });
    expect(typeof swipeCall?.[1].duration_ms).toBe('number');

    fireEvent.pointerDown(viewport, { clientX: 110, clientY: 320, pointerId: 1, button: 0 });
    fireEvent.pointerUp(viewport, { clientX: 110, clientY: 320, pointerId: 1 });

    await waitFor(() =>
      expect(recordStep).toHaveBeenLastCalledWith(DEVICE, { type: 'click', x: 0.25, y: 0.5 }),
    );
  });
});

describe('素材区接到画面上（筛选取数/改名/删除的详细行为在被测组件自己的测试里）', () => {
  beforeEach(() => {
    useSessionStore.setState({ ready: {}, frames: {}, touch: vi.fn(), recordStep: vi.fn() });
    useUiStore.setState({ materialFilter: 'all', materialOpen: true });
  });

  it('素材区显示的是**当前设备**的图，且标题就是收起/展开的开关', () => {
    renderScreen({ recognizers: MATERIAL_ROWS });

    expect(screen.getAllByTestId('recognizer-name').map((node) => node.textContent)).toEqual([
      'main_region_1',
      'main_region_2',
      'start_btn',
    ]);
    expect(screen.getByTestId('material-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  it('没有识别器时给引导（不是一片空白）', () => {
    renderScreen();

    expect(screen.getByText(/还没有素材/)).toBeInTheDocument();
  });
});

describe('画面指针样式：控制 / 框选 / 点选互不重复', () => {
  it('三种模式用三种光标', () => {
    expect(screenCursorClass('off', true)).toBe('cursor-pointer');
    expect(screenCursorClass('marquee', true)).toBe('cursor-crosshair');
    expect(screenCursorClass('pick', true)).toBe('cursor-pick');
    expect(screenCursorClass('off', false)).toBe('');
  });

  it('控制开着时画面是手型，不是十字', () => {
    renderScreen();
    expect(screen.getByTestId('screen-viewport').className).toContain('cursor-pointer');
    expect(screen.getByTestId('screen-viewport').className).not.toContain('cursor-crosshair');
  });

  it('框选是十字、点选是落点准星', () => {
    renderScreen();
    act(() => {
      useUiStore.setState({ recordMode: 'marquee' });
    });
    expect(screen.getByTestId('screen-viewport').className).toContain('cursor-crosshair');

    act(() => {
      useUiStore.setState({ recordMode: 'pick' });
    });
    expect(screen.getByTestId('screen-viewport').className).toContain('cursor-pick');
    expect(screen.getByTestId('screen-viewport').className).not.toContain('cursor-crosshair');
  });
});

describe('草稿选区：点别处直接重开', () => {
  beforeEach(() => {
    useSessionStore.setState({ ready: {}, frames: {}, touch: vi.fn(), recordStep: vi.fn() });
    useUiStore.setState({ recordMode: 'pick', draft: null, pickSize: 120 });
  });

  it('点画面外的黑边不会起选区（不会贴边生成蓝框）', () => {
    const { viewport } = renderScreen();
    act(() => {
      useUiStore.setState({ recordMode: 'pick' });
    });

    fireEvent.mouseDown(viewport, { clientX: 5, clientY: 320 });
    fireEvent.mouseUp(viewport, { clientX: 5, clientY: 320 });

    expect(useUiStore.getState().draft).toBeNull();
  });

  it('草稿打开时点画面另一处：按新落点重开，不被旧草稿挡住', () => {
    const { viewport } = renderScreen();
    act(() => {
      useUiStore.setState({ recordMode: 'pick' });
      useUiStore.getState().beginDraft({
        rect: [0.1, 0.1, 120 / IMAGE.width, 120 / IMAGE.height],
        resolution: [IMAGE.width, IMAGE.height],
        mode: 'pick',
        pickCenter: [0.1 + 60 / IMAGE.width, 0.1 + 60 / IMAGE.height],
        score: 0.9,
      });
    });

    const spot = pixel(0.75, 0.75);
    fireEvent.mouseDown(viewport, { clientX: spot.x, clientY: spot.y });
    fireEvent.mouseUp(viewport, { clientX: spot.x, clientY: spot.y });

    const rect = useUiStore.getState().draft?.rect;
    expect(rect?.[0]).toBeCloseTo(0.75 - 60 / IMAGE.width, 6);
    expect(rect?.[1]).toBeCloseTo(0.75 - 60 / IMAGE.height, 6);
  });
});

describe('画面栏面板头的控制与电源开关', () => {
  beforeEach(() => {
    useSessionStore.setState({ ready: { [DEVICE]: true }, frames: {}, touch: vi.fn(), recordStep: vi.fn() });
    useUiStore.setState({ controlMode: true, recordActionMode: false, materialOpen: true });
  });

  it('「控制」在面板头（不在下面的设备控制条里），点一下切 ui.store.controlMode', () => {
    renderScreen();

    const button = screen.getByText('控制').closest('button');
    expect(button).toBeInTheDocument();
    // 面板头 = 有「画面」标题那一行；设备控制条里不该有它
    expect(screen.getByTestId('device-controls')).not.toContainElement(button);

    fireEvent.click(button as HTMLButtonElement);
    expect(useUiStore.getState().controlMode).toBe(false);
  });

  it('画面栏面板头不再放「录操作 / 框选 / 点选」，保持单行不折行', () => {
    renderScreen();

    expect(screen.queryByText('录操作')).toBeNull();
    expect(screen.queryByText('框选')).toBeNull();
    expect(screen.queryByText('点选')).toBeNull();
  });

  it('电源键在面板头（不占投屏下面那条）：点了发 power', () => {
    const pressKey = vi.fn(() => Promise.resolve());
    useSessionStore.setState({ pressKey });
    renderScreen();

    const power = screen.getByText('电源').closest('button');
    expect(power).toBeInTheDocument();
    expect(screen.getByTestId('device-controls')).not.toContainElement(power);

    fireEvent.click(power as HTMLButtonElement);
    expect(pressKey).toHaveBeenCalledWith(DEVICE, 'power');
  });

  it('macOS 本机窗口（kind=windows）：面板头上没有电源键（发了也只会报不支持）', () => {
    renderScreen();
    // 换成一台 macOS 本机窗口（引擎把它报成 windows）：kind 变了，面板头要跟着去掉电源键
    act(() => {
      useDeviceStore.setState({
        devices: [
          {
            id: DEVICE,
            name: 'Safari',
            uri: 'Mac:///?window=89',
            kind: 'windows',
            status: 'connected',
            resolution: [1200, 800],
            fps: 9,
          },
        ],
      });
    });

    expect(screen.queryByText('电源')).toBeNull();
  });
});

describe('画面左下角浮层：帧信息 + 运行态合成一条（曾经两块叠在一起）', () => {
  it('只渲染一条浮层，两边信息都在', () => {
    renderScreen();
    // renderScreen 会写自己的帧，所以这里在它之后再放"带 node/tick"的那一帧
    act(() => {
      useSessionStore.setState({
        frames: { [DEVICE]: { ...frameAt(9), node: 'main', tick: 29082, fps: 7.7, pending: 'battle' } },
      });
    });

    // 只有一条浮层（以前是两块都锚在 bottom-1 left-1，叠在一起字糊成一团）
    const overlays = screen.getAllByTestId('frame-overlay');
    expect(overlays).toHaveLength(1);
    const overlay = overlays[0] as HTMLElement;
    expect(overlay).toHaveTextContent('帧 #9');
    expect(overlay).toHaveTextContent('node=main');
    expect(overlay).toHaveTextContent('pending→battle');
    // 同一段文字里出现两次 fps 就是又叠了一层
    expect(overlay.textContent?.match(/fps/g)).toHaveLength(1);
  });
});

describe('帧还没有画面时不给 <img> 空 src', () => {
  it('imageUrl 为空串时不传 src：React 会为 src="" 报警告（浏览器会把当前页面当成图片再拉一遍）', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      renderScreen();
      act(() => {
        useSessionStore.setState({ frames: { [DEVICE]: { ...frameAt(2), imageUrl: '' } } });
      });

      const warned = errors.mock.calls.some((call) => String(call[0]).includes('empty string'));
      expect(warned, 'React 报了 src="" 的告警，说明空串被直接传给了 <img src>').toBe(false);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('离线 OCR 辅助框选命名与点选文字框', () => {
  it('面板头「控制」按钮左侧的 OCR 是扫描按钮，点一下就开始扫描，没有开关和额外扫描按钮', () => {
    const scan = vi.fn(() => Promise.resolve([]));
    renderScreen();
    act(() => {
      useOcrStore.setState({
        scanScreenForPick: scan,
        status: { ...useOcrStore.getState().status, state: 'ready', downloaded: true, loaded: true },
      });
    });

    const ocrBtn = screen.getByText('OCR').closest('button')!;
    const controlBtn = screen.getByText('控制').closest('button')!;
    expect(ocrBtn.compareDocumentPosition(controlBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('扫描')).toBeNull();

    fireEvent.click(ocrBtn);
    expect(scan).toHaveBeenCalledWith(DEVICE);
  });

  it('加载模型时进度写在面板头 OCR 按钮上，不在画面上盖一层 toast', () => {
    renderScreen();
    act(() => {
      useOcrStore.setState({
        status: {
          ...useOcrStore.getState().status,
          state: 'downloading',
          progress: 2,
          stage: '正在加载 PP-OCRv4 模型…',
        },
      });
    });

    expect(screen.getByText('2%').closest('button')).toBeInTheDocument();
    expect(screen.queryByTestId('pick-ocr-bar')).toBeNull();
    expect(screen.queryByText('正在加载 PP-OCRv4 模型…')).toBeNull();
  });

  it('框选弹窗点击 OCR 按钮：自动识别选区文字并填入名称输入框', async () => {
    renderScreen();
    act(() => {
      useOcrStore.setState({
        status: {
          ...useOcrStore.getState().status,
          state: 'ready',
          downloaded: true,
          loaded: true,
          progress: 100,
        },
        recognizeRegion: vi.fn(() => Promise.resolve('开始挑战')),
      });
      useUiStore.getState().beginDraft({
        rect: [0.2, 0.3, 0.3, 0.1],
        score: 0.95,
        mode: 'marquee',
      });
    });

    const ocrBtn = screen.getByTestId('draft-ocr-btn');
    fireEvent.click(ocrBtn);

    await waitFor(() => {
      expect(useUiStore.getState().draft?.label).toBe('开始挑战');
    });
  });

  it('扫描后展示文字框与扫描特效，点击文字框直接取其区域与文字作为名称', () => {
    renderScreen();
    act(() => {
      useUiStore.setState({ recordMode: 'pick', draft: null });
      useOcrStore.setState({
        status: {
          ...useOcrStore.getState().status,
          state: 'ready',
          downloaded: true,
          loaded: true,
          progress: 100,
        },
        scanVisual: { id: 1, deviceId: DEVICE, rect: null },
        pickBoxes: {
          [DEVICE]: [{ text: '进入背包', score: 0.98, rect: [0.15, 0.25, 0.22, 0.08] }],
        },
      });
    });

    // 验证扫描特效存在
    expect(screen.getByTestId('ocr-scan-effect')).toBeInTheDocument();
    expect(screen.getByTestId('ocr-scan-beam')).toBeInTheDocument();

    const pickBox = screen.getByTestId('ocr-pick-box');
    expect(pickBox).toHaveTextContent('进入背包');

    fireEvent.click(pickBox);

    const draft = useUiStore.getState().draft;
    expect(draft).not.toBeNull();
    expect(draft?.label).toBe('进入背包');
    expect(draft?.rect).toEqual([0.15, 0.25, 0.22, 0.08]);
    // 点的是"认字"的来源：草稿直接落成 OCR 识别器，弹出 OCR 表单而不是图像模板表单
    expect(draft?.kind).toBe('ocr');
    expect(draft?.text).toBe('进入背包');
    expect(draft?.threshold).toBeCloseTo(0.6);
    expect(screen.getByTestId('ocr-recognizer-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('record-overlay')).toBeNull();
  });
});

/**
 * 「录制滑动」的引导条。
 *
 * 守的是一个真实的困惑：点了「录制滑动」之后画面上**一个字都没有**，
 * 用户不知道要在哪拖、也不知道为什么录完还是直线。引导条要写清"在哪拖"，
 * 并且要能取消（否则引导条一直挂着）。
 */
describe('录制滑动的引导条', () => {
  beforeEach(() => {
    useSessionStore.setState({ ready: {}, frames: {}, touch: vi.fn(), recordStep: vi.fn() });
    useUiStore.setState({
      materialFilter: 'all',
      pendingFlowSwipeStepId: null,
      pendingFlowSwipeMode: 'track',
    });
  });

  it('未进入录制滑动时不显示', () => {
    renderScreen();
    expect(screen.queryByTestId('swipe-record-guide')).toBeNull();
  });

  it('连续录制：说明"拖轨迹 + Shift 直线 + 终点停住"', () => {
    useUiStore.setState({ pendingFlowSwipeStepId: 'sw1', pendingFlowSwipeMode: 'track' });
    renderScreen();

    const guide = screen.getByTestId('swipe-record-guide');
    expect(guide).toHaveTextContent('录制连续滑动');
    expect(guide).toHaveTextContent('拖出轨迹');
    expect(guide).toHaveTextContent('Shift');
    expect(guide).toHaveTextContent('直线');
    // 「按住」是什么必须在画面上讲清楚，别只给个输入框
    expect(guide).toHaveTextContent('按住');
  });

  it('单次录制：说明"只记起止点"（不再提轨迹）', () => {
    useUiStore.setState({ pendingFlowSwipeStepId: 'sw1', pendingFlowSwipeMode: 'single' });
    renderScreen();

    const guide = screen.getByTestId('swipe-record-guide');
    expect(guide).toHaveTextContent('录制单次滑动');
    expect(guide).toHaveTextContent('只记起止点');
  });

  it('点取消：引导条收掉，且不会顺手在画面上按一下', () => {
    useUiStore.setState({ pendingFlowSwipeStepId: 'sw1' });
    const { touch } = renderScreen();

    fireEvent.pointerDown(screen.getByTestId('swipe-record-cancel'), { pointerId: 1, button: 0 });
    fireEvent.click(screen.getByTestId('swipe-record-cancel'));

    expect(useUiStore.getState().pendingFlowSwipeStepId).toBeNull();
    // 按到按钮上不算在画面上按下（否则会往设备发一次 down）
    expect(touch).not.toHaveBeenCalled();
  });
});

/**
 * 「点对点滑动」和「连续滑动」用步骤面板顶部的「方式」选择框分开，各只显示自己的录制按钮：
 * - 单次：拖完只写起止点，不写轨迹（回放走直线）；
 * - 连续：拖一条弯线，轨迹一起写进去（回放走同一条弯线）。
 */
describe('录制滑动的两种方式', () => {
  const updateFlowStep = vi.fn(() => Promise.resolve());

  function startRecording(mode: 'single' | 'track'): HTMLElement {
    const { viewport } = renderScreen();
    useUiStore.setState({ pendingFlowSwipeStepId: 'sw1', pendingFlowSwipeMode: mode });
    useGraphStore.setState({
      graphs: {
        [WORKFLOW_SCOPE]: {
          deviceId: WORKFLOW_SCOPE,
          nodes: [],
          edges: [],
          recognizers: [],
          variables: [],
          activeNodeId: null,
          pendingNodeId: null,
          flow: { steps: [{ id: 'sw1', type: 'swipe', params: {} }] },
        },
      },
      updateFlowStep,
      selectNode: vi.fn(),
    });
    return viewport;
  }

  /** 沿一条弯线拖：起点 → 拐一下 → 终点。 */
  function dragCurve(viewport: HTMLElement): void {
    fireEvent.pointerDown(viewport, { clientX: 110, clientY: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(viewport, { clientX: 180, clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(viewport, { clientX: 240, clientY: 440, pointerId: 1 });
    fireEvent.pointerUp(viewport, { clientX: 240, clientY: 400, pointerId: 1 });
  }

  beforeEach(() => {
    updateFlowStep.mockClear();
  });

  it('连续录制：把弯线的轨迹一起写进步骤', async () => {
    dragCurve(startRecording('track'));

    await waitFor(() => expect(updateFlowStep).toHaveBeenCalled());
    const params = (updateFlowStep.mock.calls.at(-1) as unknown[])[1] as {
      params: Record<string, unknown>;
    };
    expect(Array.isArray(params.params.path)).toBe(true);
    expect((params.params.path as unknown[]).length).toBeGreaterThanOrEqual(3);
    expect(useUiStore.getState().pendingFlowSwipeStepId).toBeNull();
  });

  it('连续录制：画一个圆（回到起点）也能写进轨迹（回归：原来被判成轻点，什么都不写）', async () => {
    const viewport = startRecording('track');

    // 绕一圈回到起点附近：合位移≈0，只有"走过的路程"能说明这是滑动
    const center = { x: 200, y: 380 };
    fireEvent.pointerDown(viewport, { clientX: center.x + 60, clientY: center.y, pointerId: 1, button: 0 });
    for (let step = 1; step <= 12; step += 1) {
      const angle = (step / 12) * Math.PI * 2;
      fireEvent.pointerMove(viewport, {
        clientX: center.x + Math.cos(angle) * 60,
        clientY: center.y + Math.sin(angle) * 60,
        pointerId: 1,
      });
      // 节流（约 60fps）：每次 move 之间隔开一点，否则只有第一段被采样
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    fireEvent.pointerUp(viewport, {
      clientX: center.x + Math.cos((12 / 12) * Math.PI * 2) * 60,
      clientY: center.y,
      pointerId: 1,
    });

    await waitFor(() => expect(updateFlowStep).toHaveBeenCalled());
    const params = (updateFlowStep.mock.calls.at(-1) as unknown[])[1] as {
      params: Record<string, unknown>;
    };
    const path = params.params.path as [number, number][] | undefined;
    expect(path).toBeDefined();
    expect(path?.length ?? 0).toBeGreaterThanOrEqual(6);
    // 圆：首尾几乎重合，中间的弧要留得下来
    expect(Math.abs((path?.[0]?.[0] ?? 0) - (path?.[path.length - 1]?.[0] ?? 1))).toBeLessThan(0.1);
  });

  it('连续录制 + Shift：屏幕上画直线，写进步骤的 path 也是共线三点', async () => {
    const viewport = startRecording('track');
    fireEvent.pointerDown(viewport, { clientX: 110, clientY: 500, pointerId: 1, button: 0, shiftKey: true });
    fireEvent.pointerMove(viewport, { clientX: 180, clientY: 500, pointerId: 1, shiftKey: true });
    // move 有节流（约 60fps）：两次 move 之间要隔一点时间，否则第二段直接被吞掉
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    fireEvent.pointerMove(viewport, { clientX: 240, clientY: 420, pointerId: 1, shiftKey: true });

    // 按住 Shift 时屏幕上的线 = 会写进步骤的线：起止直线，不画手指的弯线
    expect(screen.queryByTestId('touch-swipe-path')).toBeNull();
    expect(screen.getByTestId('touch-swipe-line')).not.toHaveAttribute('visibility');

    fireEvent.pointerUp(viewport, { clientX: 260, clientY: 400, pointerId: 1, shiftKey: true });

    await waitFor(() => expect(updateFlowStep).toHaveBeenCalled());
    const params = (updateFlowStep.mock.calls.at(-1) as unknown[])[1] as {
      params: Record<string, unknown>;
    };
    const path = params.params.path as [number, number][] | undefined;
    // 共线三点：引擎要求至少 3 点才算连续轨迹，中间点必须落在起止连线上
    expect(path).toHaveLength(3);
    const [start, middle, end] = path as [number, number][];
    expect(start![0]).toBeCloseTo(Number(params.params.x), 3);
    expect(start![1]).toBeCloseTo(Number(params.params.y), 3);
    expect(end![0]).toBeCloseTo(Number(params.params.to_x), 3);
    expect(end![1]).toBeCloseTo(Number(params.params.to_y), 3);
    expect(middle![0]).toBeCloseTo((start![0] + end![0]) / 2, 3);
    expect(middle![1]).toBeCloseTo((start![1] + end![1]) / 2, 3);
  });

  it('单次录制：屏幕上画的是起止直线，手指拖出的弯线不会被画成轨迹', async () => {
    const viewport = startRecording('single');
    fireEvent.pointerDown(viewport, { clientX: 110, clientY: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(viewport, { clientX: 180, clientY: 500, pointerId: 1 });
    // move 有节流（约 60fps）：两次 move 之间要隔一点时间，否则第二段直接被吞掉
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    fireEvent.pointerMove(viewport, { clientX: 240, clientY: 440, pointerId: 1 });

    // 屏幕上的线 = 会写进步骤的线：点对点只写起止点，所以这里必须是直线
    expect(screen.queryByTestId('touch-swipe-path')).toBeNull();
    expect(screen.getByTestId('touch-swipe-line')).not.toHaveAttribute('visibility');

    fireEvent.pointerUp(viewport, { clientX: 240, clientY: 400, pointerId: 1 });
    expect(screen.queryByTestId('touch-swipe-path')).toBeNull();
  });

  it('单次录制：只写起止点，不写轨迹', async () => {
    dragCurve(startRecording('single'));

    await waitFor(() => expect(updateFlowStep).toHaveBeenCalled());
    const params = (updateFlowStep.mock.calls.at(-1) as unknown[])[1] as {
      params: Record<string, unknown>;
    };
    expect(params.params.path).toBeUndefined();
    expect(params.params.hold_ms).toBeUndefined();
    expect(params.params.x).toBeCloseTo(0.2, 1);
  });
});
