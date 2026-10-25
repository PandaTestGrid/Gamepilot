import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClickStepFields } from '@/features/graph/flow/ClickStepFields';
import { RecognizerPicker } from '@/features/recognizers/RecognizerPicker';
import { useDeviceStore } from '@/stores/device.store';
import { SCRIPT_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';
import type { GraphData } from '@/types';

const { detail } = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock('@/lib/rpc', async (original) => ({ ...await original<object>(), recognizerDetail: detail }));
vi.mock('@/features/device/YoloRecognizerDialog', () => ({
  YoloRecognizerDialog: ({ editLabel, onClose }: { editLabel: string; onClose: () => void }) => (
    <div role="dialog" aria-label="编辑 AI"><span>{editLabel}</span><button onClick={onClose}>关闭编辑</button></div>
  ),
}));

const ai = {
  label: 'ai_12', type: 'yolo' as const, template: '', score: 0, threshold: 0.52,
  roi: [0, 0, 1, 1] as const, search: 'region' as const, samples: 0, state: 'idle' as const,
  classes: ['ai_12', 'ai_12'], examplesCount: 2,
};
function installGraph(roi: readonly [number, number, number, number] = ai.roi) {
  const graph: GraphData = {
    deviceId: SCRIPT_SCOPE, nodes: [], edges: [], recognizers: [{ ...ai, roi }],
    variables: [], activeNodeId: null, pendingNodeId: null,
  };
  useGraphStore.setState({ graphs: { [SCRIPT_SCOPE]: graph } });
}

beforeEach(() => {
  detail.mockResolvedValue({ examples: [] });
  useDeviceStore.setState({ activeId: 'ai-controls-test' });
  installGraph();
});
afterEach(() => { vi.useRealTimers(); });

describe('AI 点击配置', () => {
  it('节点保留目标预览和点击策略，不出现普通模板录制与阈值', async () => {
    render(<ClickStepFields stepId="click-ai" params={{ by: 'recognizer', rec: 'ai_12' }} recognizerLabels={['ai_12']} onPatch={vi.fn()} compact />);
    expect(screen.getByRole('button', { name: '编辑 AI' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '录制' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('recognizer-record-ocr')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recognizer-threshold-control')).not.toBeInTheDocument();
    expect(screen.getByTestId('step-selection-strategy')).toBeInTheDocument();
    expect(await screen.findByText('暂无标记图片 · 按类别名称识别')).toBeInTheDocument();
    expect(screen.queryByText(/ai_12 \/ ai_12/)).not.toBeInTheDocument();
  });

  it('侧栏区分共享AI置信度和本步策略，不提供无效原区域选项', async () => {
    render(<ClickStepFields stepId="click-ai" params={{ by: 'recognizer', rec: 'ai_12' }} recognizerLabels={['ai_12']} onPatch={vi.fn()} previewSide part="image" />);
    expect(screen.getByText('AI 置信度')).toBeInTheDocument();
    expect(screen.getByText(/当前工作流内引用此识别器的步骤共用/)).toBeInTheDocument();
    expect(screen.getByText('本步点击策略')).toBeInTheDocument();
    expect(screen.getByTestId('ai-search-fullscreen')).toHaveTextContent('全屏');
    expect(screen.queryByTestId('step-search-region')).not.toBeInTheDocument();
    const range = screen.getByTestId('recognizer-threshold-slider');
    expect(range).toHaveAttribute('min', '0.05');
    expect(range).toHaveAttribute('max', '1');
    expect(range).toHaveAttribute('title', expect.stringContaining('AI 置信度'));
    await screen.findByText('暂无标记图片 · 按类别名称识别');
  });

  it('确有独立ROI的AI保留步骤搜索范围，并只提交当前步骤search', async () => {
    installGraph([0.1, 0.2, 0.3, 0.4]);
    const onPatch = vi.fn();
    render(<ClickStepFields stepId="click-ai" params={{ by: 'recognizer', rec: 'ai_12' }} recognizerLabels={['ai_12']} onPatch={onPatch} previewSide part="image" />);
    fireEvent.click(screen.getByTestId('step-search-full'));
    expect(onPatch).toHaveBeenCalledWith({ search: 'full' });
    expect(screen.queryByTestId('ai-search-fullscreen')).not.toBeInTheDocument();
    await screen.findByText('暂无标记图片 · 按类别名称识别');
  });

  it('编辑AI打开已选识别器，不触发模板录制', async () => {
    render(<RecognizerPicker value="ai_12" labels={['ai_12']} flowStepId="click-ai" onChange={vi.fn()} compact />);
    fireEvent.click(screen.getByRole('button', { name: '编辑 AI' }));
    expect(screen.getByRole('dialog', { name: '编辑 AI' })).toHaveTextContent('ai_12');
    fireEvent.click(screen.getByRole('button', { name: '关闭编辑' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await screen.findByText('暂无标记图片 · 按类别名称识别');
  });

  it('AI置信度保存原有英文接口并更新共享识别器，而非写步骤私有参数', async () => {
    vi.useFakeTimers();
    const setThreshold = vi.fn().mockResolvedValue(undefined);
    useSessionStore.setState({ setThreshold });
    const onChange = vi.fn();
    render(<RecognizerPicker value="ai_12" labels={['ai_12']} onChange={onChange} showThreshold />);
    fireEvent.change(screen.getByTestId('recognizer-threshold-slider'), { target: { value: '0.61' } });
    expect(useGraphStore.getState().graphs[SCRIPT_SCOPE]?.recognizers[0]?.threshold).toBe(0.61);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(setThreshold).toHaveBeenCalledWith('ai-controls-test', 'ai_12', 0.61);
    expect(onChange).not.toHaveBeenCalled();
  });
});
