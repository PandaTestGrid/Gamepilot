/**
 * 多开网格的交互测试：用户报的「设备多开时候点击功能失效」。
 *
 * 现场：`device.store.gridView=true` 时每块瓦片只是一个 `<button onClick=setActive>`，
 * 画面区没有任何指针处理 —— 控制模式（默认开）下点画面不发 `device.touch`；
 * 框选/点选在网格里也点了没反应（它们只接在单画面那条分支上）。
 *
 * 这里守住的契约（testid 不许改名）：
 * - 瓦片 `grid-tile-<deviceId>` / 头栏 `grid-head-<deviceId>` / 脚栏 `grid-foot-<deviceId>` /
 *   交互画面 `grid-screen-<deviceId>`，画面里的 img alt = `<设备名> 画面`；
 * - 头栏 / 脚栏点击 = 只切活动设备，不发触控；
 * - `recordMode !== 'off'`：任意瓦片画面按下 → 切到该瓦片设备并起选区，抬手 → `beginDraft`；
 * - 没在录制且 `controlMode`：**当前设备**瓦片的画面按下/拖动/抬手 → `touch(down/move/up)`，
 *   坐标按**这块瓦片自己的** imageBox（object-contain 的黑边不参与，点黑边不响应）；
 *   点非当前设备的瓦片只切设备、这一次手势不发触控（切完再点才发到它）；
 * - `controlMode=false`：点画面只切设备，不发触控。
 *
 * jsdom 没有布局：每块瓦片的画面区尺寸、img 的原始尺寸都得手工打桩
 * （和 ScreenPane.test.tsx 同一套手法），再推一帧触发量测。
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreenPane } from '@/features/device/ScreenPane';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore, type FrameState } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { RecordDraft } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const DEVICE_A = 'mock:1';
const DEVICE_B = 'mock:2';
const NAME_A = 'Mock 竖屏';
const NAME_B = 'Mock 横屏';

/**
 * 两块瓦片都放 400x640 的容器里，但画面比例不同 —— 换算一旦串台或漏掉黑边，数字立刻对不上：
 * - A（竖屏 720x1280）→ 画面 360x640，左右各 20px 黑边
 * - B（横屏 1280x720）→ 画面 400x225，上下各 207.5px 黑边
 */
const TILE: Size = { width: 400, height: 640 };
const IMAGE_A: Size = { width: 720, height: 1280 };
const BOX_A: Box = { left: 20, top: 0, width: 360, height: 640 };
const IMAGE_B: Size = { width: 1280, height: 720 };
const BOX_B: Box = { left: 0, top: 207.5, width: 400, height: 225 };

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface TileSpec {
  readonly id: string;
  readonly name: string;
  readonly image: Size;
}

const TILES: readonly TileSpec[] = [
  { id: DEVICE_A, name: NAME_A, image: IMAGE_A },
  { id: DEVICE_B, name: NAME_B, image: IMAGE_B },
];

function frameAt(index: number, resolution: Size): FrameState {
  return {
    imageUrl: 'data:image/jpeg;base64,AAAA',
    index,
    resolution: [resolution.width, resolution.height],
    node: null,
    pending: null,
    tick: 0,
    fps: 12,
    captureMs: 1,
    detections: [],
    ts: 0,
  };
}

/** 按真实签名打桩（`session.store.touch`）：断言里才不用碰 any。 */
type TouchMock = (deviceId: string, phase: 'down' | 'move' | 'up', x: number, y: number) => void;

function renderGrid(
  options: { controlMode?: boolean; recordMode?: 'off' | 'marquee' | 'pick'; gridView?: boolean } = {},
): {
  touch: ReturnType<typeof vi.fn<TouchMock>>;
} {
  const touch = vi.fn<TouchMock>(() => undefined);
  useSessionStore.setState({
    ready: { [DEVICE_A]: true, [DEVICE_B]: true },
    frames: {
      [DEVICE_A]: frameAt(1, IMAGE_A),
      [DEVICE_B]: frameAt(1, IMAGE_B),
    },
    touch,
    recordStep: vi.fn(() => Promise.resolve('e_1')),
    error: null,
  });
  useGraphStore.setState({ graphs: {} });
  useDeviceStore.setState({
    activeId: DEVICE_A,
    gridView: options.gridView ?? true,
    devices: TILES.map((tile) => ({
      id: tile.id,
      name: tile.name,
      uri: tile.id,
      kind: 'mock' as const,
      status: 'connected' as const,
      resolution: [tile.image.width, tile.image.height],
      fps: 12,
    })),
  });
  useUiStore.setState({
    controlMode: options.controlMode ?? true,
    recordMode: options.recordMode ?? 'off',
    recordActionMode: false,
    draft: null,
    readoutOpen: true,
    readoutFilter: 'all',
  });

  render(<ScreenPane />);

  // jsdom 没有布局：每块瓦片的画面区尺寸 + img 的原始尺寸都要手工打桩
  stubTiles();
  // 帧号变化 → 触发一次量测（真实环境里由 ResizeObserver / 新帧驱动；jsdom 里是空实现）
  bumpFrames();

  return { touch };
}

