import { describe, expect, it } from 'vitest';

import {
  CLICK_TARGET_MODE_OPTIONS,
  clickEventKind,
  clickEventPatch,
  clickSelectValue,
  clickTargetMode,
  formatClickCoordSummary,
  mergeClickTargetParams,
} from '@/features/graph/flow/flow-click-params';
import { mergeStepParams } from '@/lib/merge-step-params';
import { delayMsOf, normalizeDelayMs } from '@/features/graph/flow/flow-delay-params';
import {
  defaultKeyForPlatform,
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
  it('新建点击节点默认是图像方式，下拉前两项是图像识别 / AI 识别', () => {
    const click = FLOW_MODULE_GROUPS.flatMap((group) => group.items).find((item) => item.type === 'click');
    expect(click?.defaultParams).toEqual({ by: 'recognizer', event: 'click', rec: '' });
    expect(CLICK_TARGET_MODE_OPTIONS.map((item) => item.value)).toEqual([
      'image',
      'ai',
      'coord',
      'region',
    ]);
    expect(CLICK_TARGET_MODE_OPTIONS[0]).toEqual({ value: 'image', label: '图像识别' });
    expect(CLICK_TARGET_MODE_OPTIONS[1]).toEqual({ value: 'ai', label: 'AI 识别' });
  });
});

describe('图像识别 / AI 识别细分', () => {
  it('图像与 AI 都写 by=recognizer，只有 ai 标记区分', () => {
    const image = mergeClickTargetParams({}, 'recognizer', 'image');
    expect(image.by).toBe('recognizer');
    expect(image.ai).toBeUndefined();
    const ai = mergeClickTargetParams({}, 'recognizer', 'ai');
    expect(ai.by).toBe('recognizer');
    expect(ai.ai).toBe(true);
    expect(clickSelectValue(ai)).toBe('ai');
    expect(clickSelectValue(image)).toBe('image');
  });

  it('旧图没有 ai 字段时按识别器类型推断，切到坐标点会清掉 ai 标记', () => {
    expect(clickSelectValue({ by: 'recognizer', rec: 'x' }, 'yolo')).toBe('ai');
    expect(clickSelectValue({ by: 'recognizer', rec: 'x' }, 'template')).toBe('image');
    expect(clickSelectValue({ by: 'recognizer', rec: 'x' })).toBe('image');
    const coord = mergeClickTargetParams({ by: 'recognizer', ai: true, rec: 'x' }, 'coord', 'ai');
    expect(coord.ai).toBeUndefined();
    expect(coord.by).toBe('coord');
    expect(clickSelectValue({ by: 'coord', x: 0.1, y: 0.2 })).toBe('coord');
  });
});

