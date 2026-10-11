/**
 * 画面栏下半格「识别读数」：筛选（全部/命中）、行内改名、行尾删除、整区收起。
 *
 * 为什么单独一个文件：这一格的功能都是"就地操作"（不弹框、不跳页），
 * 分开测能直接渲染组件本身，不用把整块画面（<img> 量测、ResizeObserver、指针坐标）也搭起来。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefObject } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';

import { RecognizerReadout } from '@/features/device/ScreenPane';
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
  useUiStore.setState({ readoutFilter: 'all', readoutOpen: options.open ?? true });

  const { ref, calls } = fakePanelRef(options.collapsed ?? false);
  render(
    <RecognizerReadout
      deviceId={DEVICE}
      recognizers={options.recognizers ?? ROWS}
      panelRef={ref}
      onConnect={() => undefined}
    />,
  );
  return { rename, remove, calls };
}

describe('识别读数：全部 / 命中', () => {
  beforeEach(() => {
    useUiStore.setState({ readoutFilter: 'all', readoutOpen: true });
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
    expect(screen.getByTestId('readout-filter-all')).toHaveTextContent('全部 3');
    expect(screen.getByTestId('readout-filter-hit')).toHaveTextContent('命中 2');
  });

  it('切到「命中」只剩命中的两行，切回「全部」全回来（选择记在 store）', () => {
    setup();

    fireEvent.click(screen.getByTestId('readout-filter-hit'));
    expect(screen.getAllByTestId('recognizer-name').map((node) => node.textContent)).toEqual([
      'main_region_2',
      'start_btn',
    ]);
    expect(useUiStore.getState().readoutFilter).toBe('hit');

    fireEvent.click(screen.getByTestId('readout-filter-all'));
    expect(screen.getAllByTestId('recognizer-name')).toHaveLength(3);
  });

  it('「命中」下一个都没命中：给出空态并指回去哪儿看', () => {
    setup({ recognizers: [recognizer('only_idle', 'idle', 0)] });

    fireEvent.click(screen.getByTestId('readout-filter-hit'));

    expect(screen.queryByTestId('recognizer-name')).toBeNull();
    expect(screen.getByText(/这一帧没有命中的识别器/)).toHaveTextContent('全部 1');
  });
});

describe('识别读数：行内改名', () => {
  beforeEach(() => {
    useUiStore.setState({ readoutFilter: 'all', readoutOpen: true });
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

describe('识别读数：删除', () => {
  beforeEach(() => {
    useUiStore.setState({ readoutFilter: 'all', readoutOpen: true });
  });

  it('每行一个删除按钮，点它删的是这一行（设备 + 标签）', () => {
    const { remove } = setup();

    const buttons = screen.getAllByTestId('recognizer-remove');
    expect(buttons).toHaveLength(3);
    const second = buttons[1];
    expect(second).toBeDefined();
    expect(second).toHaveAccessibleName('删除 main_region_2');

    fireEvent.click(second as HTMLElement);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(DEVICE, 'main_region_2');
  });

  it('删除按钮带说明（模板文件一起删 / 被引用时会告诉你被谁用了）', () => {
    setup();

    const first = screen.getAllByTestId('recognizer-remove')[0];
    expect(first).toBeDefined();
    expect(first).toHaveAttribute('title', expect.stringContaining('被节点/边引用时会告诉你被谁用了'));
  });

  it('正在改名的那一行点删除：先收起输入框，不会把改名也一起提交', () => {
    const { rename, remove } = setup();

    fireEvent.doubleClick(screen.getByText('main_region_1'));
    fireEvent.change(screen.getByTestId('recognizer-name-input'), { target: { value: '半截名字' } });
    const first = screen.getAllByTestId('recognizer-remove')[0];
    expect(first).toBeDefined();
    fireEvent.click(first as HTMLElement);

    expect(remove).toHaveBeenCalledWith(DEVICE, 'main_region_1');
    expect(rename).not.toHaveBeenCalled();
    expect(screen.queryByTestId('recognizer-name-input')).toBeNull();
  });
});

describe('识别读数：收起 / 展开', () => {
  beforeEach(() => {
    useUiStore.setState({ readoutFilter: 'all', readoutOpen: true });
  });

  it('点标题收起：store 记下来，面板跟着 collapse；再点一次展开', () => {
    const { calls } = setup();

    fireEvent.click(screen.getByTestId('readout-toggle'));

    expect(useUiStore.getState().readoutOpen).toBe(false);
    expect(calls).toContain('collapse');
    // 收起时列表让位，标题行留下"命中几个"作为唯一读数
    expect(screen.queryByTestId('readout-filter-all')).toBeNull();
    expect(screen.getByTestId('readout-hit-summary')).toHaveTextContent('命中 2');

    fireEvent.click(screen.getByTestId('readout-toggle'));

    expect(useUiStore.getState().readoutOpen).toBe(true);
    expect(calls).toContain('expand');
    expect(screen.getByTestId('readout-filter-all')).toHaveTextContent('全部 3');
  });

  it('store 就是"收起"时，挂载即 collapse（不用等用户点）', () => {
    const { calls } = setup({ open: false });

    expect(calls).toEqual(['collapse']);
    expect(screen.getByTestId('readout-toggle')).toHaveAttribute('aria-expanded', 'false');
  });
});
