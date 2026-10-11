/**
 * "参数存成变量"的单测：抽出来的名字、引用写法、重复名处理都要可预期。
 */
import { describe, expect, it } from 'vitest';

import { extractParamsToVariables, togglePin } from '@/lib/param-vars';

describe('把参数存成变量', () => {
  it('点击：x/y 抽成变量，动作改成 $引用', () => {
    const { variables, action } = extractParamsToVariables({ type: 'click', x: 0.512, y: 0.834 }, '点击拨号');
    expect(Object.keys(variables)).toEqual(['点击拨号_X', '点击拨号_Y']);
    expect(variables['点击拨号_X']?.value).toBeCloseTo(0.512);
    expect(action.x).toBe('$点击拨号_X');
    expect(action.y).toBe('$点击拨号_Y');
  });

  it('滑动：起止点和时长都抽出来', () => {
    const { variables, action } = extractParamsToVariables(
      { type: 'swipe', x: 0.5, y: 0.8, toX: 0.5, toY: 0.2, durationMs: 400 },
      '上滑',
    );
    expect(Object.keys(variables)).toHaveLength(5);
    expect(action.toY).toBe('$上滑_到Y');
    expect(action.durationMs).toBe('$上滑_时长');
  });

  it('等待：只抽秒数', () => {
    const { variables, action } = extractParamsToVariables({ type: 'wait', seconds: 1.5 }, '等待');
    expect(Object.keys(variables)).toEqual(['等待_秒']);
    expect(action.seconds).toBe('$等待_秒');
  });

  it('识别器目标不抽（它本来就是键）', () => {
    const { variables, action } = extractParamsToVariables({ type: 'click', target: 'icon' }, '点击图标');
    expect(Object.keys(variables)).toEqual([]);
    expect(action.target).toBe('icon');
  });

  it('已经是引用的参数不重复抽', () => {
    const { variables, action } = extractParamsToVariables({ type: 'click', x: '$已有X', y: 0.4 }, '步骤');
    expect(Object.keys(variables)).toEqual(['步骤_Y']);
    expect(action.x).toBe('$已有X');
  });

  it('变量名重复时自动加序号（同一份图里不会撞）', () => {
    const taken = new Set(['点击_X', '点击_Y']);
    const { variables } = extractParamsToVariables({ type: 'click', x: 0.1, y: 0.2 }, '点击', taken);
    expect(Object.keys(variables)).toEqual(['点击_X2', '点击_Y2']);
  });
});

describe('引脚上切换 变量/字面量', () => {
  it('点字面量引脚 → 绑成变量（值取当前数字）', () => {
    const out = togglePin({ type: 'click', x: 0.42, y: 0.9 }, 'x', { variables: [], name: '步骤1' });
    expect(out.bound).toBe(true);
    expect(out.action.x).toBe('$步骤1_x');
    expect(out.variables['步骤1_x']?.value).toBeCloseTo(0.42);
  });

  it('点已绑定的引脚 → 拆回字面量（用变量当前值）', () => {
    const out = togglePin({ type: 'click', x: '$点击X', y: 0.9 }, 'x', {
      variables: [{ name: '点击X', value: 0.77 }],
      name: '步骤1',
    });
    expect(out.bound).toBe(false);
    expect(out.action.x).toBeCloseTo(0.77);
  });

  it('重名自动加序号、非数字引脚不动', () => {
    const out = togglePin({ type: 'click', x: 0.1 }, 'x', {
      variables: [{ name: '步骤1_x', value: 1 }],
      name: '步骤1',
    });
    expect(out.action.x).toBe('$步骤1_x2');
    const text = togglePin({ type: 'click', x: undefined }, 'x', { variables: [], name: '步骤1' });
    expect(text.bound).toBe(false);
    expect(text.action.x).toBeUndefined();
  });
});
