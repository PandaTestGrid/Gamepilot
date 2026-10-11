/**
 * 「识别器」面板（右栏 Tab）：阈值现场调参 + **删除**。
 *
 * 删除为什么在这里、而不是画面上的读数列表：那一列是实时监控（分数每帧在跳），
 * 销毁性操作摆在跳动的东西旁边误点代价太大；这里能同时看到缩略图 / 阈值 / "被谁引用"，
 * 是"看清代价再删"的地方。被引用时按钮**置灰并写清原因**，而不是点了才报错。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RecognizerPane } from '@/features/recognizers/RecognizerPane';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import type { EdgeCondition, GraphData, GraphEdgeView, GraphNodeView, RecognizerView } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
// 缩略图会去拉模板图：这里只关心行本身，别让它发 RPC
vi.mock('@/features/recognizers/TemplateThumb', () => ({
  TemplateThumb: ({ label }: { label: string }) => <span data-testid="thumb">{label}</span>,
}));

const DEVICE = 'mock:1';

function recognizer(label: string, type: RecognizerView['type'] = 'template'): RecognizerView {
  return {
    label,
    type,
    template: type === 'template' ? `templates/${label}.png` : undefined,
    score: 0.4,
    threshold: 0.82,
    roi: [0.1, 0.1, 0.2, 0.1],
    samples: 0,
    state: 'idle',
  };
}

const CONDITION: EdgeCondition = { allOf: [], anyOf: [], noneOf: [], minScore: 0, withinMs: 0 };

function node(id: string, name: string, enter: string[] = []): GraphNodeView {
  return { id, name, enter, x: 0, y: 0, visits: 0 };
}

function edge(id: string, when: string, target?: string): GraphEdgeView {
  return {
    id,
    from: null,
    to: null,
    when,
    kind: 'normal',
    priority: 0,
    minScore: 0,
    cooldownMs: 0,
    retries: 1,
    action: '',
    condition: { ...CONDITION, allOf: when ? [when] : [] },
    actionSpec: { type: 'click', target },
  };
}

function setup(options: {
  recognizers?: readonly RecognizerView[];
  nodes?: readonly GraphNodeView[];
  edges?: readonly GraphEdgeView[];
}): ReturnType<typeof vi.fn> {
  const remove = vi.fn(() => Promise.resolve(true));
  useSessionStore.setState({ removeRecognizer: remove, setThreshold: vi.fn() });
  useDeviceStore.setState({ activeId: DEVICE });
  const graph: GraphData = {
    deviceId: DEVICE,
    nodes: options.nodes ?? [],
    edges: options.edges ?? [],
    recognizers: options.recognizers ?? [],
    variables: [],
    activeNodeId: null,
    pendingNodeId: null,
  };
  useGraphStore.setState({ graphs: { [DEVICE]: graph } });
  render(<RecognizerPane />);
  return remove;
}

describe('识别器面板：删除', () => {
  beforeEach(() => {
    useGraphStore.setState({ graphs: {} });
  });

  it('没被引用：按钮可点，删的是这一行（走 store 动作）', () => {
    const remove = setup({ recognizers: [recognizer('lonely')] });

    const button = screen.getByTestId('recognizer-remove');
    expect(button).toBeEnabled();
    expect(button).toHaveAccessibleName('删除 lonely');
    expect(screen.getByText(/还没有被引用/)).toBeInTheDocument();

    fireEvent.click(button);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(DEVICE, 'lonely');
  });

  it('被界面引用：按钮置灰，并把"被谁引用"写在同一行（不是点了才报错）', () => {
    const remove = setup({
      recognizers: [recognizer('相机')],
      nodes: [node('node_1', '新界面', ['相机']), node('n_1', '界面1', ['相机'])],
      edges: [edge('e_ai', '相机', '相机')],
    });

    const button = screen.getByTestId('recognizer-remove');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('删不掉'));

    // 同一行直接写清是哪两个界面、哪条边 —— 重名节点带 id
    expect(screen.getByText(/正在被引用：新界面（node_1）、界面1（n_1）、e_ai/)).toBeInTheDocument();

    fireEvent.click(button);
    expect(remove).not.toHaveBeenCalled();
  });

  it('被边引用：同样置灰（判断条件 / 动作目标都算）', () => {
    setup({ recognizers: [recognizer('start_btn')], edges: [edge('e_1', 'start_btn', 'start_btn')] });

    expect(screen.getByTestId('recognizer-remove')).toBeDisabled();
    expect(screen.getByText(/e_1（判断条件 \+ 动作目标）/)).toBeInTheDocument();
  });

  it('颜色识别器也能删（原来只有模板识别器有删除按钮，颜色识别器在界面上根本删不掉）', () => {
    const remove = setup({ recognizers: [recognizer('hp_bar', 'color')] });

    const button = screen.getByTestId('recognizer-remove');
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(remove).toHaveBeenCalledWith(DEVICE, 'hp_bar');
  });

  it('多个识别器：各判各的（一个被引用、一个没人用）', () => {
    setup({
      recognizers: [recognizer('相机'), recognizer('lonely')],
      nodes: [node('n_1', '界面1', ['相机'])],
    });

    const buttons = screen.getAllByTestId('recognizer-remove');
    expect(buttons).toHaveLength(2);
    // 顺序跟 recognizers 一致
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeEnabled();
  });
});
