/**
 * 画面栏下半格「素材区」：缩略图 + 筛选（全部/命中）+ 头部右侧的录制工具 + 行内改名 + 行尾删除 + 整区收起。
 *
 * 为什么单独一个文件：这一格的功能都是"就地操作"（不弹框、不跳页），
 * 分开测能直接渲染组件本身，不用把整块画面（<img> 量测、ResizeObserver、指针坐标）也搭起来。
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefObject } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';

import { MaterialArea } from '@/features/device/ScreenPane';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { RecognizerView } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const DEVICE = 'mock:1';

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

/** 一个未命中、一个稳定、一个待确认（"命中"= 后两个）。 */
const ROWS: readonly RecognizerView[] = [
  recognizer('main_region_1', 'idle', 0),
  recognizer('main_region_2', 'confirmed', 1),
  recognizer('start_btn', 'pending', 0.9),
];

/** 假的 Panel 句柄：只记 expand/collapse 被调过（真尺寸在布局那一层验） */
function fakePanelRef(collapsed = false): {
  ref: RefObject<PanelImperativeHandle | null>;
  calls: string[];
} {
  const calls: string[] = [];
  const handle = {
    collapse: () => calls.push('collapse'),
    expand: () => calls.push('expand'),
    isCollapsed: () => collapsed,
  } as unknown as PanelImperativeHandle;
  return { ref: { current: handle }, calls };
}

type RenameMock = (
  deviceId: string,
  label: string,
  to: string,
) => Promise<{ refs: { nodes: number; edges: number; scores: number } } | null>;
type RemoveMock = (deviceId: string, label: string) => Promise<boolean>;

function setup(
  options: { recognizers?: readonly RecognizerView[]; open?: boolean; collapsed?: boolean } = {},
): {
  rename: ReturnType<typeof vi.fn<RenameMock>>;
  remove: ReturnType<typeof vi.fn<RemoveMock>>;
  calls: string[];
} {
  const rename = vi.fn<RenameMock>(() => Promise.resolve({ refs: { nodes: 0, edges: 0, scores: 0 } }));
  const remove = vi.fn<RemoveMock>(() => Promise.resolve(true));
  useSessionStore.setState({ renameRecognizer: rename, removeRecognizer: remove });
  useUiStore.setState({ materialFilter: 'all', materialOpen: options.open ?? true });

  const { ref, calls } = fakePanelRef(options.collapsed ?? false);
  render(<MaterialArea deviceId={DEVICE} recognizers={options.recognizers ?? ROWS} panelRef={ref} />);
  return { rename, remove, calls };
}

describe('素材区：全部 / 命中', () => {
  beforeEach(() => {
    useUiStore.setState({ materialFilter: 'all', materialOpen: true });
  });

  it('每行可关闭识别，不删除素材或引用', async () => {
    const toggle = vi.fn(() => Promise.resolve(true));
    useSessionStore.setState({ setRecognizerEnabled: toggle });
    setup();
    const button = screen.getByRole('switch', { name: 'main_region_2 参与识别' });
    expect(button).toHaveAttribute('aria-checked', 'true');
    await act(() => { fireEvent.click(button); return Promise.resolve(); });
    expect(toggle).toHaveBeenCalledWith(DEVICE, 'main_region_2', false);
    expect(screen.getAllByTestId('recognizer-name')).toHaveLength(3);
  });

  it('关闭的识别器显示已关闭、不计入命中，并能重新开启', async () => {
    const toggle = vi.fn(() => Promise.resolve(true));
    useSessionStore.setState({ setRecognizerEnabled: toggle });
    setup({ recognizers: [{ ...recognizer('ai_12', 'confirmed', 0.99), enabled: false }] });
    expect(screen.getByText('已关闭')).toBeInTheDocument();
    expect(screen.queryByText('0.99')).not.toBeInTheDocument();
    expect(screen.getByTestId('material-filter-hit')).toHaveTextContent('命中 0');
    const button = screen.getByRole('switch', { name: 'ai_12 参与识别' });
    expect(button).toHaveAttribute('aria-checked', 'false');
    await act(() => { fireEvent.click(button); return Promise.resolve(); });
    expect(toggle).toHaveBeenCalledWith(DEVICE, 'ai_12', true);
  });

  it('请求期间禁止重复切换，失败后保留原状态并恢复按钮', async () => {
    let finish!: (result: boolean) => void;
    const toggle = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    useSessionStore.setState({ setRecognizerEnabled: toggle });
    setup();
    const button = screen.getByRole('switch', { name: 'main_region_1 参与识别' });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(toggle).toHaveBeenCalledTimes(1);
    await act(() => { finish(false); return Promise.resolve(); });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-checked', 'true');
  });

  it('默认显示全部，两个按钮都带计数，三态照旧', () => {
    setup();

    expect(screen.getAllByTestId('recognizer-name').map((node) => node.textContent)).toEqual([
      'main_region_1',
      'main_region_2',
      'start_btn',
    ]);
    expect(screen.getByText('未命中')).toBeInTheDocument();
    expect(screen.getByText('待确认')).toBeInTheDocument();
    expect(screen.getByText('稳定')).toBeInTheDocument();
    expect(screen.getByTestId('material-filter-all')).toHaveTextContent('全部 3');
    expect(screen.getByTestId('material-filter-hit')).toHaveTextContent('命中 2');
    expect(screen.queryByText('查看设备')).toBeNull();
  });

  it('切到「命中」只剩命中的两行，切回「全部」全回来（选择记在 store）', () => {
    setup();

    fireEvent.click(screen.getByTestId('material-filter-hit'));
    expect(screen.getAllByTestId('recognizer-name').map((node) => node.textContent)).toEqual([
      'main_region_2',
      'start_btn',
    ]);
    expect(useUiStore.getState().materialFilter).toBe('hit');

    fireEvent.click(screen.getByTestId('material-filter-all'));
    expect(screen.getAllByTestId('recognizer-name')).toHaveLength(3);
  });

  it('「命中」下一个都没命中：给出空态并指回去哪儿看', () => {
    setup({ recognizers: [recognizer('only_idle', 'idle', 0)] });

    fireEvent.click(screen.getByTestId('material-filter-hit'));

    expect(screen.queryByTestId('recognizer-name')).toBeNull();
    expect(screen.getByText(/这一帧没有命中的素材/)).toHaveTextContent('全部 1');
  });
});

