import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { YoloRecognizerDialog } from '@/features/device/YoloRecognizerDialog';
import { exampleThumbnailStyle } from '@/features/device/yolo-example-thumbnail';
import type {
  FrameAtPayload,
  FrameMetaPayload,
  YoloModelsPayload,
  YoloRecognizerDetail,
  YoloStatusPayload,
} from '@/lib/rpc';
import { WORKFLOW_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useYoloStore } from '@/stores/yolo.store';
import type { RecognizerView } from '@/types';

const {
  detailMock,
  frameMetaMock,
  frameAtMock,
  recordingStartMock,
  recordingStopMock,
  recordingMetaMock,
  recordingFrameAtMock,
  recordingDeleteMock,
  yoloModelsMock,
  yoloStatusMock,
  previewYoloMock,
} = vi.hoisted(() => ({
  detailMock: vi.fn<() => Promise<YoloRecognizerDetail>>(),
  frameMetaMock: vi.fn<() => Promise<FrameMetaPayload>>(),
  frameAtMock:
    vi.fn<(deviceId: string, index: number, options?: { nearest?: boolean }) => Promise<FrameAtPayload>>(),
  recordingStartMock: vi.fn(),
  recordingStopMock: vi.fn(),
  recordingMetaMock: vi.fn(),
  recordingFrameAtMock: vi.fn(),
  recordingDeleteMock: vi.fn(),
  yoloModelsMock: vi.fn<() => Promise<YoloModelsPayload>>(),
  yoloStatusMock: vi.fn<() => Promise<YoloStatusPayload>>(),
  previewYoloMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock('@/lib/rpc', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    recognizerDetail: detailMock,
    frameMeta: frameMetaMock,
    frameAt: frameAtMock,
    recordingStart: recordingStartMock,
    recordingStop: recordingStopMock,
    recordingMeta: recordingMetaMock,
    recordingFrameAt: recordingFrameAtMock,
    recordingDelete: recordingDeleteMock,
    yoloModels: yoloModelsMock,
    previewYolo: previewYoloMock,
    frameHistory: vi.fn(),
    yoloStatus: yoloStatusMock,
    yoloInstall: vi.fn(),
    yoloRemove: vi.fn(),
  };
});

const DEVICE = 'mock:1';

function aiRecognizer(label: string): RecognizerView {
  return {
    label,
    type: 'yolo',
    classes: [],
    examplesCount: 1,
    score: 0,
    threshold: 0.3,
    roi: [0, 0, 1, 1],
    search: 'region',
    samples: 0,
    state: 'idle',
  };
}

function detail(extra: Partial<YoloRecognizerDetail> = {}): YoloRecognizerDetail {
  return {
    label: 'ai_9',
    threshold: 0.13,
    search: 'full',
    imgsz: 1280,
    tile: true,
    tileSize: 960,
    tileOverlap: 0.2,
    examples: [
      {
        rect: [0.1, 0.1, 0.2, 0.2],
        label: 'ai_9',
        image: 'data:image/jpeg;base64,AAAA',
        width: 8,
        height: 8,
      },
      {
        rect: [0.5, 0.5, 0.2, 0.2],
        label: 'ai_9',
        image: 'data:image/jpeg;base64,BBBB',
        width: 8,
        height: 8,
      },
    ],
    ...extra,
  };
}

function frameMeta(indices: number[], width = 100, height = 100): FrameMetaPayload {
  return {
    count: indices.length,
    firstIndex: indices[0] ?? 0,
    lastIndex: indices[indices.length - 1] ?? 0,
    width,
    height,
    indices,
  };
}

function frameAtPayload(index: number, requestedIndex = index): FrameAtPayload {
  return { index, requestedIndex, jpeg: 'AAAA', width: 100, height: 100, ts: 1 };
}

/** 手动录制：点一次开始、再点一次结束，生成一条 take（时间轴只显示录制内容）。 */
async function recordTake(): Promise<void> {
  await screen.findByTestId('yolo-draw-layer');
  fireEvent.click(screen.getByTestId('yolo-record'));
  await waitFor(() => expect(screen.getByTestId('yolo-record')).toHaveAttribute('aria-pressed', 'true'));
  fireEvent.click(screen.getByTestId('yolo-record'));
  await waitFor(() => expect(recordingStopMock).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId('yolo-frame-counter')).not.toHaveTextContent('未录制'));
  // 保存不再抢画面；测试需要浏览录制时显式选择最新帧。
  fireEvent.click(screen.getByTestId('yolo-frame-last'));
}

