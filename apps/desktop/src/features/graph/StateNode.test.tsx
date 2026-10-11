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
import { useUiStore } from '@/stores/ui.store';
import { clearTemplateCache, preloadTemplates } from '@/stores/template.store';

const runAction = vi.fn((_deviceId: string, _action: Record<string, unknown>) =>
  Promise.resolve({ ok: true, described: '点击 (0.5, 0.5)' }),
);
vi.mock('@/lib/rpc', () => ({
  templateImage: (label: string) => Promise.resolve({ label, png: 'data:image/png;base64,AAAA' }),
  actionRun: (deviceId: string, action: Record<string, unknown>) => runAction(deviceId, action),
  devLog: vi.fn(),
}));

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
    enterTemplates: [],
    allTemplates: [],
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
    useUiStore.setState({ nodeScale: 'md' });
    runAction.mockClear();
    clearTemplateCache();
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

  it('画布上带模板截图：进入识别器的缩略图 + 操作引脚上的截图', async () => {
    clearTemplateCache();
    preloadTemplates(['main_start', 'shop_home']);
    useGraphStore.setState({
      graphs: {
        dev: {
          deviceId: 'dev',
          nodes: [{ id: 'main', name: '主界面', enter: ['main_start'], x: 0, y: 0, visits: 1 }],
          edges: [],
          variables: [],
          recognizers: [],
          activeNodeId: null,
          pendingNodeId: null,
        },
      },
      raws: {},
      selectedNodeId: null,
      selectedEdgeId: null,
    });

    render(
      <StateNode
        {...nodeProps({
          expanded: true,
          enterTemplates: ['main_start'],
          allTemplates: ['main_start', 'shop_home'],
          pins: [
            {
              key: 'e1',
              title: '点击 shop_home',
              action: { type: 'click', target: 'shop_home' },
              template: 'shop_home',
              pins: [],
            },
          ],
        })}
      />,
    );

    // 进入识别器的小图 + 引脚上的小图（画布上"这一步点的是哪个图标"）
    await vi.waitFor(() => {
      expect(screen.getAllByAltText(/main_start|shop_home/).length).toBeGreaterThanOrEqual(2);
    });
  });

  it('选中的节点可以就地挂/摘「进入识别器」，也能加一步操作', async () => {
    const user = userEvent.setup();
    const updateNode = vi.fn(() => Promise.resolve());
    const addStep = vi.fn(() => Promise.resolve('e_new'));
    useGraphStore.setState({
      updateNode,
      addStep,
      graphs: {
        dev: {
          deviceId: 'dev',
          nodes: [{ id: 'main', name: '主界面', enter: ['main_start'], x: 0, y: 0, visits: 1 }],
          edges: [],
          variables: [],
          recognizers: [],
          activeNodeId: null,
          pendingNodeId: null,
        },
      },
      raws: {},
    });

    render(<StateNode {...nodeProps({ expanded: true, allTemplates: ['main_start', 'shop_home'] })} />);

    // 挂上 shop_home
    await user.click(screen.getByText('shop_home'));
    expect(updateNode).toHaveBeenCalledWith('dev', 'main', { enter: ['main_start', 'shop_home'] });

    // 摘掉 main_start
    await user.click(screen.getByText('main_start'));
    expect(updateNode).toHaveBeenLastCalledWith('dev', 'main', { enter: [] });

    // "＋操作"现在是菜单（选动作类型 / 绑定模板），建步骤走 addStep
    await user.click(screen.getByText('＋操作'));
    expect(screen.getByText('＋ 点击')).toBeInTheDocument();
    await user.click(screen.getByText('＋ 等待'));
    expect(addStep).toHaveBeenCalledWith('dev', 'main', 'main', { action: { type: 'wait' } });
  });

  it('节点内部的按钮/引脚点一下不会冒泡出去（否则外层会当成"点了节点"而收起）', async () => {
    const user = userEvent.setup();
    useGraphStore.setState({
      graphs: {
        dev: {
          deviceId: 'dev',
          nodes: [{ id: 'main', name: '主界面', enter: ['main_start'], x: 0, y: 0, visits: 1 }],
          edges: [],
          variables: [],
          recognizers: [],
          activeNodeId: null,
          pendingNodeId: null,
        },
      },
      raws: {},
    });

    const outer = vi.fn();
    render(
      <div onClick={outer}>
        <StateNode
          {...nodeProps({
            expanded: true,
            allTemplates: ['main_start', 'shop_home'],
            pins: [
              {
                key: 'e1',
                title: '点击',
                action: { type: 'click', target: 'shop_home' },
                pins: [{ label: 'x', value: '0.5', isVar: false }],
              },
            ],
          })}
        />
      </div>,
    );

    // 挂/摘识别器、加操作、引脚：都是节点内部的操作，不能冒泡（外层收起卡片）
    await user.click(screen.getByText('shop_home'));
    await user.click(screen.getByText('＋操作'));
    await user.click(screen.getByText('x:0.5'));

    // 核心：没有一次冒泡上去（"各自干了各自的活"在另一条用例里验证）
    expect(outer).not.toHaveBeenCalled();
  });

  it('点节点里的"操作"是选中那一步，不会收起节点（选中边不再清节点选中）', async () => {
    const user = userEvent.setup();
    const selectEdge = vi.fn();
    useGraphStore.setState({
      selectEdge,
      graphs: {
        dev: {
          deviceId: 'dev',
          nodes: [{ id: 'main', name: '主界面', enter: [], x: 0, y: 0, visits: 1 }],
          edges: [],
          variables: [],
          recognizers: [],
          activeNodeId: null,
          pendingNodeId: null,
        },
      },
      raws: {},
      selectedNodeId: 'main',
      selectedEdgeId: null,
    });

    const outer = vi.fn();
    render(
      <div onClick={outer}>
        <StateNode
          {...nodeProps({
            expanded: true,
            pins: [{ key: 'e1', title: '点击 商店', action: { type: 'click', target: 'x' }, pins: [] }],
          })}
        />
      </div>,
    );

    await user.click(screen.getByText('点击 商店'));

    expect(selectEdge).toHaveBeenCalledWith('e1');
    expect(outer).not.toHaveBeenCalled(); // 不冒泡 → 不会被当成"点了节点"
    // 节点仍然是选中的（引脚继续摊开，用户可以接着点下一步）
    expect(useGraphStore.getState().selectedNodeId).toBe('main');
  });

  it('节点大小档位：小/中/大 改变卡片宽度', () => {
    useGraphStore.setState({ graphs: {}, raws: {} });
    const { unmount } = render(<StateNode {...nodeProps()} />);
    expect(screen.getByTestId('state-node').className).toContain('w-[168px]'); // 默认中
    unmount();

    useUiStore.setState({ nodeScale: 'lg' });
    render(<StateNode {...nodeProps()} />);
    expect(screen.getByTestId('state-node').className).toContain('w-[220px]');
  });

  it('＋操作菜单：挑动作类型建一步；挑模板则把目标与条件一起绑上', async () => {
    const user = userEvent.setup();
    const addStep = vi.fn(() => Promise.resolve('e_new'));
    const selectEdge = vi.fn();
    useGraphStore.setState({ addStep, selectEdge, selectedNodeId: 'main', selectedEdgeId: null });

    render(<StateNode {...nodeProps({ expanded: true, allTemplates: ['main_start'], pins: [] })} />);

    await user.click(screen.getByText('＋操作'));
    // ① 动作类型：只建类型，参数留给下方详情
    await user.click(screen.getByText('＋ 点击'));
    expect(addStep).toHaveBeenCalledWith('dev', 'main', 'main', { action: { type: 'click' } });

    // ② 模板：目标 + 条件一起绑（"菜单里就能绑定对应的事件"）
    await user.click(screen.getByText('＋操作'));
    await user.click(screen.getByText('点击「main_start」'));
    expect(addStep).toHaveBeenLastCalledWith('dev', 'main', 'main', {
      action: { type: 'click', target: 'main_start' },
      when: 'main_start',
      condition: { all_of: ['main_start'] },
    });
    expect(selectEdge).toHaveBeenCalledWith('e_new');
  });

  it('每一步操作都能 ✕ 删除、▶ 直接执行（执行结果记进事件流）', async () => {
    const user = userEvent.setup();
    const removeEdge = vi.fn(() => Promise.resolve());
    useGraphStore.setState({ removeEdge, selectedNodeId: 'main' });

    render(
      <StateNode
        {...nodeProps({
          expanded: true,
          pins: [{ key: 'e1', title: '点击 商店', action: { type: 'click', target: 'x' }, pins: [] }],
        })}
      />,
    );

    await user.click(screen.getByTitle('删除这一步操作'));
    expect(removeEdge).toHaveBeenCalledWith('dev', 'e1');

    await user.click(screen.getByTitle(/立即执行这一步/));
    // toActionPayload 会补默认参数（比如 click 的 duration_ms），这里只校验关键字段
    await vi.waitFor(() =>
      expect(runAction).toHaveBeenCalledWith('dev', expect.objectContaining({ type: 'click', target: 'x' })),
    );
  });
});