describe('素材区：独立分类折叠', () => {
  it('AI、模板、文字分开，各分区可以独立收起并保留其他分类', () => {
    setup({
      recognizers: [
        { ...recognizer('ai_enemy', 'idle', 0), type: 'yolo', examplesCount: 0, classes: ['敌人'] },
        recognizer('image_btn', 'confirmed', 1),
        { ...recognizer('color_area', 'idle', 0), type: 'color' },
        { ...recognizer('text_start', 'pending', 0.9), type: 'ocr', text: '开始' },
      ],
    });
    const ai = screen.getByTestId('material-group-ai');
    const template = screen.getByTestId('material-group-template');
    const text = screen.getByTestId('material-group-text');
    expect(within(ai).getByText('ai_enemy')).toBeInTheDocument();
    expect(within(template).getByText('image_btn')).toBeInTheDocument();
    expect(within(template).getByText('color_area')).toBeInTheDocument();
    expect(within(template).queryByText('text_start')).not.toBeInTheDocument();
    expect(within(text).getByText('text_start')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('material-group-toggle-ai'));
    expect(screen.getByTestId('material-group-toggle-ai')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('ai_enemy')).not.toBeInTheDocument();
    expect(screen.getByText('image_btn')).toBeInTheDocument();
    expect(screen.getByText('text_start')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('material-group-toggle-template'));
    expect(screen.queryByText('image_btn')).not.toBeInTheDocument();
    expect(screen.getByText('text_start')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('material-group-toggle-ai'));
    expect(screen.getByText('ai_enemy')).toBeInTheDocument();
  });

  it('没有素材也保留三类入口和总空态', () => {
    setup({ recognizers: [] });
    for (const id of ['ai', 'template', 'text']) {
      expect(screen.getByTestId(`material-group-toggle-${id}`)).toHaveAttribute('aria-expanded', 'true');
    }
    expect(screen.getByText(/还没有素材/)).toBeInTheDocument();
  });
});

describe('素材区：搜索', () => {
  beforeEach(() => {
    useUiStore.setState({ materialFilter: 'all', materialOpen: true });
  });

  it('标题行有搜索框；拆词 / 拼音能找到相近的素材', () => {
    setup({
      recognizers: [
        recognizer('邀请好友', 'idle', 0),
        recognizer('逢魔之时', 'confirmed', 1),
        recognizer('start_btn', 'pending', 0.9),
      ],
    });

    const input = screen.getByTestId('material-search');
    expect(input).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'start' } });
    expect(screen.getAllByTestId('recognizer-name').map((node) => node.textContent)).toEqual(['start_btn']);

    fireEvent.change(input, { target: { value: 'yaoqing' } });
    expect(screen.getAllByTestId('recognizer-name').map((node) => node.textContent)).toEqual(['邀请好友']);

    fireEvent.change(input, { target: { value: 'zzzz' } });
    expect(screen.queryByTestId('recognizer-name')).toBeNull();
    expect(screen.getByText(/没有与「zzzz」相近的素材/)).toBeInTheDocument();
  });

  it('点清除或 Esc 会清空搜索、列表回来', () => {
    setup();

    const input = screen.getByTestId('material-search');
    fireEvent.change(input, { target: { value: 'start' } });
    expect(screen.getAllByTestId('recognizer-name')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('material-search-clear'));
    expect(screen.getAllByTestId('recognizer-name')).toHaveLength(3);

    fireEvent.change(input, { target: { value: 'start' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getAllByTestId('recognizer-name')).toHaveLength(3);
  });

  it('收起时不占标题行：搜索框卸掉', () => {
    setup({ open: false });
    expect(screen.queryByTestId('material-search')).toBeNull();
    expect(screen.queryByTestId('recognizer-name')).toBeNull();
  });
});

