import { describe, expect, it } from 'vitest';

import {
  gridPositionsForSteps,
  stepsToFlowCanvas,
  unconnectedFlowRunError,
} from '@/features/graph/flow/flow-layout';
import { FLOW_BRANCH_GAP_Y, FLOW_NODE_GAP_X } from '@/features/graph/flow/flow-spacing';
import type { FlowStep } from '@/types';

const steps: FlowStep[] = [
  { id: 'trigger', type: 'schedule', params: { at: '09:00' } },
  { id: 'a', type: 'delay', params: { ms: 100 } },
  { id: 'b', type: 'key', params: { value: 'back' } },
];

describe('flow-layout', () => {
  it('生成节点；边由步骤顺序派生', () => {
    const { nodes, edges } = stepsToFlowCanvas(steps, {}, null, null);
    expect(nodes).toHaveLength(3);
    expect(nodes[0]?.deletable).toBe(false);
    expect(nodes[1]?.deletable).toBe(true);
    expect(edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual(['trigger->a', 'a->b']);
  });

  it('格距比卡片还宽：自动排版后相邻节点不会贴在一起 / 互相盖住', () => {
    // FlowStepNode：min-w-[200px]，条件 max-w-[228px]，带内嵌面板 max-w-[300px]，
    // 多出口节点的标签还会从卡片右边再伸出 ~28px。
    expect(FLOW_NODE_GAP_X).toBeGreaterThan(300 + 28);
    expect(FLOW_BRANCH_GAP_Y).toBeGreaterThan(0);
  });

  it('分支从头节点底边往下排：条件卡片再高也不会压住下面的分支', () => {
    const condSteps: FlowStep[] = [
      { id: 't', type: 'manual' },
      { id: 'c', type: 'cond', params: {} },
      { id: 'then', type: 'delay', params: { ms: 1 } },
      { id: 'e', type: 'else', params: {} },
      { id: 'brk', type: 'loopbreak', params: {} },
      { id: 'ce', type: 'condend', params: { back: 'c' } },
    ];
    // 两行条件卡片实测 345 高（一行约 218）
    const tall = 345;
    const sizes = new Map([['c', { w: 228, h: tall }]]);
    const grid = gridPositionsForSteps(condSteps, (step) => sizes.get(step.id) ?? { w: 300, h: 240 });
    expect(grid.then).toEqual({ x: 440, y: 180 + tall + 80 });
    expect(grid.brk!.y).toBeGreaterThanOrEqual(180 + tall + 80);
  });

  it('gridPositionsForSteps：条件分支在下方，条件后的下一步在右侧同一行', () => {
    const many: FlowStep[] = [
      { id: 's0', type: 'manual' },
      { id: 's1', type: 'cond' },
      { id: 's2', type: 'delay' },
      { id: 'e', type: 'else' },
      { id: 's3', type: 'delay' },
      { id: 'ce', type: 'condend', params: { back: 's1' } },
      { id: 's4', type: 'delay' },
    ];
    const grid = gridPositionsForSteps(many);
    expect(grid.s0).toEqual({ x: 80, y: 180 });
    expect(grid.s1).toEqual({ x: 440, y: 180 });
    expect(grid.s2).toEqual({ x: 440, y: 480 });
    expect(grid.s3).toEqual({ x: 440, y: 800 });
    expect(grid.s4).toEqual({ x: 800, y: 180 });
  });

  it('gridPositionsForSteps：循环体在循环节点正下方，循环后在右侧同一行', () => {
    const loopSteps: FlowStep[] = [
      { id: 't', type: 'manual' },
      { id: 'lp', type: 'loop', params: { count: 10 } },
      { id: 'body', type: 'click', params: { by: '坐标', x: 0.5, y: 0.5 } },
      { id: 'le', type: 'loopend', params: { back: 'lp' } },
      { id: 'after', type: 'delay', params: { ms: 1 } },
    ];
    const grid = gridPositionsForSteps(loopSteps);
    expect(grid.t).toEqual({ x: 80, y: 180 });
    expect(grid.lp).toEqual({ x: 440, y: 180 });
    expect(grid.body).toEqual({ x: 440, y: 390 });
    expect(grid.after).toEqual({ x: 800, y: 180 });
  });

  it('循环体是空的：整条运行被拦下，说清楚是哪个循环', () => {
    const titleOf = (step: FlowStep): string => step.id;
    const emptyLoop: FlowStep[] = [
      { id: 't', type: 'manual', params: { _out: ['out>lp'] } },
      { id: 'lp', type: 'loop', params: { count: 10, _out: [] } },
      { id: 'le', type: 'loopend', params: { back: 'lp', _out: [] } },
    ];
    expect(unconnectedFlowRunError(emptyLoop, undefined, titleOf)).toContain('「lp」');
    expect(unconnectedFlowRunError(emptyLoop, undefined, titleOf)).toContain('循环体是空的');
    // 单模块调试照旧放行
    expect(unconnectedFlowRunError(emptyLoop, 'lp', titleOf)).toBeNull();
    const withBody: FlowStep[] = [
      { id: 't', type: 'manual', params: { _out: ['out>lp'] } },
      { id: 'lp', type: 'loop', params: { count: 3, _out: ['body>b'] } },
      { id: 'b', type: 'delay', params: { ms: 10, _out: [] } },
      { id: 'le', type: 'loopend', params: { back: 'lp', _out: [] } },
    ];
    expect(unconnectedFlowRunError(withBody, undefined, titleOf)).toBeNull();
    // 只有「跳出循环」也算有循环体
    const breakOnly: FlowStep[] = [
      { id: 't', type: 'manual', params: { _out: ['out>lp'] } },
      { id: 'lp', type: 'loop', params: { count: 3, _out: ['body>br'] } },
      { id: 'br', type: 'loopbreak', params: { back: 'lp' } },
      { id: 'le', type: 'loopend', params: { back: 'lp', _out: [] } },
    ];
    expect(unconnectedFlowRunError(breakOnly, undefined, titleOf)).toBeNull();
  });

  it('没接进流程的模块：整条运行被拦，单模块调试放行', () => {
    const steps: FlowStep[] = [
      { id: 't', type: 'manual', params: { _out: ['out>a'] } },
      { id: 'a', type: 'click', params: { by: '坐标', x: 0.5, y: 0.5, _out: [] } },
      { id: 'orphan', type: 'wait', params: { rec: 'region_10' } },
    ];
    const titleOf = (step: FlowStep): string => step.id;
    expect(unconnectedFlowRunError(steps, undefined, titleOf)).toContain('「orphan」');
    expect(unconnectedFlowRunError(steps, 'orphan', titleOf)).toBeNull();
    expect(
      unconnectedFlowRunError(
        [
          { id: 't', type: 'manual', params: { _out: [] } },
          { id: 'a', type: 'click', params: { by: '坐标', x: 0.5, y: 0.5 } },
        ],
        undefined,
        titleOf,
      ),
    ).toContain('「a」');
  });

  it('gridPositionsForSteps：嵌套循环体继续往下排', () => {
    const nested: FlowStep[] = [
      { id: 't', type: 'manual' },
      { id: 'outer', type: 'loop', params: { count: 10 } },
      { id: 'inner', type: 'loop', params: { count: 10 } },
      { id: 'body', type: 'click', params: { by: '坐标', x: 0.5, y: 0.5 } },
      { id: 'ile', type: 'loopend', params: { back: 'inner' } },
      { id: 'ole', type: 'loopend', params: { back: 'outer' } },
      { id: 'after', type: 'delay', params: { ms: 1 } },
    ];
    const grid = gridPositionsForSteps(nested);
    expect(grid.outer).toEqual({ x: 440, y: 180 });
    expect(grid.inner).toEqual({ x: 440, y: 390 });
    expect(grid.body).toEqual({ x: 440, y: 600 });
    expect(grid.after).toEqual({ x: 800, y: 180 });
  });
});
