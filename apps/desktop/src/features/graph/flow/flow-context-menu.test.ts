import { describe, expect, it } from 'vitest';

import { flowEdgeContextMenu, flowNodeContextMenu } from '@/features/graph/flow/flow-context-menu';

const screen = { x: 0, y: 0 };
const flow = { x: 0, y: 0 };
const noop = (): void => {};

function nodeMenu(onDeleteKeepingGap?: () => void) {
  return flowNodeContextMenu(
    screen,
    flow,
    's1',
    '点击',
    noop,
    noop,
    null,
    undefined,
    noop,
    onDeleteKeepingGap,
  );
}

describe('flowNodeContextMenu', () => {
  it('提供回调时才有「删除并保留缺口」', () => {
    const labels = nodeMenu(noop).items.map((item) => item.label);
    expect(labels).toContain('删除此模块');
    expect(labels).toContain('删除并保留缺口');
  });

  it('没有回调（触发器 / 条件循环块）时不出现', () => {
    const labels = nodeMenu().items.map((item) => item.label);
    expect(labels).toContain('删除此模块');
    expect(labels).not.toContain('删除并保留缺口');
  });
});

describe('flowEdgeContextMenu', () => {
  it('只有断开这一条，且说明下游会变未接入', () => {
    const menu = flowEdgeContextMenu(screen, flow, 'e1', noop);
    expect(menu.kind).toBe('edge');
    expect(menu.items.map((item) => item.label)).toEqual(['断开这条线']);
    expect(menu.items[0]?.hint).toContain('未接入');
  });
});
