import { describe, expect, it } from 'vitest';

import { toActionPayload, toConditionPayload, toGraphData } from '@/lib/graph-adapter';
import type { GraphPayload } from '@/lib/rpc';

const payload: GraphPayload = {
  version: 1,
  defaults: {},
  recognizers: {
    main_start: { type: 'template', template: 'main_start.png', threshold: 0.82 },
    popup: { type: 'color', target_bgr: [10, 20, 30], threshold: 0.9 },
  },
  nodes: [
    { id: 'main', name: '主界面', enter: ['main_start'] },
    { id: 'battle', name: '战斗中', enter: ['popup'] },
  ],
  edges: [
    {
      id: 'e_plain',
      when: 'main_start',
      from: 'main',
      to: 'battle',
      action: { type: 'click', target: 'main_start' },
    },
    {
      id: 'e_cond',
      when: 'main_start',
      from: 'main',
      to: null,
      priority: 5,
      cooldown_ms: 800,
      condition: { any_of: ['popup'], none_of: ['main_start'], min_score: 0.9, within_ms: 3000 },
      action: { type: 'swipe', x: 0.5, y: 0.8, to_x: 0.5, to_y: 0.2, duration_ms: 400 },
    },
  ],
};

describe('graph.json → 界面模型', () => {
  const graph = toGraphData('dev', payload);

  it('没写 condition 的边等价于 all_of=[when]', () => {
    const edge = graph.edges.find((item) => item.id === 'e_plain');
    expect(edge?.condition.allOf).toEqual(['main_start']);
    expect(edge?.condition.anyOf).toEqual([]);
    expect(edge?.condition.withinMs).toBe(0);
    expect(edge?.actionSpec.type).toBe('click');
    expect(edge?.actionSpec.target).toBe('main_start');
  });

  it('condition / action 原样映射到界面模型', () => {
    const edge = graph.edges.find((item) => item.id === 'e_cond');
    expect(edge?.condition.anyOf).toEqual(['popup']);
    expect(edge?.condition.noneOf).toEqual(['main_start']);
    expect(edge?.condition.minScore).toBeCloseTo(0.9);
    expect(edge?.condition.withinMs).toBe(3000);
    expect(edge?.cooldownMs).toBe(800);
    expect(edge?.actionSpec).toMatchObject({ type: 'swipe', x: 0.5, toY: 0.2, durationMs: 400 });
  });

  it('识别器带上模板文件名（界面靠它取模板截图）', () => {
    const recognizer = graph.recognizers.find((item) => item.label === 'main_start');
    expect(recognizer?.template).toBe('main_start.png');
    const color = graph.recognizers.find((item) => item.label === 'popup');
    expect(color?.type).toBe('color');
    expect(color?.template).toBeUndefined();
  });
});

describe('界面模型 → graph.json', () => {
  it('默认条件（只有 when）不写进文件，保持 graph.json 干净', () => {
    const spec = toConditionPayload(
      { allOf: ['main_start'], anyOf: [], noneOf: [], minScore: 0, withinMs: 0 },
      'main_start',
    );
    expect(spec).toBeUndefined();
  });

  it('多标签/门槛/限时都写进去', () => {
    const spec = toConditionPayload(
      { allOf: ['main_start', 'other'], anyOf: ['a'], noneOf: ['popup'], minScore: 0.8, withinMs: 2000 },
      'main_start',
    );
    expect(spec).toEqual({
      all_of: ['other'],
      any_of: ['a'],
      none_of: ['popup'],
      min_score: 0.8,
      within_ms: 2000,
    });
  });

  it('动作按类型只写必要字段', () => {
    expect(toActionPayload({ type: 'wait', seconds: 1.5 })).toEqual({ type: 'wait', seconds: 1.5 });
    expect(toActionPayload({ type: 'key', value: 'back' })).toEqual({ type: 'key', value: 'back' });
    expect(toActionPayload({ type: 'click', target: 'a', durationMs: 200 })).toEqual({
      type: 'click',
      target: 'a',
      duration_ms: 200,
    });
    expect(toActionPayload({ type: 'swipe', x: 0.5, y: 0.9, toX: 0.5, toY: 0.1, durationMs: 300 })).toEqual({
      type: 'swipe',
      x: 0.5,
      y: 0.9,
      to_x: 0.5,
      to_y: 0.1,
      duration_ms: 300,
    });
  });
});
