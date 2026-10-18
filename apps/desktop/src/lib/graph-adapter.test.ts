import { describe, expect, it } from 'vitest';

import { toGraphData } from '@/lib/graph-adapter';
import type { GraphPayload } from '@/lib/rpc';

const payload: GraphPayload = {
  version: 1,
  defaults: {},
  recognizers: {
    main_start: { type: 'template', template: 'main_start.png', threshold: 0.82 },
    popup: { type: 'color', target_bgr: [10, 20, 30], threshold: 0.9 },
    popup_ok: {
      type: 'template',
      template: 'popup_ok.png',
      threshold: 0.88,
      roi: [0.3, 0.4, 0.4, 0.2],
      search: 'full',
    },
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

  it('搜索范围：缺省 region、显式 full 保留；没写 roi 映射成全屏而不是 0×0', () => {
    const plain = graph.recognizers.find((item) => item.label === 'main_start');
    expect(plain?.search).toBe('region');
    // 没写 roi = 引擎整帧搜索；界面不能显示成 0 宽高
    expect(plain?.roi).toEqual([0, 0, 1, 1]);

    const full = graph.recognizers.find((item) => item.label === 'popup_ok');
    expect(full?.search).toBe('full');
    expect(full?.roi).toEqual([0.3, 0.4, 0.4, 0.2]);
  });
});
