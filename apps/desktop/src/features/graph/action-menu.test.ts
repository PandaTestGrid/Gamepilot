/**
 * 「＋操作」菜单的内容（`action-menu.ts`）：一级"做什么"、二级"具体怎么做"。
 *
 * 用户反馈"菜单里的事件应该能配置""应该有二级菜单" —— 这个模块就是那条流水线：
 * 点二级项 = 建好一步，参数已经带上（哪个模板 / 等多久 / 按哪个键 / 给哪个变量赋值）。
 */
import { describe, expect, it, vi } from 'vitest';

import { buildActionMenu } from '@/features/graph/action-menu';
import type { MenuItem } from '@/features/graph/GraphContextMenu';

function ctx(patch: Partial<Parameters<typeof buildActionMenu>[0]> = {}) {
  const create = vi.fn();
  return {
    create,
    context: {
      templates: ['相机', '商店标题'],
      variables: ['count'],
      scripts: ['主线'],
      create,
      ...patch,
    },
  };
}

function item(items: MenuItem[], label: string): MenuItem {
  const found = items.find((entry) => entry.label === label);
  if (!found) {
    throw new Error(`菜单里没有「${label}」：${items.map((entry) => entry.label).join(' / ')}`);
  }
  return found;
}

describe('＋操作菜单', () => {
  it('一级是动作类型，每个都带二级菜单', () => {
    const { context } = ctx();
    const menu = buildActionMenu(context);

    for (const label of ['点击', '长按', '滑动', '等待', '按键', '输入文字', '赋值', '调用子脚本']) {
      expect(item(menu, label).submenu?.length).toBeGreaterThan(0);
    }
  });

  it('点击 ▸ 模板：目标与条件一起绑上（"事件可配置"）', () => {
    const { context, create } = ctx();
    const click = item(buildActionMenu(context), '点击');

    item([...click.submenu!], '「相机」').onSelect?.();

    expect(create).toHaveBeenCalledWith({
      action: { type: 'click', target: '相机' },
      when: '相机',
      condition: { all_of: ['相机'] },
    });
  });

  it('等待 ▸ 0.5 秒：参数直接落到动作里', () => {
    const { context, create } = ctx();
    const wait = item(buildActionMenu(context), '等待');

    item([...wait.submenu!], '0.5 秒').onSelect?.();
    expect(create).toHaveBeenCalledWith({ action: { type: 'wait', seconds: 0.5 } });
  });

  it('按键 ▸ 返回：值用引擎认识的 key', () => {
    const { context, create } = ctx();
    const key = item(buildActionMenu(context), '按键');

    item([...key.submenu!], '返回').onSelect?.();
    expect(create).toHaveBeenCalledWith({ action: { type: 'key', value: 'back' } });
  });

  it('赋值 ▸ 列出图里的变量；调用子脚本 ▸ 列出脚本库', () => {
    const { context, create } = ctx();
    const menu = buildActionMenu(context);

    item([...item(menu, '赋值').submenu!], '「count」= 0').onSelect?.();
    expect(create).toHaveBeenCalledWith({ action: { type: 'set', name: 'count', value: '0' } });

    item([...item(menu, '调用子脚本').submenu!], '主线').onSelect?.();
    expect(create).toHaveBeenCalledWith({ action: { type: 'call', script: '主线' } });
  });

  it('没有变量 / 没有脚本时给出说明项，且仍能"自定义…"', () => {
    const { context } = ctx({ variables: [], scripts: [] });
    const menu = buildActionMenu(context);

    expect(item([...item(menu, '赋值').submenu!], '（还没有变量：详情面板里可以新建）')).toBeTruthy();
    // 最后一项永远是"自定义…（在下方详情里配）"
    const custom = item(menu, '点击').submenu!.at(-1);
    expect(custom?.label).toContain('自定义');
  });

  it('滑动 ▸ 上滑：给出起点/终点坐标', () => {
    const { context, create } = ctx();
    const swipe = item(buildActionMenu(context), '滑动');

    item([...swipe.submenu!], '上滑').onSelect?.();
    expect(create).toHaveBeenCalledWith({
      action: { type: 'swipe', x: 0.5, y: 0.75, to_x: 0.5, to_y: 0.25 },
    });
  });
});