beforeEach(() => {
  detailMock.mockReset();
  frameMetaMock.mockReset();
  frameAtMock.mockReset();
  recordingStartMock.mockReset();
  recordingStopMock.mockReset();
  recordingMetaMock.mockReset();
  recordingFrameAtMock.mockReset();
  recordingDeleteMock.mockReset();
  recordingStartMock.mockResolvedValue({ recordingId: 'rec-1', active: true, count: 0 });
  recordingStopMock.mockResolvedValue({ recordingId: 'rec-1', active: false, count: 0 });
  recordingMetaMock.mockImplementation(async () => {
    const meta = await frameMetaMock();
    return { recordingId: 'rec-1', active: false, ...meta, hasMore: false };
  });
  recordingFrameAtMock.mockImplementation((_deviceId: string, _recordingId: string, index: number) =>
    Promise.resolve(frameAtPayload(index)),
  );
  recordingDeleteMock.mockResolvedValue({ ok: true });
  yoloModelsMock.mockReset();
  previewYoloMock.mockReset();
  yoloStatusMock.mockReset();

  yoloStatusMock.mockResolvedValue({
    component: { installed: true, version: '0.2.0', path: '', sizeMb: 0, manifest: {} },
    runtime: { available: false, device: 'cuda', error: '' },
  });
  frameMetaMock.mockResolvedValue(frameMeta([101]));
  frameAtMock.mockImplementation((_deviceId, index) => Promise.resolve(frameAtPayload(index)));
  yoloModelsMock.mockResolvedValue({
    models: ['yoloe-11s-seg.pt'],
    model: 'yoloe-11s-seg.pt',
    dir: '',
    device: 'cuda',
  });
  previewYoloMock.mockResolvedValue({
    dets: [],
    ms: 12,
    inferMs: 8,
    queueMs: 0,
    device: 'cuda',
    width: 100,
    height: 100,
  });

  // jsdom 没有布局：给拖框一个固定的画面尺寸，让归一化坐标算得出来
  // （指针捕获由 src/test/setup.ts 补的空实现负责）
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  });

  if (typeof crypto.randomUUID !== 'function') {
    Object.defineProperty(crypto, 'randomUUID', { value: () => 'uuid-1', writable: true });
  }
  useYoloStore.setState({
    status: { installed: true, version: '0.2.0', path: '', sizeMb: 0, manifest: {} },
    runtimeAvailable: false,
    loading: false,
    installing: false,
    error: null,
    runtimeError: null,
    runtimeDevice: 'cuda',
  });
  useGraphStore.setState({
    graphs: {
      [WORKFLOW_SCOPE]: {
        deviceId: '',
        nodes: [],
        edges: [],
        recognizers: [aiRecognizer('ai_8'), aiRecognizer('ai_9')],
        variables: [],
        activeNodeId: null,
        pendingNodeId: null,
      },
    },
  });
  useSessionStore.setState({ frames: {}, touch: vi.fn(() => Promise.resolve(true)) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AI 识别弹窗的会话隔离', () => {
  it('编辑过一个识别器后，再点新建不会带上它的示例框和参数', async () => {
    detailMock.mockResolvedValue(detail());
    const onClose = vi.fn();

    const { rerender } = render(
      <YoloRecognizerDialog deviceId={DEVICE} open editLabel="ai_9" onClose={onClose} />,
    );
    // 编辑模式：两个示例框都载入
    expect(await screen.findByTestId('yolo-mark-toggle-e0')).toBeInTheDocument();
    expect(screen.getByTestId('yolo-mark-toggle-e1')).toBeInTheDocument();
    expect(screen.getByTestId('yolo-label')).toHaveValue('ai_9');

    // 关掉，再点「新建 AI 识别器」
    rerender(<YoloRecognizerDialog deviceId={DEVICE} open={false} editLabel="ai_9" onClose={onClose} />);
    rerender(<YoloRecognizerDialog deviceId={DEVICE} open editLabel={null} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.queryByTestId('yolo-mark-toggle-e0')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('yolo-mark-toggle-e1')).not.toBeInTheDocument();
    // 名字回到新识别器的建议名（不是上一个的 ai_9）
    expect(screen.getByTestId('yolo-label')).toHaveValue('ai_3');
    expect(detailMock).toHaveBeenCalledTimes(1);
  });

  it('编辑模式改名后保存会带上新名字，后端原子改名与参数一起生效', async () => {
    detailMock.mockResolvedValue(detail());
    const update = vi.fn(() => Promise.resolve(true));
    useSessionStore.setState({ updateYoloRecognizer: update });
    render(<YoloRecognizerDialog deviceId={DEVICE} open editLabel="ai_9" onClose={() => undefined} />);

    const name = await screen.findByTestId('yolo-label');
    await waitFor(() => expect(name).toHaveValue('ai_9'));
    // 编辑模式也必须允许改名（以前这里 disabled，用户改完以为保存了）
    expect(name).toBeEnabled();
    fireEvent.change(name, { target: { value: '  首领  ' } });
    expect(screen.getByTestId('yolo-label')).toHaveValue('  首领  ');

    await waitFor(() => expect(screen.getByTestId('yolo-save')).toBeEnabled());
    fireEvent.click(screen.getByTestId('yolo-save'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const [, from, , to] = update.mock.calls[0] as unknown as [string, string, unknown, string];
    expect(from).toBe('ai_9');
    expect(to).toBe('首领');
  });

  it('编辑结果晚到时不会污染已经切过去的新建会话', async () => {
    let resolveDetail: (value: YoloRecognizerDetail) => void = () => undefined;
    detailMock.mockImplementation(
      () =>
        new Promise<YoloRecognizerDetail>((resolve) => {
          resolveDetail = resolve;
        }),
    );
    const onClose = vi.fn();

    const { rerender } = render(
      <YoloRecognizerDialog deviceId={DEVICE} open editLabel="ai_9" onClose={onClose} />,
    );
    await waitFor(() => {
      expect(detailMock).toHaveBeenCalledTimes(1);
    });

    // 关掉并切到新建：此时 detail 还没回来
    rerender(<YoloRecognizerDialog deviceId={DEVICE} open={false} editLabel="ai_9" onClose={onClose} />);
    rerender(<YoloRecognizerDialog deviceId={DEVICE} open editLabel={null} onClose={onClose} />);

    resolveDetail(detail());

    expect(screen.queryByTestId('yolo-mark-toggle-e0')).not.toBeInTheDocument();
    expect(screen.getByTestId('yolo-label')).toHaveValue('ai_3');
  });
});

describe('AI 识别弹窗的布局与结构', () => {
  it('右栏按功能区排布，安装组件和导入模型分成两件事', async () => {
    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);

    expect(await screen.findByTestId('yolo-example-list')).toBeInTheDocument();
    expect(screen.getByText('检测参数')).toBeInTheDocument();
    expect(screen.getByText('模型与环境')).toBeInTheDocument();
    // 模型导入在「模型」行，组件安装单独一行：不再挤在标题栏里抢位置
    expect(await screen.findByTestId('yolo-add-model')).toBeInTheDocument();
    expect(screen.getByTestId('yolo-install-component')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^组件…$/ })).toBeNull();
    // 弹窗本身是可访问的 dialog，底部主操作是「保存识别器」
    expect(screen.getByTestId('yolo-recognizer-dialog')).toHaveAttribute('role', 'dialog');
    const workspace = screen.getByTestId('yolo-workspace');
    expect(screen.getByTestId('yolo-screen-panel').parentElement).toBe(workspace);
    expect(screen.getByTestId('yolo-timeline-panel').parentElement).toBe(workspace);
    expect(screen.getByTestId('yolo-screen-panel')).toHaveClass('bg-canvas');
    expect(screen.getByTestId('yolo-screen-panel')).not.toHaveClass('p-3', 'lg:p-4');
    expect(screen.getByTestId('yolo-example-frame')).not.toHaveClass('border', 'rounded-sm');
    expect(screen.getByTestId('yolo-timeline-panel')).toHaveClass('bg-raised', 'border-t');
    expect(screen.queryByRole('separator', { name: '调整底部区域高度' })).not.toBeInTheDocument();
    const recordingHeader = screen.getByTestId('yolo-recording-header');
    expect(recordingHeader).toHaveClass('h-7');
    expect(recordingHeader).not.toHaveClass('min-h-9');
    expect(screen.getByTestId('yolo-mode-mark').querySelector('svg')).toHaveClass('lucide-scan', 'size-3');
    expect(screen.getByTestId('yolo-mode-control').querySelector('svg')).toHaveClass(
      'lucide-mouse-pointer-2',
      'size-3',
    );
    const playbackToolbar = screen.getByTestId('yolo-playback-toolbar');
    expect(recordingHeader.parentElement).toBe(screen.getByTestId('yolo-timeline-panel'));
    expect(playbackToolbar.parentElement).toBe(screen.getByTestId('yolo-screen-panel'));
    for (const id of ['yolo-record', 'yolo-mode-control', 'yolo-mode-mark', 'yolo-toolbar-clear']) {
      expect(recordingHeader).toContainElement(screen.getByTestId(id));
      expect(playbackToolbar).not.toContainElement(screen.getByTestId(id));
    }
    for (const id of ['yolo-frame-play', 'yolo-frame-prev', 'yolo-frame-next']) {
      expect(playbackToolbar).toContainElement(screen.getByTestId(id));
      expect(recordingHeader).not.toContainElement(screen.getByTestId(id));
    }
    expect(screen.queryByTestId('yolo-toolbar-detect')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '开始实时检测' })).toHaveLength(1);
    const playbackActions = screen.getByTestId('yolo-playback-actions');
    expect(playbackActions).toHaveClass('justify-self-end');
    for (const id of ['yolo-frame-live', 'yolo-refresh-frame', 'yolo-playback-fps']) {
      expect(playbackActions).toContainElement(screen.getByTestId(id));
    }
    const liveButton = screen.getByTestId('yolo-frame-live');
    const refreshButton = screen.getByTestId('yolo-refresh-frame');
    expect(liveButton).toHaveTextContent('实时');
    expect(refreshButton).toHaveTextContent('刷新');
    expect(liveButton.querySelector('.lucide-radio')).toBeInTheDocument();
    expect(liveButton.querySelector('.lucide-play')).not.toBeInTheDocument();
    expect(playbackActions.lastElementChild?.children).toHaveLength(2);
    expect(playbackActions.lastElementChild?.firstElementChild).toBe(refreshButton);
    expect(playbackActions.lastElementChild?.lastElementChild).toBe(liveButton);
    expect(playbackActions).not.toContainElement(screen.getByTestId('yolo-frame-play'));
    expect(screen.getByTestId('yolo-settings')).toHaveClass('bg-panel');
    expect(screen.getByText('示例').closest('section')).toHaveClass('bg-raised');
    expect(screen.getByText('检测参数').closest('section')).not.toHaveClass('border-t');
    expect(screen.getByTestId('yolo-save')).toHaveTextContent('保存识别器');
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
  });

  it('长方形框的示例缩略图仅显示框内，参考帧与坐标仍一并发送给模型', () => {
    const image = 'data:image/jpeg;base64,REFERENCE';
    const style = exampleThumbnailStyle(image, [0.25, 0.25, 0.5, 0.25], 800, 600);
    // 400×150 的选区缩进 40×40：内容为 40×15，垂直两侧各留 12.5px。
    expect(style.backgroundSize).toBe('80px 60px');
    expect(style.backgroundPosition).toBe('-20px -2.5px');
    expect(style.clipPath).toBe('inset(12.5px 0px)');
    expect(style.backgroundRepeat).toBe('no-repeat');
    expect(style.backgroundImage).toBe(`url(${image})`);
    // 高而窄的框同样必须遮掉左右两侧，不把框外场景当示例。
    const tall = exampleThumbnailStyle(image, [0.2, 0.1, 0.1, 0.5], 800, 600);
    expect(tall.clipPath).toBe('inset(0px 14.666666666666668px)');
  });

  it('预览传整张参考帧和松手时的精确长方形框，而不是框外扩大的区域', async () => {
    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);
    const layer = await screen.findByTestId('yolo-draw-layer');
    fireEvent.pointerDown(layer, { clientX: 200, clientY: 150, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 440, clientY: 300, pointerId: 1 });
    await screen.findByTestId('yolo-mark-toggle-m1');
    fireEvent.click(screen.getByTestId('yolo-detect-toggle'));
    await waitFor(() => expect(previewYoloMock).toHaveBeenCalled());
    const args: unknown = previewYoloMock.mock.calls[0]?.[1];
    const example = (args as { examples: { image: string; rect: number[] }[] }).examples[0];
    expect(example?.image).toMatch(/^data:image\//);
    const sent = example?.rect ?? [];
    expect(sent[0]).toBeCloseTo(0.25);
    expect(sent[1]).toBeCloseTo(0.25);
    expect(sent[2]).toBeCloseTo(0.3);
    expect(sent[3]).toBeCloseTo(0.25);
  });

  it('拖框加示例后，保存与开始检测跟着可用', async () => {
    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);

    const layer = await screen.findByTestId('yolo-draw-layer');
    fireEvent.pointerDown(layer, { clientX: 200, clientY: 150, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 400, clientY: 300, pointerId: 1 });

    expect(await screen.findByTestId('yolo-mark-toggle-m1')).toBeInTheDocument();
    expect(screen.getByTestId('yolo-mark-thumb-m1').style.clipPath).toContain('inset(');
    expect(screen.getByText('1/1 启用')).toBeInTheDocument();
    expect(screen.getByTestId('yolo-detect-toggle')).toBeEnabled();
    expect(screen.getByTestId('yolo-save')).toBeEnabled();
    expect(screen.queryByText('还没有示例框')).not.toBeInTheDocument();

    // 点缩略图 = 暂时停用；删除后回到空态
    fireEvent.click(screen.getByTestId('yolo-mark-toggle-m1'));
    expect(screen.getByText('0/1 启用')).toBeInTheDocument();
    expect(screen.getByTestId('yolo-save')).toBeDisabled();
    fireEvent.click(screen.getByTestId('yolo-mark-remove-m1'));
    expect(screen.queryByTestId('yolo-mark-toggle-m1')).not.toBeInTheDocument();
    expect(screen.getByText('还没有示例框')).toBeInTheDocument();

    // 再框一个，「清空」把全部示例一起删掉
    fireEvent.pointerDown(layer, { clientX: 200, clientY: 150, pointerId: 2 });
    fireEvent.pointerMove(layer, { clientX: 420, clientY: 320, pointerId: 2 });
    fireEvent.pointerUp(layer, { clientX: 420, clientY: 320, pointerId: 2 });
    expect(await screen.findByTestId('yolo-mark-toggle-m2')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('yolo-example-clear'));
    expect(screen.queryByTestId('yolo-mark-toggle-m2')).not.toBeInTheDocument();
    expect(screen.getByText('还没有示例框')).toBeInTheDocument();
  });

  it('Esc 关闭弹窗', async () => {
    const onClose = vi.fn();
    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={onClose} />);
    await screen.findByTestId('yolo-frame-counter');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('编辑模式也能刷新当前画面、继续拖框加示例', async () => {
    detailMock.mockResolvedValue(detail());
    frameMetaMock.mockResolvedValue(frameMeta([500, 501]));
    render(<YoloRecognizerDialog deviceId={DEVICE} open editLabel="ai_9" onClose={() => undefined} />);

    // 已保存的两个示例都在
    expect(await screen.findByTestId('yolo-mark-toggle-e0')).toBeInTheDocument();
    expect(screen.getByTestId('yolo-mark-toggle-e1')).toBeInTheDocument();
    // 编辑模式必须有「重取画面」入口（旧版这里被整条工具栏藏掉了）
    expect(screen.getByTestId('yolo-refresh-frame')).toBeInTheDocument();

    // 继续拖框追加示例
    const layer = await screen.findByTestId('yolo-draw-layer');
    fireEvent.pointerDown(layer, { clientX: 200, clientY: 150, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 400, clientY: 300, pointerId: 1 });
    expect(await screen.findByTestId('yolo-mark-toggle-m1')).toBeInTheDocument();
    expect(screen.getByText('3/3 启用')).toBeInTheDocument();
    expect(screen.getByTestId('yolo-save')).toBeEnabled();

    // 点刷新：背景换成当前画面，进度条/回放跟着可用
    await recordTake();
    await waitFor(() => expect(screen.getByTestId('yolo-frame-counter')).toHaveTextContent('2 / 2'));
    fireEvent.click(screen.getByTestId('yolo-refresh-frame'));
    expect(screen.getByTestId('yolo-frame-play')).toBeEnabled();
    // 刷新不会清掉已加载/新加的示例
    expect(screen.getByTestId('yolo-mark-toggle-e0')).toBeInTheDocument();
    expect(screen.getByTestId('yolo-mark-toggle-m1')).toBeInTheDocument();
  });

  it('组件未安装时先给安装入口，检测和保存都置灰并说明原因', async () => {
    yoloStatusMock.mockResolvedValue({
      component: { installed: false, version: null, path: '', sizeMb: 0, manifest: {} },
      runtime: { available: false, device: '', error: '' },
    });
    useYoloStore.setState({ status: null, runtimeAvailable: false, loading: false, error: null });

    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);

    expect(await screen.findByTestId('yolo-component-status')).toBeInTheDocument();
    expect(screen.getByTestId('yolo-install')).toBeInTheDocument();
    expect(screen.getByTestId('yolo-install-file')).toBeInTheDocument();
    expect(screen.getByTestId('yolo-detect-toggle')).toBeDisabled();
    expect(screen.getByTestId('yolo-save')).toBeDisabled();
    expect(screen.getByText('先安装 AI 组件')).toBeInTheDocument();
  });

  it('组件状态还在检查时显示「检查组件…」，别谎报未安装', async () => {
    // status 请求一直不返回：loading 保持 true
    yoloStatusMock.mockReturnValue(new Promise<YoloStatusPayload>(() => undefined));
    useYoloStore.setState({ status: null, runtimeAvailable: false, loading: true, error: null });

    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);

    expect(await screen.findByText('检查组件…')).toBeInTheDocument();
    expect(screen.getAllByText('正在检查 AI 组件…').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('未安装 AI 组件')).toBeNull();
  });
});

