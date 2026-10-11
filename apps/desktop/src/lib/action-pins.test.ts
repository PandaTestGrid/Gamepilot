/**
 * 引脚：界面上"这一步的参数从哪来"全靠它，显示错了会误导调试。
 */
import { describe, expect, it } from 'vitest';

import { actionPins, summarizePins } from '@/lib/action-pins';

describe('动作引脚', () => {
  it('点击：坐标与变量引用都能区分出来', () => {
    const pins = actionPins({ type: 'click', x: '$点击X', y: 0.834 });
    expect(pins.map((p) => p.label)).toEqual(['X', 'Y']);
    expect(pins[0]).toMatchObject({ value: '$点击X', isVar: true });
    expect(pins[1]).toMatchObject({ value: '0.83', isVar: false });
  });

  it('识别器目标显示成"目标"引脚', () => {
    const pins = actionPins({ type: 'click', target: 'icon' });
    expect(pins).toEqual([{ label: '目标', value: 'icon', isVar: false }]);
  });

  it('滑动：起止点与时长', () => {
    const pins = actionPins({ type: 'swipe', x: 0.5, y: 0.8, toX: 0.5, toY: 0.2, durationMs: '$时长' });
    expect(pins.map((p) => p.label)).toEqual(['X', 'Y', '到X', '到Y', '时长']);
    expect(pins[4]?.isVar).toBe(true);
  });

  it('赋值动作把"变量"引脚放最前', () => {
    const pins = actionPins({ type: 'set', name: '次数', assign: '$次数' });
    expect(pins[0]).toMatchObject({ label: '变量', value: '次数' });
  });

  it('等待只显示秒数', () => {
    expect(actionPins({ type: 'wait', seconds: 1.5 }).map((p) => p.label)).toEqual(['秒数']);
  });

  it('空值不生成引脚', () => {
    expect(actionPins({ type: 'click' })).toEqual([]);
  });

  it('摘要最多 N 个（节点上地方小）', () => {
    const pins = actionPins({ type: 'swipe', x: 0.1, y: 0.2, toX: 0.3, toY: 0.4, durationMs: 300 });
    expect(summarizePins(pins, 3)).toHaveLength(3);
    expect(summarizePins(pins, 99)).toHaveLength(5);
  });
});
