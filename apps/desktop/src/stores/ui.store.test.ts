import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEventStore } from '@/stores/event.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import { useDeviceStore } from '@/stores/device.store';
import type { RecordDraft } from '@/types';

const DEVICE = 'android:3387980';

describe('录制状态机', () => {
  beforeEach(() => {
    useUiStore.setState({ recordMode: 'off', draft: null, devicePopoverOpen: false, sequence: 1 });
    useDeviceStore.setState({ devices: [], activeId: DEVICE, gridView: false });
    useEventStore.setState({ events: {}, filter: 'all', seq: 0 });
    useSessionStore.setState({ frames: {}, running: {}, ready: {}, connectingPhase: {}, error: null });
  });

  it('点录制在 off 与 marquee 之间切换，并清掉未确认的草稿', () => {
    expect(useUiStore.getState().recordMode).toBe('off');

    useUiStore.getState().toggleRecording();
    expect(useUiStore.getState().recordMode).toBe('marquee');

    useUiStore.getState().beginDraft({ rect: [0.1, 0.2, 0.3, 0.1], score: 0.9 });
    expect(useUiStore.getState().draft).not.toBeNull();

    useUiStore.getState().toggleRecording();
    expect(useUiStore.getState().recordMode).toBe('off');
    expect(useUiStore.getState().draft).toBeNull();
  });

  it('beginDraft 用约定默认值（阈值 0.82、默认当作状态判定）', () => {
    useUiStore.getState().beginDraft({ rect: [0.4, 0.4, 0.2, 0.1], score: 0.93 });
    const current = useUiStore.getState().draft;

    expect(current?.threshold).toBe(0.82);
    expect(current?.asEnter).toBe(true);
    expect(current?.asActionTarget).toBe(true);
    expect(current?.targetMode).toBe('new');
    expect(current?.score).toBe(0.93);
  });

  it('没连设备时确认录制：不改数据、保留草稿、并在事件里说明原因', () => {
    useUiStore.getState().beginDraft({ rect: [0.4, 0.4, 0.2, 0.1], score: 0.93 });
    useUiStore.getState().commitDraft();

    // 草稿留着，用户可以去连设备后重试
    expect(useUiStore.getState().draft).not.toBeNull();
    const events = useEventStore.getState().events[DEVICE] ?? [];
    expect(events.at(-1)?.type).toBe('error');
    expect(events.at(-1)?.message).toContain('先连接设备');
  });

  it('连上设备后确认录制：交给引擎裁剪落盘（不再本地假保存）', () => {
    const record = vi
      .fn<(deviceId: string, draft: RecordDraft) => Promise<void>>()
      .mockResolvedValue(undefined);
    useSessionStore.setState({ ready: { [DEVICE]: true } });
    useSessionStore.setState({ record });

    useUiStore.getState().beginDraft({ rect: [0.4, 0.4, 0.2, 0.1], score: 0.93 });
    useUiStore.getState().updateDraft({ label: 'main_start' });
    useUiStore.getState().commitDraft();

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toBe(DEVICE);
    expect(record.mock.calls[0]?.[1]?.label).toBe('main_start');
    // 草稿确认后清空，录制模式保持（方便连续录多个元素）
    expect(useUiStore.getState().draft).toBeNull();
  });

  it('cancelDraft 什么也不做，只清草稿', () => {
    useUiStore.getState().beginDraft({ rect: [0.1, 0.1, 0.1, 0.1], score: 0.9 });
    useUiStore.getState().cancelDraft();

    expect(useUiStore.getState().draft).toBeNull();
    expect(useEventStore.getState().events[DEVICE] ?? []).toHaveLength(0);
  });

  it('草稿字段可被逐项修改（模板名 / 阈值 / 归属）', () => {
    useUiStore.getState().beginDraft({ rect: [0.4, 0.4, 0.2, 0.1], score: 0.6 });

    useUiStore
      .getState()
      .updateDraft({ label: 'hp_bar', threshold: 0.7, targetMode: 'existing', targetNodeId: 'main' });

    const current = useUiStore.getState().draft;
    expect(current?.label).toBe('hp_bar');
    expect(current?.threshold).toBe(0.7);
    expect(current?.targetMode).toBe('existing');
    expect(current?.targetNodeId).toBe('main');
  });
});

describe('草稿与设备的联动', () => {
  beforeEach(() => {
    useUiStore.setState({ recordMode: 'off', draft: null, sequence: 1 });
    useDeviceStore.setState({ devices: [], activeId: '', gridView: false });
  });

  it('没有活动设备时确认录制不抛异常，也不写事件到空设备', () => {
    useUiStore.getState().beginDraft({ rect: [0.1, 0.1, 0.1, 0.1], score: 0.9 });
    expect(() => useUiStore.getState().commitDraft()).not.toThrow();
    expect(useUiStore.getState().draft).not.toBeNull();
  });
});

describe('中间区域的 IDE 式标签（打开过的状态图）', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ openGraphs: [] });
  });

  it('打开一张多一个标签，按打开顺序排；重复打开只激活、不重复加也不重排', () => {
    useUiStore.getState().openGraph('/p/甲/斗技');
    useUiStore.getState().openGraph('/p/甲/百鬼');
    expect(useUiStore.getState().openGraphs).toEqual(['/p/甲/斗技', '/p/甲/百鬼']);

    useUiStore.getState().openGraph('/p/甲/斗技');
    expect(useUiStore.getState().openGraphs).toEqual(['/p/甲/斗技', '/p/甲/百鬼']);
  });

  it('空 root 不进标签条（project 还没就绪时不该冒出一个空标签）', () => {
    useUiStore.getState().openGraph('');
    expect(useUiStore.getState().openGraphs).toEqual([]);
  });

  it('关标签只从列表里移除；关一个没开过的等于什么都没做', () => {
    useUiStore.getState().openGraph('/p/甲/斗技');
    useUiStore.getState().openGraph('/p/甲/百鬼');

    useUiStore.getState().closeGraph('/p/甲/斗技');
    expect(useUiStore.getState().openGraphs).toEqual(['/p/甲/百鬼']);

    useUiStore.getState().closeGraph('/p/不存在');
    expect(useUiStore.getState().openGraphs).toEqual(['/p/甲/百鬼']);
  });

  it('标签落 localStorage：重开应用时上次开着的那几张还在', () => {
    useUiStore.getState().openGraph('/p/甲/斗技');
    const saved = window.localStorage.getItem('gamepilot.open-graphs');
    expect(JSON.parse(saved ?? 'null')).toEqual(['/p/甲/斗技']);

    useUiStore.getState().closeGraph('/p/甲/斗技');
    expect(JSON.parse(window.localStorage.getItem('gamepilot.open-graphs') ?? 'null')).toEqual([]);
  });
});