describe('帧缓冲的容错', () => {
  it('请求的帧已被滚出缓冲时跳到最近帧并提示，不把引擎报错抛给用户', async () => {
    const indices = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111];
    frameMetaMock.mockResolvedValue(frameMeta(indices));
    // 录制帧来自独立存储，不会被预览环形缓冲挤掉；旧缓冲仍可就近取帧。
    frameAtMock.mockImplementation((_deviceId, index) =>
      Promise.resolve(index === 100 ? frameAtPayload(104, 100) : frameAtPayload(index)),
    );

    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);
    await recordTake();
    await waitFor(() => expect(screen.getByTestId('yolo-frame-counter')).toHaveTextContent('12 / 12'));

    fireEvent.change(screen.getByTestId('yolo-frame-slider'), { target: { value: '0' } });

    await waitFor(() => expect(recordingFrameAtMock).toHaveBeenCalledWith(DEVICE, 'rec-1', 100));
    await waitFor(() => expect(screen.getByTestId('yolo-frame-counter')).toHaveTextContent('1 / 12'));
    expect(screen.queryByText(/已跳到最近保留的一帧/)).toBeNull();
  });

  it('旧引擎不认识 nearest 时，取帧失败会兜底到最新帧并提示', async () => {
    frameMetaMock.mockResolvedValue(frameMeta([100, 101, 102]));
    // 模拟旧引擎：没有 nearest 参数，滚出缓冲直接 reject
    frameAtMock.mockImplementation((_deviceId, index) =>
      index === 100
        ? Promise.reject(new Error('第 100 帧已被滚出缓冲（当前保留 101~102）'))
        : Promise.resolve(frameAtPayload(index)),
    );

    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);
    await recordTake();
    await waitFor(() => expect(screen.getByTestId('yolo-frame-counter')).toHaveTextContent('3 / 3'));

    fireEvent.change(screen.getByTestId('yolo-frame-slider'), { target: { value: '0' } });

    await waitFor(() => expect(recordingFrameAtMock).toHaveBeenCalledWith(DEVICE, 'rec-1', 100));
    await waitFor(() => expect(screen.getByTestId('yolo-frame-counter')).toHaveTextContent('1 / 3'));
    expect(screen.queryByText(/已跳到最新画面/)).toBeNull();
  });
});