let frameSeq = 1;

/** 帧号推进一次：让每块瓦片重新量一遍画面区（jsdom 里 ResizeObserver 是空实现）。 */
function bumpFrames(): void {
  frameSeq += 1;
  const index = frameSeq;
  act(() => {
    useSessionStore.setState({
      frames: {
        [DEVICE_A]: frameAt(index, IMAGE_A),
        [DEVICE_B]: frameAt(index, IMAGE_B),
      },
    });
  });
}

/**
 * 给两块瓦片的画面区与 img 打上尺寸桩。
 *
 * **切活动设备之后要重打一次**：瓦片会重渲染，节点被换掉的话桩就跟着没了
 * （`retile()` 一起把两件事做掉）。
 */
function stubTiles(): void {
  for (const tile of TILES) {
    const area = screen.queryByTestId(`grid-screen-${tile.id}`);
    // 实现还没落地时画面区可能不存在：不在这里断言，让每条用例给出自己最贴切的失败信息
    if (area) {
      stubRect(area, TILE);
    }
    const img = screen.queryByAltText(`${tile.name} 画面`);
    if (img) {
      stubRect(img, TILE);
      Object.defineProperty(img, 'naturalWidth', { value: tile.image.width, configurable: true });
      Object.defineProperty(img, 'naturalHeight', { value: tile.image.height, configurable: true });
    }
  }
}

/** 切设备之后瓦片会重渲染：重打尺寸桩 + 推一帧，保证画面区重新量一次。 */
function retile(): void {
  stubTiles();
  bumpFrames();
}

function stubRect(node: HTMLElement, size: Size): void {
  node.getBoundingClientRect = () =>
    ({ left: 0, top: 0, ...size, right: size.width, bottom: size.height, x: 0, y: 0 }) as DOMRect;
}

/** 取某块瓦片的交互画面区（按契约的 testid）。 */
function screenOf(deviceId: string): HTMLElement {
  return screen.getByTestId(`grid-screen-${deviceId}`);
}

/** 画面归一化坐标 → 瓦片容器里的客户端坐标（按那块瓦片自己的 imageBox 反算，黑边不参与）。 */
function pointIn(box: Box, x: number, y: number): Point {
  return { x: box.left + x * box.width, y: box.top + y * box.height };
}

/** 一次轻触：按下 → 抬手（同一个点）。 */
function tap(target: HTMLElement, at: Point): void {
  fireEvent.pointerDown(target, { clientX: at.x, clientY: at.y, pointerId: 1, button: 0 });
  fireEvent.pointerUp(target, { clientX: at.x, clientY: at.y, pointerId: 1 });
}

