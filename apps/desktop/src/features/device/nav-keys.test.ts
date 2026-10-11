import { describe, expect, it } from 'vitest';

import { navKeysFor } from '@/features/device/nav-keys';

describe('每台设备有哪些实体导航键', () => {
  it('Android / 模拟器：三大金刚 + 电源', () => {
    expect(navKeysFor('android').map((item) => item.id)).toEqual(['back', 'home', 'recents', 'power']);
    expect(navKeysFor('emulator').map((item) => item.id)).toEqual(['back', 'home', 'recents', 'power']);
    expect(navKeysFor('android')[1]?.label).toBe('桌面');
  });

  it('iOS：只有主页 + 电源（引擎把 back/recents 都映射成 Home，界面不能照搬 Android）', () => {
    const keys = navKeysFor('ios');

    expect(keys.map((item) => item.id)).toEqual(['home', 'power']);
    expect(keys[0]?.label).toBe('主页');
    expect(keys.map((item) => item.id)).not.toContain('back');
    expect(keys.map((item) => item.id)).not.toContain('recents');
  });

  it('macOS 本机窗口（引擎报成 windows）：一个都不给，点了必然报不支持', () => {
    expect(navKeysFor('windows')).toEqual([]);
  });

  it('mock / 未知来源：四个都留着（报错文案是明确的，别悄悄藏按钮）', () => {
    expect(navKeysFor('mock').map((item) => item.id)).toEqual(['back', 'home', 'recents', 'power']);
    expect(navKeysFor('remote').map((item) => item.id)).toEqual(['back', 'home', 'recents', 'power']);
  });

  it('每个键都有 label 和 hint（按钮不能只有图标）', () => {
    for (const kind of ['android', 'ios', 'mock'] as const) {
      for (const item of navKeysFor(kind)) {
        expect(item.label.length).toBeGreaterThan(0);
        expect(item.hint.length).toBeGreaterThan(0);
      }
    }
  });
});
