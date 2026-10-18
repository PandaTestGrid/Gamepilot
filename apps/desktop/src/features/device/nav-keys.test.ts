import { describe, expect, it } from 'vitest';

import { navKeysFor, powerKeyFor } from '@/features/device/nav-keys';

describe('投屏下面那条：导航键（按平台）', () => {
  it('Android / 模拟器：三大金刚（电源不在这条里，它在面板头）', () => {
    expect(navKeysFor('android').map((item) => item.id)).toEqual(['back', 'home', 'recents']);
    expect(navKeysFor('emulator').map((item) => item.id)).toEqual(['back', 'home', 'recents']);
    expect(navKeysFor('android').map((item) => item.id)).not.toContain('power');
    expect(navKeysFor('android').find((item) => item.id === 'home')?.label).toBe('桌面');
  });

  it('iOS：只有主页（引擎把 back/recents 都映射成 Home，界面不能照搬 Android）', () => {
    const keys = navKeysFor('ios');

    expect(keys.map((item) => item.id)).toEqual(['home']);
    expect(keys[0]?.label).toBe('主页');
  });

  it('macOS 本机窗口（引擎报成 windows）：一条都没有，点了必然报不支持', () => {
    expect(navKeysFor('windows')).toEqual([]);
  });

  it('remote 等未知来源：三大金刚都给', () => {
    expect(navKeysFor('remote').map((item) => item.id)).toEqual(['back', 'home', 'recents']);
  });

  it('每个键都有 label 和 hint（按钮不能只有图标）', () => {
    for (const kind of ['android', 'ios', 'remote'] as const) {
      for (const item of navKeysFor(kind)) {
        expect(item.label.length).toBeGreaterThan(0);
        expect(item.hint.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('面板头那颗电源键', () => {
  it('Android / iOS / remote 都有电源键，只是文案不同（iOS 是侧边按钮）', () => {
    expect(powerKeyFor('android')?.id).toBe('power');
    expect(powerKeyFor('ios')?.hint).toContain('侧边按钮');
    expect(powerKeyFor('remote')?.label).toBe('电源');
  });

  it('macOS 本机窗口没有：MAC_KEYS 里没有 power', () => {
    expect(powerKeyFor('windows')).toBeNull();
  });
});