/** 一次滑动：按下 → 隔 20ms 绕开 16ms 限频 → 拖到终点 → 抬手。 */
async function swipe(target: HTMLElement, from: Point, to: Point): Promise<void> {
  fireEvent.pointerDown(target, { clientX: from.x, clientY: from.y, pointerId: 1, button: 0 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  fireEvent.pointerMove(target, { clientX: to.x, clientY: to.y, pointerId: 1 });
  fireEvent.pointerUp(target, { clientX: to.x, clientY: to.y, pointerId: 1 });
}

/** 一次框选拖拽（鼠标事件）：按下 → 拖到目标 → 抬手。 */
function drag(target: HTMLElement, from: Point, to: Point): void {
  fireEvent.mouseDown(target, { clientX: from.x, clientY: from.y });
  fireEvent.mouseMove(target, { clientX: to.x, clientY: to.y });
  fireEvent.mouseUp(target, { clientX: to.x, clientY: to.y });
}

describe('多开网格：瓦片结构按契约（testid / img alt）', () => {
  beforeEach(resetStores);

  it('每块瓦片都有 瓦片/头栏/脚栏/画面 四个 testid，img alt =「设备名 画面」', () => {
    renderGrid();

    for (const tile of TILES) {
      expect(screen.getByTestId(`grid-tile-${tile.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`grid-head-${tile.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`grid-foot-${tile.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`grid-screen-${tile.id}`)).toBeInTheDocument();
      expect(screen.getByAltText(`${tile.name} 画面`)).toBeInTheDocument();
    }
  });
});

describe('多开网格：点画面要能控制（用户报的「多开点不动」）', () => {
  beforeEach(resetStores);

  it('当前设备瓦片：点画面 → down/up 发到这台设备，坐标按画面区算（不是整个容器）', () => {
    const { touch } = renderGrid();

    tap(screenOf(DEVICE_A), pointIn(BOX_A, 0.25, 0.5));

    // A 的画面是 360x640、左边 20px 黑边：容器 (110,320) → 归一化 (0.25,0.5)。
    // 按容器算会得到 0.275 —— 手机上就点偏了
    expect(touch.mock.calls).toEqual([
      [DEVICE_A, 'down', 0.25, 0.5],
      [DEVICE_A, 'up', 0.25, 0.5],
    ]);
  });

  it('当前设备瓦片：直接点在画面里的图（img 那层）也要发触控', () => {
    const { touch } = renderGrid();
    const spot = pointIn(BOX_A, 0.25, 0.5);

    // 用户点的就是图本身：指针事件从 img 冒泡上来也必须走同一套控制
    fireEvent.pointerDown(screen.getByAltText(`${NAME_A} 画面`), {
      clientX: spot.x,
      clientY: spot.y,
      pointerId: 1,
      button: 0,
    });
    fireEvent.pointerUp(screen.getByAltText(`${NAME_A} 画面`), {
      clientX: spot.x,
      clientY: spot.y,
      pointerId: 1,
    });

    expect(touch.mock.calls).toEqual([
      [DEVICE_A, 'down', 0.25, 0.5],
      [DEVICE_A, 'up', 0.25, 0.5],
    ]);
  });

  it('当前设备瓦片：拖一下画面 → down/move/up 都按这块瓦片的画面区换算', async () => {
    const { touch } = renderGrid();

    await swipe(screenOf(DEVICE_A), pointIn(BOX_A, 0.25, 0.5), pointIn(BOX_A, 0.75, 0.3));

    expect(touch.mock.calls).toEqual([
      [DEVICE_A, 'down', 0.25, 0.5],
      [DEVICE_A, 'move', 0.75, 0.3],
      [DEVICE_A, 'up', 0.75, 0.3],
    ]);
  });

  it('当前设备瓦片：拖出画面 → move/up 夹到画面边界（和单画面同一把尺子）', async () => {
    const { touch } = renderGrid();

    // 起点在画面里，终点拖到容器右下角（画面只到 x=380 / y=640）
    await swipe(screenOf(DEVICE_A), pointIn(BOX_A, 0.25, 0.5), { x: 390, y: 640 });

    expect(touch.mock.calls).toEqual([
      [DEVICE_A, 'down', 0.25, 0.5],
      [DEVICE_A, 'move', 1, 1],
      [DEVICE_A, 'up', 1, 1],
    ]);
  });

  it('点黑边（画面之外）：一个触控都不发', () => {
    const { touch } = renderGrid();

    // (5,320) 在容器里，但 A 的画面从 x=20 才开始 —— 黑边不算画面
    tap(screenOf(DEVICE_A), { x: 5, y: 320 });

    expect(touch).not.toHaveBeenCalled();
  });

  it('非当前设备瓦片：这一次手势只切活动设备、不发触控；在它上面再点才发到它', () => {
    const { touch } = renderGrid();
    expect(useDeviceStore.getState().activeId).toBe(DEVICE_A);

    tap(screenOf(DEVICE_B), pointIn(BOX_B, 0.375, 0.25));

    expect(useDeviceStore.getState().activeId).toBe(DEVICE_B);
    expect(touch).not.toHaveBeenCalled();

    // 切过去之后再点一下：这次才把这台设备的触控发出去，而且用的是 B 自己的画面区
    retile();
    tap(screenOf(DEVICE_B), pointIn(BOX_B, 0.5, 0.5));

    expect(touch.mock.calls).toEqual([
      [DEVICE_B, 'down', 0.5, 0.5],
      [DEVICE_B, 'up', 0.5, 0.5],
    ]);
  });

  it('两块瓦片各用各的画面区：同一个客户端坐标，归一化结果不同', () => {
    const { touch } = renderGrid();

    // 同一个容器坐标 (110,320)：A（竖屏，左右黑边）→ (0.25,0.5)；B（横屏，上下黑边）→ (0.275,0.5)
    tap(screenOf(DEVICE_A), { x: 110, y: 320 });
    fireEvent.click(screen.getByTestId(`grid-head-${DEVICE_B}`));
    retile();
    tap(screenOf(DEVICE_B), { x: 110, y: 320 });

    expect(touch.mock.calls).toEqual([
      [DEVICE_A, 'down', 0.25, 0.5],
      [DEVICE_A, 'up', 0.25, 0.5],
      [DEVICE_B, 'down', 0.275, 0.5],
      [DEVICE_B, 'up', 0.275, 0.5],
    ]);
  });
});

describe('多开网格：头栏 / 脚栏只负责切活动设备', () => {
  beforeEach(resetStores);

  it('点头栏 → 只切活动设备，不发触控', () => {
    const { touch } = renderGrid();

    fireEvent.click(screen.getByTestId(`grid-head-${DEVICE_B}`));

    expect(useDeviceStore.getState().activeId).toBe(DEVICE_B);
    expect(touch).not.toHaveBeenCalled();
  });

  it('点脚栏 → 只切活动设备，不发触控', () => {
    const { touch } = renderGrid();

    fireEvent.click(screen.getByTestId(`grid-foot-${DEVICE_B}`));

    expect(useDeviceStore.getState().activeId).toBe(DEVICE_B);
    expect(touch).not.toHaveBeenCalled();
  });
});

describe('多开网格：录制模式（框选 / 点选）', () => {
  beforeEach(resetStores);

  it('框选：任意瓦片画面上拖框 → 切到该瓦片设备、draft 的 rect 正确、不发触控', () => {
    const { touch } = renderGrid({ recordMode: 'marquee' });
    const from = pointIn(BOX_B, 0.25, 0.25);
    const to = pointIn(BOX_B, 0.75, 0.75);

    fireEvent.mouseDown(screenOf(DEVICE_B), { clientX: from.x, clientY: from.y });
    // 按下的那一刻就切设备：接着拖出来的框属于这台瓦片
    expect(useDeviceStore.getState().activeId).toBe(DEVICE_B);
    fireEvent.mouseMove(screenOf(DEVICE_B), { clientX: to.x, clientY: to.y });
    fireEvent.mouseUp(screenOf(DEVICE_B), { clientX: to.x, clientY: to.y });

    // B 是横屏：画面只在中间那条（上下各 207.5px 黑边），框选同样按画面区算
    expect(useUiStore.getState().draft?.rect).toEqual([0.25, 0.25, 0.5, 0.5]);
    // 录制时控制让位：一个触控都不发
    expect(touch).not.toHaveBeenCalled();
  });

  it('框选：当前设备瓦片上拖框 → rect 也按画面区换算（左边黑边不进选区）', () => {
    renderGrid({ recordMode: 'marquee' });

    drag(screenOf(DEVICE_A), pointIn(BOX_A, 0.25, 0.25), pointIn(BOX_A, 0.75, 0.75));

    expect(useDeviceStore.getState().activeId).toBe(DEVICE_A);
    expect(useUiStore.getState().draft?.rect).toEqual([0.25, 0.25, 0.5, 0.5]);
  });

  it('点选：瓦片画面上单击 → draft 是落点周围 3% 的邻域', () => {
    renderGrid({ recordMode: 'pick' });
    const spot = pointIn(BOX_A, 0.25, 0.5);

    fireEvent.mouseDown(screenOf(DEVICE_A), { clientX: spot.x, clientY: spot.y });
    fireEvent.mouseUp(screenOf(DEVICE_A), { clientX: spot.x, clientY: spot.y });

    const rect = useUiStore.getState().draft?.rect;
    expect(rect?.[0]).toBeCloseTo(0.235, 6);
    expect(rect?.[1]).toBeCloseTo(0.485, 6);
    expect(rect?.[2]).toBeCloseTo(0.03, 6);
    expect(rect?.[3]).toBeCloseTo(0.03, 6);
  });
});

describe('多开网格：控制关了只切设备', () => {
  beforeEach(resetStores);

  it('controlMode=false：点画面只切设备，一个触控都不发', () => {
    const { touch } = renderGrid({ controlMode: false });

    tap(screenOf(DEVICE_B), pointIn(BOX_B, 0.5, 0.5));
    expect(useDeviceStore.getState().activeId).toBe(DEVICE_B);
    expect(touch).not.toHaveBeenCalled();

    // 切过去之后（它已经是当前设备）再点，仍然只切设备
    retile();
    tap(screenOf(DEVICE_B), pointIn(BOX_B, 0.5, 0.5));
    expect(touch).not.toHaveBeenCalled();
  });
});

/**
 * 「先切再操作」有一条锋利边缘：`activeId` 指向的设备**不在网格里**时（它掉线了，
 * `device.store.failConnect` 只改状态、不动 activeId），网格里没有任何一格是"当前设备"。
 * 这时如果还按"第一下只切设备"，用户点哪一格都没反应 —— 和原始 bug 同形。
 * 规则：网格里没有当前设备那一格时，按下就直接当控制用。
 */
describe('多开网格：当前设备不在网格里（掉线）时，第一下就要能控制', () => {
  beforeEach(resetStores);

  it('activeId 指向网格外的设备：点唯一那块瓦片立刻发触控（不再被吞一下）', () => {
    const { touch } = renderGrid();

    act(() => {
      useDeviceStore.setState({ activeId: 'mock:9' });
    });
    retile();
    tap(screenOf(DEVICE_A), pointIn(BOX_A, 0.25, 0.5));

    expect(touch.mock.calls).toEqual([
      [DEVICE_A, 'down', 0.25, 0.5],
      [DEVICE_A, 'up', 0.25, 0.5],
    ]);
    // 顺手把它变成当前设备：之后面板/状态图/按键都跟着它
    expect(useDeviceStore.getState().activeId).toBe(DEVICE_A);
  });

  it('activeId 指向掉线设备：别的瓦片（非活动）点一下也直接控制，不再只切设备', () => {
    const { touch } = renderGrid();

    act(() => {
      useDeviceStore.setState({ activeId: 'mock:9' });
    });
    retile();
    tap(screenOf(DEVICE_B), pointIn(BOX_B, 0.5, 0.5));

    expect(useDeviceStore.getState().activeId).toBe(DEVICE_B);
    expect(touch.mock.calls).toEqual([
      [DEVICE_B, 'down', 0.5, 0.5],
      [DEVICE_B, 'up', 0.5, 0.5],
    ]);
  });
});

/**
 * 草稿跟着**设备**走：多开里"在 A 上框完、点 B 那格看一眼、再点确定"是常规操作，
 * 如果确认时现取 activeId，A 的选区就会被写进 B 的状态图（独立验证实测到的缺陷）。
 */
describe('多开网格：录制草稿归属设备（切设备不能改掉落盘目标）', () => {
  beforeEach(resetStores);

  it('在 A 上框选后切到 B 再确认：录制仍然写进 A', () => {
    // 按真实签名打桩：断言里才不用碰 any
    const record = vi
      .fn<(deviceId: string, draft: RecordDraft) => Promise<void>>()
      .mockResolvedValue(undefined);
    renderGrid({ recordMode: 'marquee' });
    useSessionStore.setState({ record });

    drag(screenOf(DEVICE_A), pointIn(BOX_A, 0.25, 0.25), pointIn(BOX_A, 0.75, 0.75));
    expect(useUiStore.getState().draft?.deviceId).toBe(DEVICE_A);

    // 切到 B 看一眼：activeId 变了，但草稿还属于 A
    fireEvent.click(screen.getByTestId(`grid-head-${DEVICE_B}`));
    expect(useDeviceStore.getState().activeId).toBe(DEVICE_B);

    // 表单只画在 A 那一格，且确认后落盘目标是 A
    expect(screen.getAllByText('确定并写入状态图')).toHaveLength(1);
    fireEvent.click(screen.getByText('确定并写入状态图'));

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toBe(DEVICE_A);
  });

  it('草稿归属的设备掉线（网格里没有它那一格）：浮层兜底仍然只有一份、还能提交', () => {
    renderGrid({ recordMode: 'marquee' });

    drag(screenOf(DEVICE_A), pointIn(BOX_A, 0.25, 0.25), pointIn(BOX_A, 0.75, 0.75));
    expect(useUiStore.getState().draft?.deviceId).toBe(DEVICE_A);

    // A 掉线：网格里只剩 B → 草稿没有自己的画面了
    act(() => {
      useDeviceStore.setState({
        devices: [
          {
            id: DEVICE_B,
            name: NAME_B,
            uri: DEVICE_B,
            kind: 'mock' as const,
            status: 'connected' as const,
            resolution: [IMAGE_B.width, IMAGE_B.height] as [number, number],
            fps: 12,
          },
        ],
      });
    });

    // 兜底浮层挂在面板上：看得见、点得到（否则草稿会卡在 store 里，Esc/确定都摸不到）
    expect(screen.getAllByText('确定并写入状态图')).toHaveLength(1);
  });
});

/**
 * 用户反馈：「返回/桌面/最近任务」原来挂在**整片网格下面**，看不出按的是哪台设备、
 * 离画面也远。它属于"当前设备的投屏框"，所以跟着当前设备那一格走。
 */
describe('多开网格：设备按键跟着当前设备那一格（不再挂在整片网格外面）', () => {
  beforeEach(resetStores);

  it('只有在**当前设备**那一格里有一条，且就是返回/桌面/最近任务', () => {
    renderGrid();

    const tileA = screen.getByTestId(`grid-tile-${DEVICE_A}`);
    const tileB = screen.getByTestId(`grid-tile-${DEVICE_B}`);

    // 整片网格里只有一条控制条（挂外面时也是一条，但它必须在 A 那一格**里面**）
    expect(screen.getAllByTestId('device-controls')).toHaveLength(1);
    expect(within(tileA).getByTestId('device-controls')).toBeInTheDocument();
    expect(within(tileB).queryByTestId('device-controls')).toBeNull();

    // 三个导航键在这一格里（"控制/录操作"仍然只在面板头）
    const bar = within(tileA).getByTestId('device-controls');
    for (const label of ['返回', '桌面', '最近任务']) {
      expect(within(bar).getByText(label)).toBeInTheDocument();
    }
    expect(within(bar).queryByText('控制')).not.toBeInTheDocument();
    expect(within(bar).queryByText('录操作')).not.toBeInTheDocument();
  });

  it('切到 B：这条跟着搬到 B 那一格（按键作用对象和它在同一格里）', () => {
    renderGrid();

    fireEvent.click(screen.getByTestId(`grid-head-${DEVICE_B}`));

    const tileA = screen.getByTestId(`grid-tile-${DEVICE_A}`);
    const tileB = screen.getByTestId(`grid-tile-${DEVICE_B}`);
    expect(within(tileB).getByTestId('device-controls')).toBeInTheDocument();
    expect(within(tileA).queryByTestId('device-controls')).toBeNull();
    expect(screen.getAllByTestId('device-controls')).toHaveLength(1);
  });

  it('单画面不变：控制条还是贴在投屏框下面（在"画面"这一格的面板里）', () => {
    renderGrid({ gridView: false });

    // 单画面没有瓦片，控制条属于 view 面板（App.test.tsx 里也守着这条）
    expect(screen.queryByTestId(`grid-tile-${DEVICE_A}`)).toBeNull();
    const bar = screen.getByTestId('device-controls');
    expect(bar.closest('[data-panel]')?.id).toBe('view');
    expect(screen.getAllByTestId('device-controls')).toHaveLength(1);
  });

  it('面板很矮时兜住画面：行高有下限、矮到放不下就让网格自己滚（不能把画面压没）', () => {
    renderGrid();

    // 当前设备那格多了控制条（约 30px），头/脚栏也都是 shrink-0 ——
    // 行高如果没有下限，"1fr" 会把画面压到接近 0（"多开看不到画面"的第二形态）
    const grid = screen.getByTestId(`grid-tile-${DEVICE_A}`).parentElement;
    expect(grid?.className).toContain('overflow-auto');
    expect(grid?.style.gridTemplateRows).toContain('132px');
    expect(grid?.style.gridAutoRows).toContain('132px');
  });

  it('窄格子里按键文字收成图标（三个带文字的键会顶出格子）', () => {
    renderGrid();

    const bar = within(screen.getByTestId(`grid-tile-${DEVICE_A}`)).getByTestId('device-controls');
    // 文字仍在 DOM 里（getByText 找得到），只是窄容器里不显示；完整说明在 button 的 title
    expect(within(bar).getByText('返回').className).toContain('hidden');
    expect(within(bar).getByText('返回').className).toContain('@[210px]:inline');
  });
});

/** 每条用例都从「控制开着、没在录制、两张画布都干净」开始。 */
function resetStores(): void {
  frameSeq = 1;
  useSessionStore.setState({ ready: {}, frames: {}, touch: vi.fn(), recordStep: vi.fn(), error: null });
  useUiStore.setState({ draft: null, recordMode: 'off', controlMode: true, recordActionMode: false });
}
