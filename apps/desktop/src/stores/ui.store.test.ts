import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEventStore } from '@/stores/event.store';
import { useSessionStore } from '@/stores/session.store';
import { useUiStore } from '@/stores/ui.store';
import { useDeviceStore } from '@/stores/device.store';
import type { RecordDraft } from '@/types';

const DEVICE = 'android:3387980';
/** 录制要落盘进当前工作流。 */
const WORKFLOW = '/p/甲/斗技';
const PROJECT = {
  root: WORKFLOW,
  graphPath: `${WORKFLOW}/graph.json`,
  nodes: 0,
  edges: 0,
  recognizers: 0,
  templates: 0,
};

describe('录制状态机', () => {
  beforeEach(() => {
    useUiStore.setState({ recordMode: 'off', draft: null, devicePopoverOpen: false, sequence: 1 });
    useDeviceStore.setState({ devices: [], activeId: DEVICE, gridView: false });
    useEventStore.setState({ events: {}, filter: 'all', seq: 0 });
    useSessionStore.setState({
      frames: {},
      running: {},
      ready: {},
      connectingPhase: {},
      error: null,
      currentWorkflow: PROJECT,
    });
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

  it('没有当前工作流时点录制：不进录制模式，错误条指路', () => {
    useSessionStore.setState({ currentWorkflow: null });

    useUiStore.getState().toggleRecording();

    expect(useUiStore.getState().recordMode).toBe('off');
    expect(useSessionStore.getState().error).toContain('还没有工作流');
  });

  it('没有当前工作流时确认录制：不调引擎、保留草稿、错误条指路', () => {
    const record = vi
      .fn<(deviceId: string, draft: RecordDraft) => Promise<void>>()
      .mockResolvedValue(undefined);
    useSessionStore.setState({ ready: { [DEVICE]: true }, currentWorkflow: null, record });

    useUiStore.getState().beginDraft({ rect: [0.4, 0.4, 0.2, 0.1], score: 0.93 });
    useUiStore.getState().commitDraft();

    expect(record).not.toHaveBeenCalled();
    // 草稿留着：建完工作流直接点确定就行
    expect(useUiStore.getState().draft).not.toBeNull();
    expect(useSessionStore.getState().error).toContain('还没有工作流');
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

  it('cancelCaptureTools 关掉框选/点选/录操作，并清掉未确认草稿', () => {
    useUiStore.getState().setRecordMode('marquee');
    useUiStore.getState().beginDraft({ rect: [0.1, 0.1, 0.1, 0.1], score: 0.9 });
    useUiStore.getState().cancelCaptureTools();

    expect(useUiStore.getState().recordMode).toBe('off');
    expect(useUiStore.getState().recordActionMode).toBe(false);
    expect(useUiStore.getState().draft).toBeNull();

    useUiStore.getState().toggleRecordAction();
    expect(useUiStore.getState().recordActionMode).toBe(true);
    useUiStore.getState().cancelCaptureTools();
    expect(useUiStore.getState().recordActionMode).toBe(false);
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
  it('点选模式下 setPickSize 按设备分辨率重算像素正方形（竖屏不会变细长条）', () => {
    useUiStore.setState({ recordMode: 'pick', pickSize: 120 });
    useUiStore.getState().beginDraft({
      rect: [0.4, 0.45, 0.2, 0.1],
      resolution: [600, 1200],
      score: 0.95,
      mode: 'pick',
      pickCenter: [0.5, 0.5],
    });

    expect(useUiStore.getState().draft?.mode).toBe('pick');
    expect(useUiStore.getState().draft?.rect).toEqual([0.4, 0.45, 0.2, 0.1]);

    useUiStore.getState().setPickSize(160);
    expect(useUiStore.getState().pickSize).toBe(160);
    expect(useUiStore.getState().draft?.rect[2]).toBeCloseTo(160 / 600);
    expect(useUiStore.getState().draft?.rect[3]).toBeCloseTo(160 / 1200);
    expect(useUiStore.getState().draft?.rect[0]).toBeCloseTo(0.5 - 80 / 600);
    expect(useUiStore.getState().draft?.rect[1]).toBeCloseTo(0.5 - 80 / 1200);
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

describe('中间区域的 IDE 式标签（打开过的工作流）', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ openWorkflowTabs: [] });
  });

  it('打开一张多一个标签，按打开顺序排；重复打开只激活、不重复加也不重排', () => {
    useUiStore.getState().openWorkflowTab('/p/甲/斗技');
    useUiStore.getState().openWorkflowTab('/p/甲/百鬼');
    expect(useUiStore.getState().openWorkflowTabs).toEqual(['/p/甲/斗技', '/p/甲/百鬼']);

    useUiStore.getState().openWorkflowTab('/p/甲/斗技');
    expect(useUiStore.getState().openWorkflowTabs).toEqual(['/p/甲/斗技', '/p/甲/百鬼']);
  });

  it('空 root 不进标签条（project 还没就绪时不该冒出一个空标签）', () => {
    useUiStore.getState().openWorkflowTab('');
    expect(useUiStore.getState().openWorkflowTabs).toEqual([]);
  });

  it('关标签只从列表里移除；关一个没开过的等于什么都没做', () => {
    useUiStore.getState().openWorkflowTab('/p/甲/斗技');
    useUiStore.getState().openWorkflowTab('/p/甲/百鬼');

    useUiStore.getState().closeWorkflowTab('/p/甲/斗技');
    expect(useUiStore.getState().openWorkflowTabs).toEqual(['/p/甲/百鬼']);

    useUiStore.getState().closeWorkflowTab('/p/不存在');
    expect(useUiStore.getState().openWorkflowTabs).toEqual(['/p/甲/百鬼']);
  });

  it('剪掉「已经不在工作区树里」的标签（只认具体工作流路径，不按工作区前缀整包保留）', () => {
    useUiStore.setState({
      openWorkflowTabs: ['/p/甲/斗技', '/p/甲/百鬼', 'C:\\Temp\\gone\\行为树录制', '/p/乙/跑图'],
    });

    // 树里只剩斗技：百鬼虽在同一工作区下，也必须剪掉，否则点标签会把目录建回来
    useUiStore.getState().pruneOpenWorkflowTabs(['/p/甲/斗技']);
    expect(useUiStore.getState().openWorkflowTabs).toEqual(['/p/甲/斗技']);
    expect(JSON.parse(window.localStorage.getItem('gamepilot.open-workflow-tabs') ?? 'null')).toEqual([
      '/p/甲/斗技',
    ]);
  });

  it('没有已知根时什么都不剪（引擎还没起来，别把标签全清了）', () => {
    useUiStore.setState({ openWorkflowTabs: ['/p/甲/斗技'] });
    useUiStore.getState().pruneOpenWorkflowTabs([]);
    expect(useUiStore.getState().openWorkflowTabs).toEqual(['/p/甲/斗技']);
  });

  it('clearOpenWorkflowTabs 清空标签与 localStorage', () => {
    useUiStore.setState({ openWorkflowTabs: ['/p/甲/斗技'], workflowSplitOpen: true });
    useUiStore.getState().clearOpenWorkflowTabs();
    expect(useUiStore.getState().openWorkflowTabs).toEqual([]);
    expect(useUiStore.getState().workflowSplitOpen).toBe(false);
    expect(JSON.parse(window.localStorage.getItem('gamepilot.open-workflow-tabs') ?? 'null')).toEqual([]);
  });

  it('标签落 localStorage：重开应用时上次开着的那几张还在', () => {
    useUiStore.getState().openWorkflowTab('/p/甲/斗技');
    const saved = window.localStorage.getItem('gamepilot.open-workflow-tabs');
    expect(JSON.parse(saved ?? 'null')).toEqual(['/p/甲/斗技']);

    useUiStore.getState().closeWorkflowTab('/p/甲/斗技');
    expect(JSON.parse(window.localStorage.getItem('gamepilot.open-workflow-tabs') ?? 'null')).toEqual([]);
  });
});

describe('文字识别（OCR）入口', () => {
  beforeEach(() => {
    useUiStore.setState({
      recordMode: 'off',
      recordKind: 'template',
      draft: null,
      devicePopoverOpen: false,
      pendingFlowRecStepId: null,
      pendingFlowRecSlot: null,
    });
    useDeviceStore.setState({ devices: [], activeId: DEVICE, gridView: false });
    useEventStore.setState({ events: {}, filter: 'all', seq: 0 });
    useSessionStore.setState({
      frames: {},
      running: {},
      ready: {},
      connectingPhase: {},
      error: null,
      currentWorkflow: PROJECT,
    });
  });

  it('没有当前工作流时只提示，不切到 OCR 框选', () => {
    useSessionStore.setState({ currentWorkflow: null });

    useUiStore.getState().beginOcrRecognizerCapture();

    expect(useUiStore.getState().recordKind).toBe('template');
    expect(useUiStore.getState().recordMode).toBe('off');
    expect(useSessionStore.getState().error).toContain('还没有工作流');
  });

  it('设备没连上时打开设备面板并提示先连接', () => {
    useUiStore.getState().beginOcrRecognizerCapture();

    expect(useUiStore.getState().recordMode).toBe('off');
    expect(useUiStore.getState().recordKind).toBe('template');
    expect(useUiStore.getState().devicePopoverOpen).toBe(true);
    expect(useSessionStore.getState().error).toContain('文字识别需先连接设备');
  });

  it('连接后进入框选；框出来的草稿按 OCR 表单落地（阈值 0.6、带文字）', () => {
    useSessionStore.setState({ ready: { [DEVICE]: true } });

    useUiStore.getState().beginOcrRecognizerCapture();
    expect(useUiStore.getState().recordKind).toBe('ocr');
    expect(useUiStore.getState().recordMode).toBe('marquee');
    expect(useUiStore.getState().materialOpen).toBe(true);

    useUiStore.getState().beginDraft({ rect: [0.1, 0.1, 0.2, 0.1], score: 0.9, text: '金币' });
    const draft = useUiStore.getState().draft;
    expect(draft?.kind).toBe('ocr');
    expect(draft?.text).toBe('金币');
    expect(draft?.threshold).toBeCloseTo(0.6);
    expect(draft?.ocrMode).toBe('contains');
  });

  it('从条件槽位进来时记下待填步骤与槽位', () => {
    useSessionStore.setState({ ready: { [DEVICE]: true } });

    useUiStore.getState().beginOcrRecognizerCapture({
      stepId: 'step_1',
      slot: { groupIndex: 0, rowIndex: 1 },
    });

    expect(useUiStore.getState().pendingFlowRecStepId).toBe('step_1');
    expect(useUiStore.getState().pendingFlowRecSlot).toEqual({ groupIndex: 0, rowIndex: 1 });
  });

  it('退出框选后种类回到图像模板，不会把下一次框选也当成 OCR', () => {
    useSessionStore.setState({ ready: { [DEVICE]: true } });
    useUiStore.getState().beginOcrRecognizerCapture();
    expect(useUiStore.getState().recordKind).toBe('ocr');

    useUiStore.getState().setRecordMode('off');
    expect(useUiStore.getState().recordKind).toBe('template');
  });
});
