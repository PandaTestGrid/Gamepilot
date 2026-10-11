/**
 * 布局登记处的纯逻辑测试。
 *
 * 这里守的是"上下也能拖"这条改动里最容易悄悄坏掉的部分：
 * 预设里的面板 id/数量必须和组件里 <Panel id> 完全一致 —— 不一致时
 * react-resizable-panels 的 setLayout 会抛错（key 数必须等于面板数），
 * 而那种错误只在点了预设的那一刻才出现，真机上很难查。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  applyLayoutPanels,
  applyLayoutPreset,
  GRAPH_LAYOUT,
  LAYOUT_PRESETS,
  layoutStorageKey,
  registerLayoutGroup,
  rememberLayout,
  resetLayouts,
  RIGHT_LAYOUT,
  SCREEN_LAYOUT,
  SHELL_LAYOUT,
  type LayoutPanels,
  type LayoutPreset,
  type LayoutSpec,
} from '@/layout/layout-specs';

const ALL_SPECS: readonly LayoutSpec[] = [SHELL_LAYOUT, SCREEN_LAYOUT, GRAPH_LAYOUT, RIGHT_LAYOUT];

function presetById(id: string): LayoutPreset {
  const preset = LAYOUT_PRESETS.find((item) => item.id === id);
  if (!preset) {
    throw new Error(`测试里引用了不存在的预设 ${id}`);
  }
  return preset;
}

function sum(panels: LayoutPanels): number {
  return Object.values(panels).reduce((total, value) => total + value, 0);
}

describe('布局分组', () => {
  it('每组都是"整块分完"的比例（加起来 100%，没有 0 或负数）', () => {
    for (const spec of ALL_SPECS) {
      const values = Object.values(spec.panels);
      expect(values.length).toBeGreaterThan(1);
      expect(sum(spec.panels)).toBeCloseTo(100, 5);
      for (const value of values) {
        expect(value).toBeGreaterThan(0);
      }
    }
  });

  it('主壳三栏与栏内的纵向分组各用各的 id（记忆不会互相覆盖）', () => {
    const ids = ALL_SPECS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('预设', () => {
  it('每个预设给到的面板 id 与该组完全一致（多一个少一个都会让 setLayout 抛错）', () => {
    const known = new Map(ALL_SPECS.map((spec) => [spec.id, Object.keys(spec.panels).sort()]));

    for (const preset of LAYOUT_PRESETS) {
      expect(Object.keys(preset.groups).length).toBeGreaterThan(0);
      for (const [id, panels] of Object.entries(preset.groups)) {
        expect(known.get(id), `预设 ${preset.id} 引用了未知分组 ${id}`).toBeDefined();
        expect(Object.keys(panels).sort()).toEqual(known.get(id));
        expect(sum(panels)).toBeCloseTo(100, 5);
      }
    }
  });

  it('应用预设只动它列出的组，并把结果写进布局记忆', () => {
    const applied: LayoutPanels[] = [];
    const unregister = registerLayoutGroup(SHELL_LAYOUT.id, (panels) => {
      applied.push(panels);
      return { ...panels };
    });

    applyLayoutPreset(presetById('screen'));

    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual(presetById('screen').groups[SHELL_LAYOUT.id]);
    expect(JSON.parse(localStorage.getItem(layoutStorageKey(SHELL_LAYOUT.id)) ?? 'null')).toEqual(applied[0]);

    unregister();
    localStorage.clear();
  });

  it('没挂载的组（例如关掉的独立窗口）被跳过，不抛错', () => {
    expect(() => applyLayoutPanels(SCREEN_LAYOUT.id, SCREEN_LAYOUT.panels)).not.toThrow();
  });

  it('注销后不再被预设影响', () => {
    const apply = vi.fn(() => ({ ...SHELL_LAYOUT.panels }));
    const unregister = registerLayoutGroup(SHELL_LAYOUT.id, apply);
    unregister();
    applyLayoutPreset(presetById('graph'));
    expect(apply).not.toHaveBeenCalled();
    localStorage.clear();
  });

  it('恢复默认布局 = 应用第一个预设（均衡）', () => {
    const applied: LayoutPanels[] = [];
    const unregister = registerLayoutGroup(RIGHT_LAYOUT.id, (panels) => {
      applied.push(panels);
      return { ...panels };
    });

    resetLayouts();

    expect(applied[0]).toEqual(LAYOUT_PRESETS[0]?.groups[RIGHT_LAYOUT.id]);
    unregister();
    localStorage.clear();
  });

  it('算不出比例（空布局）时不写记忆：写进去会让下次启动读到 {} 然后崩', () => {
    const unregister = registerLayoutGroup(SHELL_LAYOUT.id, () => ({}));
    applyLayoutPanels(SHELL_LAYOUT.id, SHELL_LAYOUT.panels);
    expect(localStorage.getItem(layoutStorageKey(SHELL_LAYOUT.id))).toBeNull();
    unregister();
  });
});

describe('布局记忆', () => {
  it('localStorage 写失败（隐私模式/配额满）不影响界面', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => rememberLayout(SHELL_LAYOUT.id, SHELL_LAYOUT.panels)).not.toThrow();
    spy.mockRestore();
  });

  it('存储 key 与库内部一致（库用的是 react-resizable-panels:<id>）', () => {
    expect(layoutStorageKey('gamepilot.layout.v1')).toBe('react-resizable-panels:gamepilot.layout.v1');
  });
});