describe('实时检测的停止与跟随', () => {
  it('停止检测后点「实时」跟随会清掉上一轮检测框和统计，避免框随新画面漂移', async () => {
    previewYoloMock.mockResolvedValue({
      dets: [{ class: 'ai_3', conf: 0.9, bbox: [10, 10, 30, 30] }],
      ms: 12,
      inferMs: 8,
      queueMs: 0,
      device: 'cuda',
      width: 100,
      height: 100,
    });

    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);
    const layer = await screen.findByTestId('yolo-draw-layer');
    fireEvent.pointerDown(layer, { clientX: 200, clientY: 150, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 400, clientY: 300, pointerId: 1 });

    fireEvent.click(screen.getByTestId('yolo-detect-toggle'));
    await waitFor(() => expect(screen.getByTestId('yolo-detect-toggle')).toHaveTextContent('停止检测'));
    await waitFor(() => expect(screen.getAllByText(/1 个目标/).length).toBeGreaterThan(0));

    fireEvent.click(screen.getByTestId('yolo-detect-toggle'));
    await waitFor(() => expect(screen.getByTestId('yolo-detect-toggle')).toHaveTextContent('开始实时检测'));
    // 停止后保留「上次检测」统计（检测框还挂在冻住的画面上）
    await waitFor(() => expect(screen.getByText(/上次检测/)).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('yolo-frame-live'));
    expect(screen.queryByText(/上次检测/)).toBeNull();
    expect(screen.queryByText(/^上次 /)).toBeNull();
    await waitFor(() => expect(screen.queryAllByText(/1 个目标/)).toHaveLength(0));
  });
});

