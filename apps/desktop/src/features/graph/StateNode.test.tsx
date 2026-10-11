/**
 * 节点卡片的状态样式与就地改名。
 *
 * 用户反馈的原话："鼠标滑动上节点应该有边框高亮才对吧，现在放上去就是一个小手" ——
 * jsdom 里没法真的 hover，所以这里守住两件能守的事：
 *   1. 卡片上带着**悬停/拖拽**要用的类（`hover:border-*`、`[.dragging_&]:*`、`group`），
 *      以及 graph.css 依赖的标记类 —— 谁把类删了样式就静默失效，这条能兜住；
 *   2. 选中（expanded）/当前（active）/pending 三种状态画出来的边框不一样。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

import { StateNode, type StateNodeData } from '@/features/graph/StateNode';
import { useGraphStore } from '@/stores/graph.store';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
// Handle 是 xyflow 的定位组件，这里只关心它有没有跟着卡片一起亮
vi.mock('@xyflow/react', () => ({
  Handle: ({ className }: { className?: string }) => <span data-testid="handle" className={className} />,
  Position: { Left: 'left', Right: 'right' },
}));

function data(patch: Partial<StateNodeData> = {}): StateNodeData {
  return {
    label: '主界面',
    sub: 'main',
    deviceId: 'dev',
    pins: [],
    visits: 3,
    active: false,
    pending: false,
    ...patch,
  };
}

function card(): HTMLElement {
  return screen.getByTestId('state-node');
}

/** StateNode 只用到 data 与 id，其它 NodeProps 字段用不到 */
function nodeProps(patch: Partial<StateNodeData> = {}): ComponentProps<typeof StateNode> {
  return {
    id: 'main',
    data: data(patch),
    type: 'state',
    selected: false,
    dragging: false,
  } as unknown as ComponentProps<typeof StateNode>;
}

describe('节点卡片', () => {
  beforeEach(() => {
    useGraphStore.setState({ graphs: {}, raws: {}, selectedNodeId: null, selectedEdgeId: null });
  });

  it('默认：细描边 + 悬停高亮 + 拖拽高亮（三类 CSS 类都在，样式不会静默失效）', () => {
    render(<StateNode {...nodeProps()} />);

    const classes = card().className;
    expect(classes).toContain('border-line'); // 默认描边
    expect(classes).toContain('hover:border-brand/60'); // 悬停：边框高亮
    expect(classes).toContain('hover:bg-raised'); // 悬停：底色抬一级
    expect(classes).toContain('[.dragging_&]:border-brand'); // 拖拽中
    expect(classes).toContain('group'); // 让圆点跟着亮
    expect(classes).toContain('transition-colors');
  });

  it('圆点跟着卡片一起亮（10px 的点单靠自身 hover 很难点中）', () => {
    render(<StateNode {...nodeProps()} />);

    const handles = screen.getAllByTestId('handle');
    expect(handles).toHaveLength(2); // 左入右出
    for (const handle of handles) {
      expect(handle.className).toContain('group-hover:!bg-brand');
    }
  });

  it('选中（expanded）：描边变 brand + 底色抬到 active，和"当前/待确认"区分得开', () => {
    render(<StateNode {...nodeProps({ expanded: true })} />);

    const classes = card().className;
    expect(classes).toContain('border-brand');
    expect(classes).toContain('bg-active');
  });

  it('当前节点（运行中）实线 brand，pending 目标节点虚线', () => {
    const { unmount } = render(<StateNode {...nodeProps({ active: true })} />);
    expect(card().className).toContain('border-brand');
    unmount();

    render(<StateNode {...nodeProps({ pending: true })} />);
    expect(card().className).toContain('border-dashed');
  });

  it('双击就地改名：Enter 提交给 store', async () => {
    const user = userEvent.setup();
    const updateNode = vi.fn(() => Promise.resolve());
    useGraphStore.setState({ updateNode });
    render(<StateNode {...nodeProps()} />);

    await user.dblClick(card());
    const input = screen.getByDisplayValue('主界面');
    await user.clear(input);
    await user.type(input, '新界面{Enter}');

    expect(updateNode).toHaveBeenCalledWith('dev', 'main', { name: '新界面' });
  });
});
