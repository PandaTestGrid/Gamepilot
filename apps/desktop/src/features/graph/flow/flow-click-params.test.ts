import { describe, expect, it } from 'vitest';

import {
  CLICK_TARGET_MODE_OPTIONS,
  clickEventKind,
  clickEventPatch,
  clickTargetMode,
  formatClickCoordSummary,
  mergeClickTargetParams,
} from '@/features/graph/flow/flow-click-params';
import { mergeStepParams } from '@/lib/merge-step-params';
import { delayMsOf, normalizeDelayMs } from '@/features/graph/flow/flow-delay-params';
import {
  keysForPlatform,
  normalizeKeyForPlatform,
  resolveKeyPlatform,
  supportsKeyModule,
} from '@/features/graph/flow/flow-key-params';
import {
  FLOW_MODULE_GROUPS,
  flowModuleGroupsForDevice,
  flowStepTitle,
} from '@/features/graph/flow/flow-step-meta';

describe('点击模块默认图像', () => {
  it('新建点击节点默认是图像方式，下拉第一项也是图像', () => {
    const click = FLOW_MODULE_GROUPS.flatMap((group) => group.items).find((item) => item.type === 'click');
    expect(click?.defaultParams).toEqual({ by: '识别器', event: 'click', rec: '' });
    expect(CLICK_TARGET_MODE_OPTIONS[0]).toEqual({ id: 'recognizer', label: '图像' });
  });
});

describe('clickTargetMode & clickEventKind', () => {
  it('默认识别为坐标 + 单击', () => {
    expect(clickTargetMode({ by: '坐标', x: 0.1, y: 0.2 })).toBe('coord');
    expect(clickEventKind({ by: '坐标', x: 0.1, y: 0.2 })).toBe('click');
  });

  it('随机范围模式', () => {
    expect(clickTargetMode({ by: '随机范围', rect: [0, 0, 0.2, 0.2] })).toBe('region');
    expect(formatClickCoordSummary({ by: '随机范围', rect: [0.1, 0.2, 0.3, 0.4] })).toMatch(/随机/);
  });

  it('mergeClickTargetParams 切换方式时清掉残留字段', () => {
    const region = mergeClickTargetParams({ by: '坐标', x: 0.5, y: 0.5 }, 'region');
    expect(region.by).toBe('随机范围');
    expect(region.x).toBeUndefined();
    expect(region.rect).toBeUndefined();
    const coord = mergeClickTargetParams({ by: '随机范围', rect: [0, 0, 0.2, 0.2] }, 'coord');
    expect(coord.rect).toBeUndefined();
    expect(coord.x).toBeCloseTo(0.1);
    expect(coord.y).toBeCloseTo(0.1);
  });

  it('合并后写入步骤会清掉 rect，且 by=坐标 时界面为坐标模式', () => {
    const prev = { by: '随机范围', rect: [0, 0, 0.2, 0.2] as const, x: 0.1, y: 0.1 };
    const merged = mergeStepParams(prev, mergeClickTargetParams(prev, 'coord'));
    expect(merged.by).toBe('坐标');
    expect(merged.rect).toBeUndefined();
    expect(clickTargetMode(merged)).toBe('coord');
  });

  it('识别器模式 + 双击 / 长按事件', () => {
    expect(clickTargetMode({ by: '识别器', rec: '按钮' })).toBe('recognizer');
    expect(clickEventKind({ event: 'double_click' })).toBe('double_click');
    expect(clickEventKind({ event: 'long_press' })).toBe('long_press');
    expect(clickEventKind({}, 'hold')).toBe('long_press');
  });

  it('切换到长按时默认补齐 duration_ms', () => {
    expect(clickEventPatch('long_press', {})).toEqual({
      event: 'long_press',
      duration_ms: 600,
    });
    expect(clickEventPatch('double_click', { duration_ms: 800 })).toEqual({
      event: 'double_click',
    });
  });
});