describe('YoloRecognizerDialog 帧时间轴', () => {
  it('运行的引擎缺少新录制接口时提示重启，而非直接抛未知方法', async () => {
    recordingStartMock.mockRejectedValue(new Error('引擎返回错误: 未知方法: recording.start'));
    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);
    await screen.findByTestId('yolo-draw-layer');
    fireEvent.click(screen.getByTestId('yolo-record'));
    await waitFor(() =>
      expect(screen.getByText(/引擎是旧进程.*recording.start.*重启引擎/)).toBeInTheDocument(),
    );
    expect(screen.getByTestId('yolo-record')).toHaveAttribute('aria-pressed', 'false');
  });

  it('录制跨过预览缓冲上限仍可分页取得所有帧，按录制 ID 精确取图', async () => {
    const indices = Array.from({ length: 720 }, (_, index) => 1000 + index);
    recordingMetaMock.mockImplementation((_deviceId: string, _recordingId: string, afterIndex?: number) => {
      const start = afterIndex === undefined ? 0 : indices.indexOf(afterIndex) + 1;
      const page = indices.slice(start, start + 500);
      return {
        recordingId: 'rec-1',
        count: indices.length,
        active: false,
        indices: page,
        hasMore: start + page.length < indices.length,
        nextAfterIndex: page.at(-1),
      };
    });
    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);
    await recordTake();
    expect(screen.getByTestId('yolo-frame-counter')).toHaveTextContent('720 / 720');
    // 停止时的收尾也走同一套分页：第二页（afterIndex=1499）必须被取过
    expect(recordingMetaMock.mock.calls.filter((call) => call[2] === 1499).length).toBeGreaterThanOrEqual(1);
    fireEvent.change(screen.getByTestId('yolo-frame-slider'), { target: { value: '0' } });
    await waitFor(() => expect(recordingFrameAtMock).toHaveBeenCalledWith(DEVICE, 'rec-1', 1000));
    await waitFor(() => expect(screen.getByTestId('yolo-frame-counter')).toHaveTextContent('1 / 720'));
  });

  it('显示画面帧率，并把已加载帧画成真实缩略图', async () => {
    frameMetaMock.mockResolvedValue(frameMeta([100, 101, 102]));
    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);
    await recordTake();
    await waitFor(() => expect(screen.getByTestId('yolo-frame-counter')).toHaveTextContent('3 / 3'));
    expect(screen.getByTestId('yolo-frame-timeline')).toBeInTheDocument();
    expect(screen.getByTestId('yolo-timeline-fps')).toHaveTextContent('画面');
    expect(screen.getByTestId('yolo-timeline-fps')).toHaveTextContent('fps');
    expect(screen.getByTestId('yolo-timeline-track')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId('yolo-timeline-thumb').length).toBeGreaterThan(0));
    // 首/尾帧可以直接跳；播放录制按当前帧推进，不能误切换为实时画面
    fireEvent.click(screen.getByTestId('yolo-frame-first'));
    await waitFor(() => expect(screen.getByTestId('yolo-frame-counter')).toHaveTextContent('1 / 3'));
    fireEvent.click(screen.getByTestId('yolo-frame-play'));
    expect(screen.getByTestId('yolo-frame-play')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByTestId('yolo-frame-counter')).toHaveTextContent('3 / 3'));
    expect(recordingFrameAtMock).toHaveBeenCalledWith(DEVICE, 'rec-1', 102);
    expect(screen.getByTestId('yolo-frame-live')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('YoloRecognizerDialog 标注/控制模式', () => {
  it('控制模式点画面转成设备 touch，不生成示例', async () => {
    const touch = vi.fn(() => Promise.resolve(true));
    useSessionStore.setState({ touch });
    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);

    const layer = await screen.findByTestId('yolo-draw-layer');
    fireEvent.click(screen.getByTestId('yolo-mode-control'));
    expect(screen.getByTestId('yolo-mode-control')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.pointerDown(layer, { clientX: 240, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 240, clientY: 300, pointerId: 1 });

    // 800×600 的可视区域里 (240,300) = 归一化 (0.3, 0.5)
    expect(touch).toHaveBeenCalledWith(DEVICE, 'down', 0.3, 0.5);
    expect(touch).toHaveBeenCalledWith(DEVICE, 'up', 0.3, 0.5);
  });
});

describe('YoloRecognizerDialog 录制中的时间轴', () => {
  it('录制保留实时画面，实时和刷新仍可用，标注与控制照常工作，停止也不抢画面', async () => {
    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);
    const layer = await screen.findByTestId('yolo-draw-layer');
    fireEvent.click(screen.getByTestId('yolo-frame-live'));
    expect(screen.getByTestId('yolo-frame-live')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('yolo-record'));
    await waitFor(() => expect(screen.getByTestId('yolo-record')).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByTestId('yolo-frame-live')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('yolo-frame-live')).toBeEnabled();
    expect(screen.getByTestId('yolo-refresh-frame')).toBeEnabled();
    frameMetaMock.mockResolvedValue(frameMeta([102]));
    frameAtMock.mockImplementation((_deviceId, index) =>
      Promise.resolve({ ...frameAtPayload(index), jpeg: 'BBBB' }),
    );
    await waitFor(() =>
      expect(screen.getByAltText('冻结画面')).toHaveAttribute('src', 'data:image/jpeg;base64,BBBB'),
    );
    fireEvent.pointerDown(layer, { clientX: 200, clientY: 150, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 400, clientY: 300, pointerId: 1 });
    expect(screen.getByTestId('yolo-mark-toggle-m1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('yolo-mode-control'));
    fireEvent.pointerDown(layer, { clientX: 240, clientY: 300, pointerId: 2 });
    fireEvent.pointerUp(layer, { clientX: 240, clientY: 300, pointerId: 2 });
    expect(useSessionStore.getState().touch).toHaveBeenCalledWith(DEVICE, 'down', 0.3, 0.5);
    fireEvent.click(screen.getByTestId('yolo-record'));
    await waitFor(() => expect(screen.getByTestId('yolo-record')).toHaveAttribute('aria-pressed', 'false'));
    expect(screen.getByTestId('yolo-frame-live')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('yolo-mode-control')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('yolo-mark-toggle-m1')).toBeInTheDocument();
  });

  it('录制中边录边长，并给每一块补上这一帧的图', async () => {
    const liveIndices = [500, 501, 502];
    recordingMetaMock.mockImplementation(() =>
      Promise.resolve({
        recordingId: 'rec-1',
        active: true,
        count: liveIndices.length,
        firstIndex: liveIndices[0] ?? 0,
        lastIndex: liveIndices[liveIndices.length - 1] ?? 0,
        indices: [...liveIndices],
        hasMore: false,
        nextAfterIndex: liveIndices[liveIndices.length - 1],
      }),
    );

    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);
    await screen.findByTestId('yolo-draw-layer');
    fireEvent.click(screen.getByTestId('yolo-record'));
    await waitFor(() => expect(screen.getByTestId('yolo-record')).toHaveAttribute('aria-pressed', 'true'));

    // 不用等停止：时间轴已经跟着引擎里已录下的帧长出来了
    await waitFor(() => expect(screen.getAllByTestId('yolo-timeline-thumb')).toHaveLength(3));
    expect(screen.getByTestId('yolo-live-take')).toHaveTextContent('录制中');
    expect(screen.getByText(/正在录制 3 帧/)).toBeInTheDocument();

    // 每一块都按「录制 ID + 帧号」取到自己的图，中间不留空白
    await waitFor(() => {
      const cells = screen.getAllByTestId('yolo-timeline-thumb');
      expect(cells.every((cell) => cell.querySelector('span[aria-hidden="true"]') !== null)).toBe(true);
    });
    expect(recordingFrameAtMock).toHaveBeenCalledWith(DEVICE, 'rec-1', 500);

    fireEvent.click(screen.getByTestId('yolo-record'));
    await waitFor(() => expect(recordingStopMock).toHaveBeenCalled());
  });
});

describe('YoloRecognizerDialog 手动 ROI', () => {
  /** 在 ROI 模式下拖一个框：不做成示例，只当搜索区域。 */
  async function drawRoi(): Promise<void> {
    fireEvent.click(await screen.findByTestId('yolo-mode-roi'));
    const layer = await screen.findByTestId('yolo-draw-layer');
    fireEvent.pointerDown(layer, { clientX: 200, clientY: 150, pointerId: 7 });
    fireEvent.pointerMove(layer, { clientX: 400, clientY: 300, pointerId: 7 });
    fireEvent.pointerUp(layer, { clientX: 400, clientY: 300, pointerId: 7 });
  }

  it('ROI 模式下拖框只设搜索区域，不会生成示例框', async () => {
    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);
    await screen.findByTestId('yolo-draw-layer');

    await drawRoi();

    // 示例仍然是 0 个；ROI 已经出现（面板给出「已设置 ROI」+ 清除入口）
    expect(screen.getByText('还没有示例框')).toBeInTheDocument();
    expect(await screen.findByText(/已设置 ROI/)).toBeInTheDocument();
    expect(screen.getByTestId('yolo-roi-clear')).toBeInTheDocument();
    // 框完自动回标注模式（否则按钮会一直停在“在画面上拖框…”）
    expect(screen.getByTestId('yolo-mode-roi')).toHaveAttribute('aria-pressed', 'false');
  });

  it('设置面板里有「标记 ROI」按钮，点了切到 ROI 模式；设好后显示矢量示意', async () => {
    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);
    await screen.findByTestId('yolo-draw-layer');

    // 未设置：空态示意 + 按钮文案是「标记 ROI」
    expect(screen.getByTestId('yolo-roi-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('yolo-roi-area')).toBeNull();
    const mark = screen.getByTestId('yolo-roi-mark');
    expect(mark).toHaveTextContent('标记 ROI');
    fireEvent.click(mark);
    expect(screen.getByTestId('yolo-roi-mark')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('yolo-mode-roi')).toHaveAttribute('aria-pressed', 'true');

    // 拖完：示意里出现蓝块，按钮改成「重画 ROI」
    const layer = await screen.findByTestId('yolo-draw-layer');
    fireEvent.pointerDown(layer, { clientX: 200, clientY: 150, pointerId: 3 });
    fireEvent.pointerMove(layer, { clientX: 400, clientY: 300, pointerId: 3 });
    fireEvent.pointerUp(layer, { clientX: 400, clientY: 300, pointerId: 3 });
    const area = await screen.findByTestId('yolo-roi-area');
    expect(area.style.left).toBe('25%');
    expect(area.style.top).toBe('25%');
    expect(area.style.width).toBe('25%');
    expect(area.style.height).toBe('25%');
    expect(screen.getByTestId('yolo-roi-mark')).toHaveTextContent('重画 ROI');
  });

  it('新建时保存把 ROI 写进 spec（归一化 [x,y,w,h]）', async () => {
    const create = vi.fn<(deviceId: string, label: string, spec: Record<string, unknown>) => Promise<boolean>>(
      () => Promise.resolve(true),
    );
    useSessionStore.setState({ createYoloRecognizer: create });
    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);
    await screen.findByTestId('yolo-draw-layer');

    // 先标一个示例（保存的前提），再切到 ROI 模式拖搜索区域
    const layer = await screen.findByTestId('yolo-draw-layer');
    fireEvent.pointerDown(layer, { clientX: 40, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 120, clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 120, clientY: 120, pointerId: 1 });
    await drawRoi();

    await waitFor(() => expect(screen.getByTestId('yolo-save')).toBeEnabled());
    fireEvent.click(screen.getByTestId('yolo-save'));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    const spec = create.mock.calls[0]?.[2] as { roi?: number[] } | undefined;
    // 800x600 的画面从 (200,150) 拖到 (400,300) → x/y/w/h 都是 0.25
    expect(spec?.roi?.[0]).toBeCloseTo(0.25);
    expect(spec?.roi?.[1]).toBeCloseTo(0.25);
    expect(spec?.roi?.[2]).toBeCloseTo(0.25);
    expect(spec?.roi?.[3]).toBeCloseTo(0.25);
  });

  it('编辑模式载入已有 ROI，点清除后保存传 null（引擎据此删掉旧区域）', async () => {
    detailMock.mockResolvedValue(detail({ roi: [0.1, 0.2, 0.3, 0.4] }));
    const update = vi.fn<
      (deviceId: string, label: string, spec: Record<string, unknown>, newLabel?: string) => Promise<boolean>
    >(() => Promise.resolve(true));
    useSessionStore.setState({ updateYoloRecognizer: update });
    render(<YoloRecognizerDialog deviceId={DEVICE} open editLabel="ai_9" onClose={() => undefined} />);

    // 识别器原本是全屏搜索：ROI 不再显示为可用区域；先切回默认区域才管理 ROI。
    expect(await screen.findByText(/当前是「全屏」搜索/)).toBeInTheDocument();
    expect(screen.queryByTestId('yolo-roi-clear')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('yolo-roi-use'));
    fireEvent.click(screen.getByTestId('yolo-roi-clear'));
    expect(screen.queryByText(/已设置 ROI/)).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('yolo-save')).toBeEnabled());
    fireEvent.click(screen.getByTestId('yolo-save'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));

    const spec = update.mock.calls[0]?.[2] as { roi?: unknown } | undefined;
    expect(spec?.roi).toBeNull();
  });
});

describe('YoloRecognizerDialog 回放帧率', () => {
  it('切到 12 fps 后时间轴头部同步显示', async () => {
    render(<YoloRecognizerDialog deviceId={DEVICE} open onClose={() => undefined} />);
    const select = await screen.findByTestId('yolo-playback-fps');
    fireEvent.change(select, { target: { value: '12' } });
    expect(select).toHaveValue('12');
    expect(screen.getByTestId('yolo-timeline-fps')).toHaveTextContent('回放 12.0 fps');
  });
});