describe('素材区：头部右侧的录制工具', () => {
  beforeEach(() => {
    useUiStore.setState({ materialFilter: 'all', materialOpen: true });
  });

  /** 标题行 = 「素材区」开关那一行的父节点 */
  function headerRow(): HTMLElement {
    return screen.getByTestId('material-toggle').parentElement as HTMLElement;
  }

  it('四个录制工具（框选 / 点选 / 文字识别 / 录操作）都在标题行里，且排在最右侧', () => {
    setup();

    const tools = within(headerRow()).getByRole('group', { name: '录制工具' });
    expect(tools).toBeInTheDocument();
    for (const label of ['框选录制', '点选录制', '文字识别', '录操作']) {
      expect(within(tools).getByRole('button', { name: label })).toBeInTheDocument();
    }
    // 右侧：这一行里它后面没有别的兄弟节点（搜索框是 flex-1，把它顶到最右）
    expect(headerRow().lastElementChild).toBe(tools);
  });

  it('「文字识别」点了走 OCR 框选入口（没有工作流时给出提示，不是点了没反应）', () => {
    setup();

    const button = screen.getByRole('button', { name: '文字识别' });
    useSessionStore.setState({ error: null, currentWorkflow: null });
    fireEvent.click(button);
    expect(useSessionStore.getState().error).toContain('还没有工作流');
  });

  it('收起素材区后录制工具还在（它们跟着画面走，不跟着列表收）', () => {
    setup({ open: false });
    expect(screen.queryByTestId('material-search')).toBeNull();
    expect(within(headerRow()).getByRole('group', { name: '录制工具' })).toBeInTheDocument();
  });
});