describe('clickTargetMode & clickEventKind', () => {
  it('默认识别为坐标 + 单击', () => {
    expect(clickTargetMode({ by: 'coord', x: 0.1, y: 0.2 })).toBe('coord');
    expect(clickEventKind({ by: 'coord', x: 0.1, y: 0.2 })).toBe('click');
  });

  it('只有缺省 by 才按字段推断，显式协议值优先', () => {
    const rect = [0, 0, 0.2, 0.2];
    expect(clickTargetMode(undefined)).toBe('coord');
    expect(clickTargetMode({ rect })).toBe('region');
    expect(clickTargetMode({ rec: '按钮' })).toBe('recognizer');
    expect(clickTargetMode({ rec: '按钮', rect })).toBe('recognizer');
    expect(clickTargetMode({ rec: '', rect })).toBe('region');
    expect(clickTargetMode({ by: 'coord', rect, rec: '按钮' })).toBe('coord');
    expect(clickTargetMode({ by: 'recognizer', rect })).toBe('recognizer');
    expect(clickTargetMode({ by: 'region', rec: '按钮' })).toBe('region');
  });

  it.each(['识别器', '坐标', '随机范围', 'unknown', '', null, 42])(
    '不接纳显式无效 by=%s，也不按残留字段推断',
    (by) => {
      const params = { by, rec: '按钮', rect: [0, 0, 0.2, 0.2], x: 0.1, y: 0.2 };
      expect(clickTargetMode(params)).toBeNull();
      expect(formatClickCoordSummary(params)).toBe('无效点击方式');
      expect(flowStepTitle({ id: 's', type: 'click', params })).toBe('点击 · 无效点击方式');
    },
  );

  it('随机范围模式', () => {
    expect(clickTargetMode({ by: 'region', rect: [0, 0, 0.2, 0.2] })).toBe('region');
    expect(formatClickCoordSummary({ by: 'region', rect: [0.1, 0.2, 0.3, 0.4] })).toMatch(/随机/);
  });

  it('mergeClickTargetParams 切换方式时清掉残留字段', () => {
    const region = mergeClickTargetParams({ by: 'coord', x: 0.5, y: 0.5 }, 'region');
    expect(region.by).toBe('region');
    expect(region.x).toBeUndefined();
    expect(region.rect).toBeUndefined();
    const coord = mergeClickTargetParams({ by: 'region', rect: [0, 0, 0.2, 0.2] }, 'coord');
    expect(coord.rect).toBeUndefined();
    expect(coord.x).toBeCloseTo(0.1);
    expect(coord.y).toBeCloseTo(0.1);
  });

  it('合并后写入步骤会清掉 rect，且 by=coord 时界面为坐标模式', () => {
    const prev = { by: 'region', rect: [0, 0, 0.2, 0.2] as const, x: 0.1, y: 0.1 };
    const merged = mergeStepParams(prev, mergeClickTargetParams(prev, 'coord'));
    expect(merged.by).toBe('coord');
    expect(merged.rect).toBeUndefined();
    expect(clickTargetMode(merged)).toBe('coord');
  });

  it('识别器模式 + 双击 / 长按事件', () => {
    expect(clickTargetMode({ by: 'recognizer', rec: '按钮' })).toBe('recognizer');
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
    expect(flowStepTitle({ id: 's', type: 'click', params: { by: 'coord', x: 0.25, y: 0.75 } })).toBe(
      '点击 · 0.25, 0.75',
    );
    expect(
      flowStepTitle({
        id: 's',
        type: 'click',
        params: { by: 'coord', event: 'double_click', x: 0.25, y: 0.75 },
      }),
    ).toBe('双击 · 0.25, 0.75');
    expect(
      flowStepTitle({
        id: 's',
        type: 'click',
        params: { by: 'coord', event: 'long_press', x: 0.5, y: 0.5, duration_ms: 800 },
      }),
    ).toBe('长按 · 0.50, 0.50 · 800ms');
  });

  it('图像模式显示识别器名', () => {
    expect(flowStepTitle({ id: 's', type: 'click', params: { by: 'recognizer', rec: '开始按钮' } })).toBe(
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
  it('区分 Android / 模拟器 / iOS / Windows 按键集合', () => {
    expect(supportsKeyModule('android')).toBe(true);
    expect(supportsKeyModule('emulator')).toBe(true);
    expect(supportsKeyModule('ios')).toBe(true);
    expect(supportsKeyModule('windows')).toBe(true);

    expect(keysForPlatform('emulator').map((k) => k.id)).toEqual(['back', 'home', 'recents']);
    expect(keysForPlatform('ios').map((k) => k.id)).toEqual(['home', 'power', 'volume_up', 'volume_down']);
    expect(
      keysForPlatform('windows')
        .slice(0, 9)
        .map((k) => k.id),
    ).toEqual(['w', 'a', 's', 'd', 'space', 'shift', 'ctrl', 'enter', 'escape']);
    expect(keysForPlatform('windows').some((k) => k.id === 'f12')).toBe(true);
    expect(defaultKeyForPlatform('windows')).toBe('space');
    expect(normalizeKeyForPlatform('back', 'ios')).toBe('home');
    expect(normalizeKeyForPlatform('W', 'windows')).toBe('w');
    expect(resolveKeyPlatform({}, 'ios')).toBe('ios');
    expect(resolveKeyPlatform({}, 'windows')).toBe('windows');
    expect(resolveKeyPlatform({ platform: 'emulator' }, 'android')).toBe('emulator');
  });

  it('Windows 设备下也显示按键模块并默认空格键', () => {
    const winKey = flowModuleGroupsForDevice('windows')
      .flatMap((g) => g.items)
      .find((item) => item.type === 'key');
    expect(winKey?.defaultParams).toEqual({ value: 'space', platform: 'windows' });

    const iosKey = flowModuleGroupsForDevice('ios')
      .flatMap((g) => g.items)
      .find((item) => item.type === 'key');
    expect(iosKey?.defaultParams).toEqual({ value: 'home', platform: 'ios' });
  });
});
