/**
 * 运行状态条：运行调试时"一句话说清现在在哪、下一步走哪条、还差什么"。
 *
 * 画布上的高亮（当前节点呼吸、条件边流动）只能表达"大概在动"；
 * 调试真正需要的是当前界面 / 下一条边 / 条件是否成立 —— 这条就是那个答案。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RunStatusStrip } from '@/features/graph/RunStatusStrip';
import type { EdgeStatus } from '@/lib/edge-status';
import type { GraphData, GraphEdgeView } from '@/types';

function edge(patch: Partial<GraphEdgeView> & { id: string }): GraphEdgeView {
  return {
    from: 'main',
    to: 'shop',
    when: 'always',
    kind: 'normal',
    priority: 0,
    minScore: 0,
    cooldownMs: 0,
    retries: 1,
    action: 'click',
    actionSpec: { type: 'click' },
    condition: { allOf: [], anyOf: [], noneOf: [], minScore: 0, withinMs: 0, always: true },
    label: '点击商店',
    ...patch,
  } as GraphEdgeView;
}

function graph(patch: Partial<GraphData> = {}): GraphData {
  return {
    deviceId: 'dev',
    nodes: [
      { id: 'main', name: '主界面', enter: [], x: 0, y: 0, visits: 1 },
      { id: 'shop', name: '商店', enter: [], x: 200, y: 0, visits: 0 },
    ],
    edges: [edge({ id: 'e1' })],
    variables: [],
    recognizers: [],
    activeNodeId: 'main',
    pendingNodeId: null,
    ...patch,
  };
}

describe('运行状态条', () => {
  it('运行中：显示当前界面 + 下一步 + "条件成立"', () => {
    const statuses = new Map<string, EdgeStatus>([['e1', { kind: 'matched', reason: '无条件' }]]);
    render(<RunStatusStrip graph={graph()} statuses={statuses} running />);

    expect(screen.getByTestId('run-status').textContent).toContain('运行中');
    expect(screen.getByTestId('run-status').textContent).toContain('主界面');
    expect(screen.getByTestId('run-status').textContent).toContain('条件成立');
  });

  it('条件还没成立时：把"差什么"显示出来（调试的关键信息）', () => {
    const statuses = new Map<string, EdgeStatus>([
      ['e1', { kind: 'waiting', reason: '还差：『相机』没命中' }],
    ]);
    render(<RunStatusStrip graph={graph()} statuses={statuses} running />);

    expect(screen.getByTestId('run-status').textContent).toContain('还差：『相机』没命中');
  });

  it('不在任何界面且已停止：不占地方（不显示）', () => {
    const { container } = render(
      <RunStatusStrip graph={graph({ activeNodeId: null })} statuses={new Map()} running={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('没有出边时说清楚"会停在这里"', () => {
    render(<RunStatusStrip graph={graph({ edges: [] })} statuses={new Map()} running />);
    expect(screen.getByTestId('run-status').textContent).toContain('没有出边');
  });
});
