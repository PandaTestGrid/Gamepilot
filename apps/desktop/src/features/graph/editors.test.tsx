/**
 * 边/节点编辑器的渲染测试。
 *
 * 这两个面板只在"选中边/节点"时挂载，App 的壳测试覆盖不到；
 * 真机上点一下崩掉是最难查的，所以这里用假数据把它们渲染一遍。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EdgeEditor } from '@/features/graph/EdgeEditor';
import { NodeEditor } from '@/features/graph/NodeEditor';
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
    expect(screen.getByText('限时等待ms')).toBeInTheDocument();
    expect(screen.getByText('动作')).toBeInTheDocument();
    expect(screen.getByText('保存到脚本')).toBeInTheDocument();
    expect(screen.getByText('删除边')).toBeInTheDocument();
    // 识别器标签以按钮形式出现（且/或/非 各一组）
    expect(screen.getAllByText('icon').length).toBeGreaterThan(0);
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
    expect(screen.getByText(/拖节点右侧的小圆点/)).toBeInTheDocument();
  });
});
