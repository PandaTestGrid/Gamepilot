import { describe, expect, it } from 'vitest';

import { searchMaterials, scoreMaterialQuery, tokenize } from '@/lib/material-search';

const ITEMS = [
  { label: '邀请好友' },
  { label: '逢魔之时' },
  { label: '同行记录' },
  { label: 'start_btn' },
  { label: 'main_region_1' },
  { label: 'X' },
];

describe('tokenize', () => {
  it('拆开蛇形、驼峰和中文邻字', () => {
    expect(tokenize('start_btn')).toEqual(expect.arrayContaining(['start', 'btn']));
    expect(tokenize('startBtn')).toEqual(expect.arrayContaining(['start', 'btn']));
    expect(tokenize('邀请好友')).toEqual(expect.arrayContaining(['邀请好友', '邀请', '好友']));
  });
});

describe('searchMaterials', () => {
  it('空查询保持原顺序', () => {
    expect(searchMaterials(ITEMS, '  ').map((item) => item.label)).toEqual(ITEMS.map((item) => item.label));
  });

  it('子串命中：邀请 → 邀请好友', () => {
    expect(searchMaterials(ITEMS, '邀请').map((item) => item.label)).toEqual(['邀请好友']);
  });

  it('乱序字也能近义命中：邀友 → 邀请好友', () => {
    expect(searchMaterials(ITEMS, '邀友').map((item) => item.label)).toEqual(['邀请好友']);
  });

  it('拆词：start 对上 start_btn，region 对上 main_region_1', () => {
    expect(searchMaterials(ITEMS, 'start').map((item) => item.label)).toEqual(['start_btn']);
    expect(searchMaterials(ITEMS, 'region').map((item) => item.label)).toContain('main_region_1');
  });

  it('中英近义：搜「开始」能找到 start_btn', () => {
    expect(searchMaterials(ITEMS, '开始').map((item) => item.label)).toContain('start_btn');
    expect(searchMaterials(ITEMS, '按钮').map((item) => item.label)).toContain('start_btn');
  });

  it('拼音与声母：yaoqing / yqhy 都能找到邀请好友', () => {
    expect(searchMaterials(ITEMS, 'yaoqing').map((item) => item.label)).toEqual(['邀请好友']);
    expect(searchMaterials(ITEMS, 'yqhy').map((item) => item.label)).toEqual(['邀请好友']);
    expect(searchMaterials(ITEMS, 'fengmo').map((item) => item.label)).toEqual(['逢魔之时']);
  });

  it('更像的排前面：精确名压过部分匹配', () => {
    const ranked = searchMaterials(
      [{ label: '邀' }, { label: '邀请好友' }, { label: '好友邀请函' }],
      '邀请好友',
    );
    expect(ranked[0]?.label).toBe('邀请好友');
  });

  it('不相近的不出现', () => {
    expect(searchMaterials(ITEMS, 'zzzz').map((item) => item.label)).toEqual([]);
  });

  it('额外文本（被哪个模块引用）也能搜到', () => {
    const found = searchMaterials([{ label: 'X', type: 'template' }], '点击', () => '模块 · 点击');
    expect(found.map((item) => item.label)).toEqual(['X']);
  });
});

describe('scoreMaterialQuery', () => {
  it('空查询给基础分，完全无关是 0', () => {
    expect(scoreMaterialQuery({ label: '邀请好友' }, '')).toBe(1);
    expect(scoreMaterialQuery({ label: '邀请好友' }, 'zzzzzz')).toBe(0);
  });
});
