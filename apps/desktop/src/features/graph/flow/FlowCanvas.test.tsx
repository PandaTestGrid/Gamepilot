import { ReactFlowProvider } from '@xyflow/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FlowCanvas } from '@/features/graph/flow/FlowCanvas';
import { FlowModulePointerDragProvider } from '@/features/graph/flow/flow-module-pointer-drag';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import type { GraphData } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

function graphOf(
  steps: GraphData['flow'] extends infer F ? (F extends { steps: infer S } ? S : never) : never,
): GraphData {
  return {
    deviceId: '__script__',
    nodes: [],
    edges: [],
    recognizers: [],
    variables: [],
    activeNodeId: null,
    pendingNodeId: null,
    flow: { steps },
  };
}

describe('FlowCanvas 渲染冒烟', () => {
  it('条件嵌套 + 未接入模块 + 脏参数都能渲染，不崩', () => {
    const graph = graphOf([
      { id: 't', type: 'manual', params: {} },
      { id: 'c', type: 'cond', params: { rec: 'x' } },
      { id: 'y', type: 'delay', params: { ms: 1 } },
      { id: 'e', type: 'else', params: {} },
      { id: 'n', type: 'key', params: { value: 'back' } },
      { id: 'ce', type: 'condend', params: { back: 'c' } },
      { id: 'p', type: 'delay', params: { ms: 5, _pendingLink: true } },
      { id: 'bad1', type: 'delay' },
      { id: 'bad2', type: 'no-such-type', params: null } as never,
      { id: 'orphan', type: 'condend', params: { back: 'nope' } },
    ]);
    render(
      <ReactFlowProvider>
        <FlowModulePointerDragProvider>
          <FlowCanvas graph={graph} />
        </FlowModulePointerDragProvider>
      </ReactFlowProvider>,
    );
    expect(screen.getByTestId('flow-canvas')).toBeInTheDocument();
    expect(document.querySelectorAll('.react-flow__node').length).toBeGreaterThanOrEqual(6);
    // 错误边界没有被触发
    expect(screen.queryByText(/画布渲染出错/)).toBeNull();
  });

  it('赋值模块在节点上就有配置项（变量名 / 值），不用去底部详情栏', () => {
    render(
      <ReactFlowProvider>
        <FlowModulePointerDragProvider>
          <FlowCanvas
            graph={graphOf([
              { id: 't', type: 'manual', params: {} },
              { id: 'v', type: 'setvar', params: { name: '次数', value: '0' } },
            ])}
          />
        </FlowModulePointerDragProvider>
      </ReactFlowProvider>,
    );
    const card = document.querySelector('[data-flow-step-id="v"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector('[data-testid="setvar-name"]')).not.toBeNull();
    expect(card?.querySelector('[data-testid="setvar-value"]')).not.toBeNull();
    // 标题也带上「变量 = 值」，收起时也看得出这个模块在做什么
    expect(card?.textContent).toContain('次数 = 0');
  });

  it('「跳出循环」节点上没有执行按钮（没有出口，单跑没意义），删除按钮仍在', () => {
    render(
      <ReactFlowProvider>
        <FlowModulePointerDragProvider>
          <FlowCanvas
            graph={graphOf([
              { id: 't', type: 'manual', params: {} },
              { id: 'lp', type: 'loop', params: { count: 2 } },
              { id: 'brk', type: 'loopbreak', params: {} },
              { id: 'le', type: 'loopend', params: { back: 'lp' } },
            ])}
          />
        </FlowModulePointerDragProvider>
      </ReactFlowProvider>,
    );
    const brk = document.querySelector('[data-flow-step-id="brk"]');
    expect(brk).not.toBeNull();
    expect(brk?.querySelector('[data-testid="flow-step-run"]')).toBeNull();
    expect(brk?.querySelector('[aria-label^="删除模块"]')).not.toBeNull();
    // 普通模块仍有执行按钮
    const trigger = document.querySelector('[data-flow-step-id="t"]');
    expect(trigger?.querySelector('[data-testid="flow-step-run"]')).not.toBeNull();
  });

  it('空链也能渲染', () => {
    render(
      <ReactFlowProvider>
        <FlowModulePointerDragProvider>
          <FlowCanvas graph={graphOf([])} />
        </FlowModulePointerDragProvider>
      </ReactFlowProvider>,
    );
    expect(screen.getByTestId('flow-canvas')).toBeInTheDocument();
  });

  it('每个节点都有单节点运行按钮，点击后从该模块开始运行', async () => {
    const startRun = vi.fn().mockResolvedValue(undefined);
    useDeviceStore.setState({
      devices: [
        {
          id: 'dev-1',
          name: '测试机',
          kind: 'android',
          uri: 'Android://127.0.0.1:5037/dev-1',
          resolution: [1080, 1920],
          fps: 20,
          status: 'connected',
        },
      ],
      activeId: 'dev-1',
    });
    useSessionStore.setState({
      startRun,
      running: {},
      runningWorkflowRoots: {},
      currentWorkflow: {
        root: '/p/甲/斗技',
        graphPath: '/p/甲/斗技/graph.json',
        nodes: 0,
        edges: 0,
        recognizers: 0,
        templates: 0,
      },
    });

    const graph = graphOf([
      { id: 's_trigger', type: 'manual', params: {} },
      { id: 's_click', type: 'click', params: { x: 0.5, y: 0.5 } },
    ]);

    render(
      <ReactFlowProvider>
        <FlowModulePointerDragProvider>
          <FlowCanvas graph={graph} />
        </FlowModulePointerDragProvider>
      </ReactFlowProvider>,
    );

    const runButtons = screen.getAllByTestId('flow-step-run');
    expect(runButtons.length).toBe(2);

    const clickNodeRunBtn = runButtons[1]!;
    expect(clickNodeRunBtn).not.toBeDisabled();
    fireEvent.click(clickNodeRunBtn);

    await waitFor(() => {
      expect(startRun).toHaveBeenCalledWith('dev-1', 's_click');
    });

    const stopRun = vi.fn().mockResolvedValue(undefined);
    act(() => {
      useSessionStore.setState({
        stopRun,
        running: { 'dev-1': true },
        runningStartStep: { 'dev-1': 's_click' },
        runningWorkflowRoots: { 'dev-1': ['/p/甲/斗技'] },
      });
    });
    // 只有触发器和当前执行的模块（s_click）变成停止状态，其它未执行模块不会全部变成停止
    expect(clickNodeRunBtn).toHaveAttribute('title', '停止运行');
    fireEvent.click(clickNodeRunBtn);

    await waitFor(() => {
      expect(stopRun).toHaveBeenCalledWith('dev-1');
    });
  });

  it('执行中的循环节点头部显示 2 / 12', () => {
    useDeviceStore.setState({
      devices: [
        {
          id: 'dev-1',
          name: '测试机',
          kind: 'android',
          uri: 'Android://127.0.0.1:5037/dev-1',
          resolution: [1080, 1920],
          fps: 20,
          status: 'connected',
        },
      ],
      activeId: 'dev-1',
    });
    useSessionStore.setState({
      running: { 'dev-1': true },
      runningWorkflowRoots: { 'dev-1': ['/p/甲/斗技'] },
      currentWorkflow: {
        root: '/p/甲/斗技',
        graphPath: '/p/甲/斗技/graph.json',
        nodes: 0,
        edges: 0,
        recognizers: 0,
        templates: 0,
      },
      loopProgress: { 'dev-1': { lp: { current: 2, total: 12 } } },
    });

    const graph = graphOf([
      { id: 't', type: 'manual', params: {} },
      { id: 'lp', type: 'loop', params: { count: 12 } },
      { id: 'tap', type: 'click', params: { x: 0.5, y: 0.5 } },
      { id: 'le', type: 'loopend', params: { back: 'lp' } },
    ]);

    render(
      <ReactFlowProvider>
        <FlowModulePointerDragProvider>
          <FlowCanvas graph={graph} />
        </FlowModulePointerDragProvider>
      </ReactFlowProvider>,
    );

    expect(screen.getByTestId('flow-loop-progress')).toHaveTextContent('循环 · 2 / 12');
  });

  it('运行中 Ctrl+Z 不走撤销', () => {
    const undoFlow = vi.fn(() => Promise.resolve(true));
    useGraphStore.setState({ undoFlow });
    useDeviceStore.setState({
      devices: [
        {
          id: 'dev-1',
          name: '测试机',
          kind: 'android',
          uri: 'Android://127.0.0.1:5037/dev-1',
          resolution: [1080, 1920],
          fps: 20,
          status: 'connected',
        },
      ],
      activeId: 'dev-1',
    });
    useSessionStore.setState({
      currentWorkflow: {
        root: '/p/甲/斗技',
        graphPath: '/p/甲/斗技/graph.json',
        nodes: 0,
        edges: 0,
        recognizers: 0,
        templates: 0,
      },
      running: { 'dev-1': true },
      runningWorkflowRoots: { 'dev-1': ['/p/甲/斗技'] },
    });

    render(
      <ReactFlowProvider>
        <FlowModulePointerDragProvider>
          <FlowCanvas graph={graphOf([{ id: 't', type: 'manual', params: {} }])} />
        </FlowModulePointerDragProvider>
      </ReactFlowProvider>,
    );

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(undoFlow).not.toHaveBeenCalled();
  });

  it('Ctrl+Z / Ctrl+Y 走流程图撤销重做', () => {
    const undoFlow = vi.fn(() => Promise.resolve(true));
    const redoFlow = vi.fn(() => Promise.resolve(true));
    useGraphStore.setState({ undoFlow, redoFlow });
    useSessionStore.setState({ running: {}, runningWorkflowRoots: {} });

    render(
      <ReactFlowProvider>
        <FlowModulePointerDragProvider>
          <FlowCanvas graph={graphOf([{ id: 't', type: 'manual', params: {} }])} />
        </FlowModulePointerDragProvider>
      </ReactFlowProvider>,
    );

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(undoFlow).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
    expect(redoFlow).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(redoFlow).toHaveBeenCalledTimes(2);
  });

  it('节点右键：普通模块有「删除并保留缺口」，触发器没有', async () => {
    useGraphStore.setState({ selectedNodeIds: [], selectedNodeId: null });
    useSessionStore.setState({ running: {}, runningWorkflowRoots: {} });

    render(
      <ReactFlowProvider>
        <FlowModulePointerDragProvider>
          <FlowCanvas
            graph={graphOf([
              { id: 't', type: 'manual', params: {} },
              { id: 'a', type: 'delay', params: { ms: 100 } },
            ])}
          />
        </FlowModulePointerDragProvider>
      </ReactFlowProvider>,
    );

    fireEvent.contextMenu(document.querySelector('[data-flow-step-id="t"]')!);
    expect(await screen.findByText('模块设置')).toBeInTheDocument();
    expect(screen.queryByText('删除并保留缺口')).toBeNull();
    fireEvent.pointerDown(document.body);

    fireEvent.contextMenu(document.querySelector('[data-flow-step-id="a"]')!);
    expect(await screen.findByText('删除此模块')).toBeInTheDocument();
    expect(screen.getByText('删除并保留缺口')).toBeInTheDocument();
  });
});