describe('素材区：行内改名', () => {
  beforeEach(() => {
    useUiStore.setState({ materialFilter: 'all', materialOpen: true });
  });

  it('双击名字 → 输入框 → 回车提交', () => {
    const { rename } = setup();

    fireEvent.doubleClick(screen.getByText('main_region_1'));
    const input = screen.getByTestId('recognizer-name-input');
    expect(input).toHaveValue('main_region_1');

    fireEvent.change(input, { target: { value: '开始按钮' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // 只提交一次（输入框卸载时浏览器会补一个 blur，必须挡住）
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith(DEVICE, 'main_region_1', '开始按钮');
    expect(screen.queryByTestId('recognizer-name-input')).toBeNull();
  });

  it('Esc 取消：一个字节都不改', () => {
    const { rename } = setup();

    fireEvent.doubleClick(screen.getByText('main_region_1'));
    const input = screen.getByTestId('recognizer-name-input');
    fireEvent.change(input, { target: { value: '不要这个名字' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(rename).not.toHaveBeenCalled();
    expect(screen.queryByTestId('recognizer-name-input')).toBeNull();
    expect(screen.getByText('main_region_1')).toBeInTheDocument();
  });

  it('重名：拦在本地、原因留在行里，改对了能接着提交', () => {
    const { rename } = setup();

    fireEvent.doubleClick(screen.getByText('main_region_1'));
    const input = screen.getByTestId('recognizer-name-input');
    fireEvent.change(input, { target: { value: 'start_btn' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(rename).not.toHaveBeenCalled();
    expect(screen.getByTestId('recognizer-name-input')).toHaveValue('start_btn');
    expect(screen.getByTestId('recognizer-name-input')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('已经有同名识别器：start_btn')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('recognizer-name-input'), { target: { value: '开始按钮' } });
    fireEvent.keyDown(screen.getByTestId('recognizer-name-input'), { key: 'Enter' });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith(DEVICE, 'main_region_1', '开始按钮');
  });

  it('非法字符（会变成模板文件名）：说明原因，Esc 能退出', () => {
    const { rename } = setup();

    fireEvent.doubleClick(screen.getByText('main_region_1'));
    const input = screen.getByTestId('recognizer-name-input');
    fireEvent.change(input, { target: { value: 'bad/name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(rename).not.toHaveBeenCalled();
    expect(screen.getByText(/不能带 \/ 或/)).toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId('recognizer-name-input'), { key: 'Escape' });
    expect(screen.queryByTestId('recognizer-name-input')).toBeNull();
    expect(screen.getByText('main_region_1')).toBeInTheDocument();
  });

  it('改成自己（只多了空白）：不发请求，直接收起输入框', () => {
    const { rename } = setup();

    fireEvent.doubleClick(screen.getByText('main_region_1'));
    const input = screen.getByTestId('recognizer-name-input');
    fireEvent.change(input, { target: { value: '  main_region_1  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(rename).not.toHaveBeenCalled();
    expect(screen.queryByTestId('recognizer-name-input')).toBeNull();
  });
});

describe('素材区：行尾删除', () => {
  beforeEach(() => {
    useUiStore.setState({ materialFilter: 'all', materialOpen: true });
  });

  it('每一行都有删除按钮；点一下真的调 removeRecognizer', () => {
    const { remove } = setup();

    const buttons = screen.getAllByTestId('recognizer-remove');
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toHaveAttribute('aria-label', '删除 main_region_1');
    expect(buttons[0]!.querySelector('svg')).not.toBeNull();
    expect(screen.queryByText('删')).toBeNull();
    fireEvent.click(buttons[0]!);
    expect(remove).toHaveBeenCalledWith(DEVICE, 'main_region_1');
  });
  it('素材区不展示阈值滑块（阈值改到模块「图像配置」中设置）', () => {
    setup();
    expect(screen.queryByText('阈值')).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('引用情况收敛为行内标记（引用计数），悬浮时展示完整「正在被引用：…」说明', () => {
    useGraphStore.setState({
      graphs: {
        [DEVICE]: {
          deviceId: DEVICE,
          nodes: [],
          edges: [],
          recognizers: ROWS,
          variables: [],
          activeNodeId: null,
          pendingNodeId: null,
          flow: {
            steps: [
              { id: 's_1', type: 'click', params: { rec: 'main_region_1' } },
              { id: 's_2', type: 'click', params: { rec: 'main_region_1' } },
            ],
          },
        },
      },
    });
    setup();

    const badges = screen.getAllByTestId('recognizer-usage-badge');
    expect(badges).toHaveLength(3);
    // 第 1 行被 2 个步骤引用：标记显示数量 2，title / 悬浮提示包含完整引用列表
    expect(badges[0]).toHaveAttribute(
      'title',
      expect.stringContaining(
        '正在被引用：模块 · 点击 · main_region_1（s_1）、模块 · 点击 · main_region_1（s_2）',
      ),
    );
    // 点击标记直接跳转到第 1 个引用模块；再点一次轮询跳到第 2 个引用模块
    fireEvent.click(badges[0]!);
    expect(useGraphStore.getState().selectedNodeId).toBe('s_1');
    expect(useGraphStore.getState().focusNodeRequest?.nodeId).toBe('s_1');

    fireEvent.click(badges[0]!);
    expect(useGraphStore.getState().selectedNodeId).toBe('s_2');
    expect(useGraphStore.getState().focusNodeRequest?.nodeId).toBe('s_2');

    // 浮层里的单条引用也可以直接点选跳转
    const targetButtons = screen.getAllByTestId('recognizer-usage-target');
    fireEvent.click(targetButtons[0]!);
    expect(useGraphStore.getState().selectedNodeId).toBe('s_1');

    // 第 2 行未被引用：标记显示 0
    expect(badges[1]).toHaveAttribute('title', expect.stringContaining('还没有被引用'));
  });
});

describe('素材区：收起 / 展开', () => {
  beforeEach(() => {
    useUiStore.setState({ materialFilter: 'all', materialOpen: true });
  });

  it('点标题收起：store 记下来，面板跟着 collapse；再点一次展开', () => {
    const { calls } = setup();

    fireEvent.click(screen.getByTestId('material-toggle'));

    expect(useUiStore.getState().materialOpen).toBe(false);
    expect(calls).toContain('collapse');
    // 收起时列表让位，标题行留下"命中几个"作为唯一可见的数字
    expect(screen.queryByTestId('material-filter-all')).toBeNull();
    expect(screen.queryByTestId('recognizer-name')).toBeNull();
    expect(screen.getByTestId('material-hit-summary')).toHaveTextContent('命中 2');

    fireEvent.click(screen.getByTestId('material-toggle'));

    expect(useUiStore.getState().materialOpen).toBe(true);
    expect(calls).toContain('expand');
    expect(screen.getByTestId('material-filter-all')).toHaveTextContent('全部 3');
  });

  it('store 就是"收起"时，挂载即 collapse（不用等用户点）', () => {
    const { calls } = setup({ open: false });

    expect(calls).toEqual(['collapse']);
    expect(screen.getByTestId('material-toggle')).toHaveAttribute('aria-expanded', 'false');
  });
});
