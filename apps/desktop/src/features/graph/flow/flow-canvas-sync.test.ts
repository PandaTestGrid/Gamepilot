import { describe, expect, it } from 'vitest';

import { mergeDerivedFlowNodes } from '@/features/graph/flow/flow-canvas-sync';
import type { FlowStepNodeType } from '@/features/graph/flow/flow-layout';

function node(id: string, x: number, dragging?: boolean): FlowStepNodeType {
  return {
    id,
    type: 'flowStep',
    position: { x, y: 0 },
    dragging,
    data: {
      step: { id, type: 'delay', params: { ms: 1 } },
      title: id,
      isTrigger: false,
      expanded: false,
      running: false,
      failed: false,
      pending: false,
      unconnected: false,
    },
  };
}

describe('mergeDerivedFlowNodes', () => {
  it('拖动中的节点保留本地坐标', () => {
    const current = [node('a', 50, true)];
    const derived = [node('a', 200)];
    const merged = mergeDerivedFlowNodes(current, derived);
    expect(merged[0]?.position.x).toBe(50);
    expect(merged[0]?.dragging).toBe(true);
  });

  it('非拖动节点更新 data 但保留已拖过的摆位', () => {
    const current = [node('a', 88)];
    const derived = [node('a', 200)];
    const merged = mergeDerivedFlowNodes(current, derived);
    expect(merged[0]?.position.x).toBe(88);
  });

  it('selectedIds 覆盖旧的 selected，避免多节点粘连拖动', () => {
    const current = [
      { ...node('a', 0), selected: true },
      { ...node('b', 100), selected: true },
    ];
    const derived = [node('a', 0), node('b', 100)];
    const merged = mergeDerivedFlowNodes(current, derived, { selectedIds: new Set(['b']) });
    expect(merged[0]?.selected).toBe(false);
    expect(merged[1]?.selected).toBe(true);
  });

  it('重新布局时采用推导坐标，不保留旧摆位', () => {
    const current = [node('a', 88)];
    const derived = [node('a', 200)];
    const merged = mergeDerivedFlowNodes(current, derived, { resetPositions: true });
    expect(merged[0]?.position.x).toBe(200);
  });

  it('更新步骤参数或重新布局时保留 React Flow 已测量的 measured 宽高，防止节点变回 visibility: hidden 消失', () => {
    const current = [{ ...node('a', 88), measured: { width: 240, height: 150 } }];
    const derived = [
      {
        ...node('a', 200),
        data: { ...node('a', 200).data, title: '双击 · (0.50, 0.50)' },
      },
    ];
    const mergedNormal = mergeDerivedFlowNodes(current, derived);
    expect(mergedNormal[0]?.measured).toEqual({ width: 240, height: 150 });
    expect(mergedNormal[0]?.data.title).toBe('双击 · (0.50, 0.50)');

    const mergedRelayout = mergeDerivedFlowNodes(current, derived, { resetPositions: true });
    expect(mergedRelayout[0]?.measured).toEqual({ width: 240, height: 150 });
    expect(mergedRelayout[0]?.position.x).toBe(200);
  });
});
