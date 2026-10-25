import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreenPane } from '@/features/device/ScreenPane';
import { useDeviceStore } from '@/stores/device.store';
import { useGraphStore, WORKFLOW_SCOPE } from '@/stores/graph.store';
import { useOcrStore } from '@/stores/ocr.store';
import { useSessionStore, type FrameState } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import type { GraphData } from '@/types';

const counts = vi.hoisted(() => ({ header: 0, material: 0 }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock('@/features/device/GridSplitButton', () => ({ GridSplitButton: () => {
  counts.header += 1;
  return null;
} }));
vi.mock('@/features/recognizers/TemplateThumb', () => ({ TemplateThumb: () => {
  counts.material += 1;
  return <span>素材缩略图</span>;
} }));

function frame(index: number): FrameState {
  return { imageUrl: `data:image/jpeg;base64,frame${index}`, index, resolution: [720, 1280],
    node: null, pending: null, tick: index, fps: 12, captureMs: 1, detections: [], ts: index };
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  counts.header = counts.material = 0;
  useDeviceStore.setState({ activeId: 'a', gridView: false, devices: ['a', 'b'].map((id) => ({
    id, name: id, uri: `mock:${id}`, kind: 'android', status: 'connected', resolution: [720, 1280], fps: 12,
  })) });
  useSessionStore.setState({ frames: { a: frame(1), b: frame(1) }, ready: { a: true, b: true }, currentWorkflow: null });
  const graph: GraphData = { deviceId: WORKFLOW_SCOPE, nodes: [], edges: [], variables: [],
    activeNodeId: null, pendingNodeId: null, flow: { steps: [] }, recognizers: [{
      label: 'target', type: 'template', template: 'target.png', score: 0, state: 'idle',
      threshold: 0.8, roi: [0, 0, 1, 1], search: 'region', samples: 0,
    }] };
  useGraphStore.setState({ graphs: { [WORKFLOW_SCOPE]: graph }, liveByDevice: {}, selectedNodeId: null });
  useUiStore.setState({ materialOpen: true, materialFilter: 'all', draft: null, controlMode: false,
    recordMode: 'off', recordActionMode: false, pendingFlowSwipeStepId: null });
  useOcrStore.setState({ refreshStatus: () => Promise.resolve(useOcrStore.getState().status), scanningScreen: false, recognizing: false,
    pickBoxes: {}, scanVisual: null, status: { ...useOcrStore.getState().status, state: 'not_downloaded' } });
});
afterEach(cleanup);

function bump(deviceId: string, index: number): void {
  act(() => useSessionStore.setState((state) => ({ frames: { ...state.frames, [deviceId]: frame(index) } })));
}

describe('ScreenPane 精准订阅', () => {
  it('无关设备新帧不重绘外壳/素材；活动画面继续出帧但不带动它们', () => {
    render(<ScreenPane />);
    const initial = { ...counts };
    for (let index = 2; index <= 5; index += 1) bump('b', index);
    expect(counts).toEqual(initial);
    expect(screen.getByTestId('frame-overlay')).toHaveTextContent('帧 #1');
    for (let index = 2; index <= 5; index += 1) bump('a', index);
    expect(counts).toEqual(initial);
    expect(screen.getByTestId('frame-overlay')).toHaveTextContent('帧 #5');
    expect(screen.getByAltText('a 实时画面')).toHaveAttribute('src', 'data:image/jpeg;base64,frame5');
  });

  it('别台设备运行态重建不重绘素材；本机分数仍实时更新且不重绘外壳', () => {
    render(<ScreenPane />);
    act(() => useGraphStore.getState().updateLive('a', { node: null, pending: null, detections: [] }));
    const initial = { ...counts };
    act(() => useGraphStore.getState().updateLive('b', { node: 'loop', pending: null,
      detections: [{ label: 'target', score: 0.9, state: 'confirmed' }] }));
    expect(counts).toEqual(initial);
    act(() => useGraphStore.getState().updateLive('a', { node: 'loop', pending: null,
      detections: [{ label: 'target', score: 0.93, state: 'confirmed' }] }));
    expect(counts.header).toBe(initial.header);
    expect(counts.material).toBeGreaterThan(initial.material);
    expect(screen.getByText('0.93')).toBeInTheDocument();
    const afterScore = { ...counts };
    act(() => useGraphStore.getState().updateLive('a', { node: 'next', pending: 'again',
      detections: [{ label: 'target', score: 0.93, state: 'confirmed' }] }));
    expect(counts).toEqual(afterScore);
  });

  it('设备切换仍切换画面和素材，尺寸变化仍刷新布局派生值', () => {
    render(<ScreenPane />);
    act(() => useDeviceStore.setState({ activeId: 'b' }));
    expect(screen.getByAltText('b 实时画面')).toBeInTheDocument();
    const initial = counts.header;
    act(() => useSessionStore.setState((state) => ({ frames: { ...state.frames,
      b: { ...frame(2), resolution: [1280, 720] } } })));
    expect(counts.header).toBeGreaterThan(initial);
    expect(screen.getByTestId('frame-overlay')).toHaveTextContent('1280×720');
  });
});