describe('flowStepTitle click / delay / key', () => {
  it('坐标模式显示归一化坐标与点击事件', () => {
    expect(flowStepTitle({ id: 's', type: 'click', params: { by: '坐标', x: 0.25, y: 0.75 } })).toBe(
      '点击 · 0.25, 0.75',
    );
    expect(
      flowStepTitle({
        id: 's',
        type: 'click',
        params: { by: '坐标', event: 'double_click', x: 0.25, y: 0.75 },
      }),
    ).toBe('双击 · 0.25, 0.75');
    expect(
      flowStepTitle({
        id: 's',
        type: 'click',
        params: { by: '坐标', event: 'long_press', x: 0.5, y: 0.5, duration_ms: 800 },
      }),
    ).toBe('长按 · 0.50, 0.50 · 800ms');
  });

  it('图像模式显示识别器名', () => {
    expect(flowStepTitle({ id: 's', type: 'click', params: { by: '识别器', rec: '开始按钮' } })).toBe(
      '点击 · 开始按钮',
    );
  });

  it('延时与按键标题显示中文含义', () => {
    expect(flowStepTitle({ id: 'd', type: 'delay', params: { ms: 1200 } })).toBe('延时 · 1200ms');
    expect(flowStepTitle({ id: 'k1', type: 'key', params: { value: 'back' } })).toBe('按键 · 返回');
    expect(flowStepTitle({ id: 'k2', type: 'key', params: { value: 'home' } })).toBe('按键 · 主页');
    expect(flowStepTitle({ id: 'k3', type: 'key', params: { value: 'recents' } })).toBe('按键 · 最近任务');
  });

  it('输入文字与调用工作流标题带上当前值', () => {
    expect(flowStepTitle({ id: 't', type: 'text', params: { value: '  你好' } })).toBe('输入文字 · 你好');
    expect(flowStepTitle({ id: 'c', type: 'call', params: { name: '百鬼夜行' } })).toBe(
      '调用工作流 · 百鬼夜行',
    );
  });
});

describe('formatClickCoordSummary', () => {
  it('保留两位小数', () => {
    expect(formatClickCoordSummary({ x: 0.5, y: 0.333 })).toBe('0.50, 0.33');
  });
});

describe('flow-delay-params', () => {
  it('规整毫秒值', () => {
    expect(normalizeDelayMs('1500')).toBe(1500);
    expect(normalizeDelayMs(-10)).toBe(0);
    expect(delayMsOf({})).toBe(500);
  });
});

describe('flow-key-params & flowModuleGroupsForDevice', () => {
  it('区分 Android / 模拟器 / iOS 按键集合，Windows 无按键模块', () => {
    expect(supportsKeyModule('android')).toBe(true);
    expect(supportsKeyModule('emulator')).toBe(true);
    expect(supportsKeyModule('ios')).toBe(true);
    expect(supportsKeyModule('windows')).toBe(false);

    expect(keysForPlatform('emulator').map((k) => k.id)).toEqual(['back', 'home', 'recents']);
    expect(keysForPlatform('ios').map((k) => k.id)).toEqual(['home', 'power', 'volume_up', 'volume_down']);
    expect(normalizeKeyForPlatform('back', 'ios')).toBe('home');
    expect(resolveKeyPlatform({}, 'ios')).toBe('ios');
    expect(resolveKeyPlatform({ platform: 'emulator' }, 'android')).toBe('emulator');
  });

  it('模块目录在 Windows 设备下隐藏按键模块，在 iOS 下默认主页键', () => {
    const winItems = flowModuleGroupsForDevice('windows').flatMap((g) => g.items);
    expect(winItems.some((item) => item.type === 'key')).toBe(false);

    const iosKey = flowModuleGroupsForDevice('ios')
      .flatMap((g) => g.items)
      .find((item) => item.type === 'key');
    expect(iosKey?.defaultParams).toEqual({ value: 'home', platform: 'ios' });
  });
});
