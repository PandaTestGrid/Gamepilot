/**
 * 边/节点编辑器的渲染测试。
 *
 * 这两个面板只在"选中边/节点"时挂载，App 的壳测试覆盖不到；
 * 真机上点一下崩掉是最难查的，所以这里用假数据把它们渲染一遍。
 */
import { invoke } from '@tauri-apps/api/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EdgeEditor } from '@/features/graph/EdgeEditor';
import { NodeEditor } from '@/features/graph/NodeEditor';
import { ScriptStepsView } from '@/features/graph/ScriptStepsView';
import { useSessionStore } from '@/stores/session.store';
import type { GraphData, GraphEdgeView, GraphNodeView } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const graph: GraphData = {
  deviceId: 'dev',
  nodes: [
    { id: 'launcher', name: '桌面', enter: ['icon'], x: 0, y: 0, visits: 0 },
    { id: 'dialer', name: '拨号盘', enter: [], x: 200, y: 0, visits: 0 },
  ],
  edges: [],
  variables: [],
  recognizers: [
    {
      label: 'icon',
      type: 'template',
      score: 0.99,
      threshold: 0.8,
      roi: [0, 0, 1, 1],
      samples: 1,
      state: 'confirmed',
    },
  ],
  activeNodeId: 'launcher',
  pendingNodeId: null,
};

const edge: GraphEdgeView = {
  id: 'e_rec_1',
  from: 'launcher',
  to: 'dialer',
  when: 'icon',
  kind: 'normal',
  priority: 0,
  minScore: 0,
  cooldownMs: 600,
  retries: 1,
  action: 'click',
  condition: { allOf: ['icon'], anyOf: [], noneOf: [], minScore: 0, withinMs: 0 },
  actionSpec: { type: 'click', target: 'icon', durationMs: 300 },
};

const node: GraphNodeView = { id: 'launcher', name: '桌面', enter: ['icon'], x: 0, y: 0, visits: 3 };

describe('边编辑器', () => {
  it('渲染条件勾选、限时等待与动作参数', () => {
    render(<EdgeEditor deviceId="dev" edge={edge} graph={graph} />);

    expect(screen.getByText('e_rec_1')).toBeInTheDocument();
    expect(screen.getByText('判断条件')).toBeInTheDocument();
    expect(screen.getByText('限时等待（毫秒）')).toBeInTheDocument();
    expect(screen.getByText('动作')).toBeInTheDocument();
    expect(screen.getByText('保存到脚本')).toBeInTheDocument();
    expect(screen.getByText('删除边')).toBeInTheDocument();
    // 识别器标签以按钮形式出现（且/或/非 各一组）
    expect(screen.getAllByText('icon').length).toBeGreaterThan(0);
  });

  it('「执行这一步」失败时红字写"执行失败"，不是"保存失败"（踩过：用户以为脚本没存上）', async () => {
    const user = userEvent.setup();
    // 走真实链路：action.run → invoke（这里 reject）→ rpc() 清理文案 → 面板红字
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      const method = (args as { method?: string } | undefined)?.method;
      if (cmd === 'engine_rpc' && method === 'action.run') {
        return Promise.reject(
          new Error('引擎返回错误: {"code":-32603,"message":"ValueError: 变量未定义: 步骤2_时长"}'),
        );
      }
      return Promise.resolve({});
    });
    useSessionStore.setState({ ready: { dev: true } });
    render(<EdgeEditor deviceId="dev" edge={edge} graph={graph} />);

    await user.click(screen.getByText('立即执行这一步'));

    const call = vi.mocked(invoke).mock.calls.at(-1);
    expect(call?.[0]).toBe('engine_rpc');
    expect((call?.[1] as { method?: string } | undefined)?.method).toBe('action.run');
    expect((call?.[1] as { params?: { deviceId?: string } } | undefined)?.params?.deviceId).toBe('dev');
    // 文案被清理过（不是一坨 JSON），而且前缀说清是"执行"失败
    expect(screen.getByText('执行失败: 引擎返回错误: 变量未定义: 步骤2_时长')).toBeInTheDocument();
    expect(screen.queryByText(/保存失败/)).toBeNull();
  });

  it('条件自相矛盾（同一个识别器既在「或」又在「非」）：面板上直接报警', () => {
    const contradictory: GraphEdgeView = {
      ...edge,
      id: 'e_conflict',
      when: 'icon',
      condition: { allOf: [], anyOf: ['icon'], noneOf: ['icon'], minScore: 0, withinMs: 0 },
    };
    render(<EdgeEditor deviceId="dev" edge={contradictory} graph={graph} />);

    const warning = screen.getByTestId('condition-conflict');
    expect(warning).toHaveTextContent('icon');
    expect(warning).toHaveTextContent('永远不会触发');
  });

  it('正常条件不报警（别把提示变成噪音）', () => {
    render(<EdgeEditor deviceId="dev" edge={edge} graph={graph} />);
    expect(screen.queryByTestId('condition-conflict')).toBeNull();
  });

  it('无条件边（录制出来的一步）也能渲染', () => {
    const unconditional: GraphEdgeView = {
      ...edge,
      id: 'e_rec_2',
      when: 'always',
      condition: { allOf: [], anyOf: [], noneOf: [], minScore: 0, withinMs: 0, always: true },
      actionSpec: { type: 'wait', seconds: 0.5 },
    };
    render(<EdgeEditor deviceId="dev" edge={unconditional} graph={graph} />);
    expect(screen.getByText('e_rec_2')).toBeInTheDocument();
  });
});

describe('节点编辑器', () => {
  it('渲染改名、进入识别器与删除', () => {
    render(<NodeEditor deviceId="dev" node={node} graph={graph} />);

    expect(screen.getByText('节点 launcher')).toBeInTheDocument();
    expect(screen.getByDisplayValue('桌面')).toBeInTheDocument();
    expect(screen.getByText('删除节点')).toBeInTheDocument();
    // 点节点要看得到"这个界面的逻辑"和出去的操作
    expect(screen.getByText(/界面判定/)).toBeInTheDocument();
  });
});

describe('脚本视图（线性步骤）', () => {
  it('按执行顺序列出界面与操作，并和图双向联动', () => {
    const withSteps: GraphData = {
      ...graph,
      edges: [
        {
          id: 'e_rec_1',
          from: 'launcher',
          to: 'dialer',
          when: 'icon',
          kind: 'normal',
          priority: 0,
          minScore: 0,
          cooldownMs: 600,
          retries: 1,
          action: 'click',
          condition: { allOf: ['icon'], anyOf: [], noneOf: [], minScore: 0, withinMs: 0 },
          actionSpec: { type: 'click', x: 0.5, y: 0.8 },
        },
      ],
    };
    render(<ScriptStepsView graph={withSteps} />);

    expect(screen.getByText('界面『桌面』')).toBeInTheDocument();
    expect(screen.getByText('点击 (0.50, 0.80)')).toBeInTheDocument();
    expect(screen.getByText('界面『拨号盘』')).toBeInTheDocument();
    expect(screen.getByText(/共 2 个界面 · 1 步操作/)).toBeInTheDocument();
  });

  it('空脚本给一句能照做的提示', () => {
    render(<ScriptStepsView graph={{ ...graph, nodes: [], edges: [] }} />);
    expect(screen.getByText(/脚本还是空的/)).toBeInTheDocument();
  });
});
