/**
 * 步骤链模块目录（与引擎 `flow_model.STEP_KINDS` 对齐；UI 文案用我们自己的主题）。
 */
import {
  CLICK_BY_RECOGNIZER,
  clickEventKind,
  clickEventLabel,
  clickTargetMode,
  formatClickCoordSummary,
} from '@/features/graph/flow/flow-click-params';
import { condSummaryFromParams } from '@/features/graph/flow/flow-cond-params';
import { delayIsRandom, delayMsOf, randomDelayRangeOf } from '@/features/graph/flow/flow-delay-params';
import {
  defaultKeyForPlatform,
  keyValueLabel,
  resolveKeyPlatform,
  supportsKeyModule,
} from '@/features/graph/flow/flow-key-params';
import { formatSwipeSummary } from '@/features/graph/flow/flow-swipe-params';
import { selectionSummary } from '@/features/graph/flow/flow-selection';
import { formatTriggerSummary } from '@/features/graph/flow/flow-trigger-params';
import type { DeviceKind, FlowStep } from '@/types';

export const TRIGGER_TYPES = ['manual', 'schedule', 'interval'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** 与引擎 `flow_model.STEP_KINDS` 一致 */
export const FLOW_STEP_TYPES = [
  'manual',
  'schedule',
  'interval',
  'wait',
  'click',
  'hold',
  'swipe',
  'key',
  'text',
  'delay',
  'cond',
  'else',
  'condend',
  'loop',
  'loopend',
  'loopbreak',
  'end',
  'call',
  'setvar',
  'parallel',
  'parallelbranch',
  'parallelend',
  'touch',
] as const;

export function loopCountOf(params: Record<string, unknown> | undefined): number {
  const raw = params?.count;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : Number(raw);
  return n >= 1 ? n : 1;
}

export function isKnownFlowStepType(type: string): boolean {
  return (FLOW_STEP_TYPES as readonly string[]).includes(type);
}

export function isTriggerType(type: string): type is TriggerType {
  return (TRIGGER_TYPES as readonly string[]).includes(type);
}

/** 链首触发器（引擎要求第一步必须是触发器） */
export function isFlowHeadTriggerStep(step: FlowStep, index: number): boolean {
  return index === 0 && isTriggerType(step.type);
}

export function flowHeadStepId(steps: readonly FlowStep[]): string | null {
  const head = steps[0];
  return head?.id ?? null;
}

export interface PaletteModule {
  readonly type: string;
  readonly label: string;
  readonly hint: string;
  readonly defaultParams: Record<string, unknown>;
}

export const FLOW_MODULE_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly items: readonly PaletteModule[];
}> = [
  {
    label: '动作',
    items: [
      {
        type: 'click',
        label: '点击',
        hint: '点击 / 双击 / 长按 · 图像或坐标',
        defaultParams: { by: CLICK_BY_RECOGNIZER, event: 'click', rec: '' },
      },
      {
        type: 'swipe',
        label: '滑动',
        hint: '点对点 / 连续',
        defaultParams: { x: 0.5, y: 0.75, to_x: 0.5, to_y: 0.25, duration_ms: 300 },
      },
      {
        type: 'key',
        label: '按键',
        hint: '系统键（返回 / 主页 / 最近任务）',
        defaultParams: { value: 'back' },
      },
      {
        type: 'touch',
        label: '触点',
        hint: '按下 / 移动 / 松开',
        defaultParams: { phase: 'down', x: 0.5, y: 0.5 },
      },      { type: 'text', label: '输入文字', hint: 'ADB 文本', defaultParams: { value: '' } },
    ],
  },
  {
    label: '流程',
    items: [
      {
        type: 'wait',
        label: '等待界面',
        hint: '识别器命中',
        defaultParams: { rec: '', timeout_ms: 10000, stable_frames: 2 },
      },
      { type: 'delay', label: '延时', hint: '毫秒；可打开「随机」按范围等待', defaultParams: { ms: 500 } },
      {
        type: 'loop',
        label: '循环',
        hint: '两条线：进入 → 要重复的步骤；下一步 → 重复完之后',
        defaultParams: { count: 10 },
      },
      {
        type: 'loopbreak',
        label: '跳出循环',
        hint: '写在循环体内；结束后走循环的「下一步」，本模块没有出口',
        defaultParams: {},
      },
      {
        type: 'end',
        label: '结束',
        hint: '到此为止：结束本次执行，后面的步骤都不再走（写在分支末尾 = 该支直接结束）',
        defaultParams: {},
      },
      {
        type: 'cond',
        label: '条件判断',
        hint: '左端连入 · 右上「成立」· 右下「不成立」· 匹配时间默认 100ms',
        defaultParams: { rec: '', timeout_ms: 100 },
      },
      {
        type: 'parallel',
        label: '并行',
        hint: '2–4 个分支同时运行，汇合后继续',
        defaultParams: { mode: 'all', branches: 2 },
      },
      { type: 'call', label: '调用工作流', hint: '同工作区', defaultParams: { name: '' } },
      {
        type: 'setvar',
        label: '赋值',
        hint: '变量 = 值 / $表达式（如 $次数 + 1）',
        defaultParams: { name: '', value: '' },
      },
    ],
  },
];

/**
 * 按当前设备类型过滤与定制模块目录：
 * - 所有设备都显示「按键」模块；Windows 本机窗口展示游戏键盘键；
 * - iOS 默认按键为「主页」(home)，Android / 模拟器默认「返回」(back)，Windows 默认「空格」(space)。
 */
export function flowModuleGroupsForDevice(deviceKind?: DeviceKind | null): ReadonlyArray<{
  readonly label: string;
  readonly items: readonly PaletteModule[];
}> {
  const hasKey = supportsKeyModule(deviceKind);
  const keyPlatform = resolveKeyPlatform(undefined, deviceKind);
  const defaultKey = defaultKeyForPlatform(keyPlatform);
  const keyHint =
    keyPlatform === 'ios'
      ? 'iOS 系统键（主页 / 锁屏 / 音量）'
      : keyPlatform === 'emulator'
        ? '模拟器按键（返回 / 主页 / 最近任务）'
        : keyPlatform === 'windows'
          ? 'Windows 键盘（WASD / 空格 / F1-F12 等）'
          : 'Android 系统键（返回 / 主页 / 最近任务等）';

  return FLOW_MODULE_GROUPS.map((group) => ({
    ...group,
    items: group.items
      .filter((item) => (item.type === 'key' ? hasKey : true))
      .map((item) => {
        if (item.type !== 'key') {
          return item;
        }
        return {
          ...item,
          hint: keyHint,
          defaultParams: {
            value: defaultKey,
            platform: keyPlatform,
          },
        };
      }),
  })).filter((group) => group.items.length > 0);
}

const TYPE_LABEL: Record<string, string> = {
  manual: '手动触发',
  schedule: '定时触发',
  interval: '间隔触发',
  click: '点击',
  hold: '长按',
  swipe: '滑动',
  touch: '触点',  parallel: '并行',
  parallelbranch: '并行分支',
  parallelend: '并行结束',
  key: '按键',
  text: '输入文字',
  wait: '等待界面',
  delay: '延时',
  call: '调用工作流',
  cond: '条件',
  else: '否则',
  condend: '条件结束',
  loop: '循环',
  loopend: '循环结束',
  loopbreak: '跳出循环',
  end: '结束',
  setvar: '赋值',
};

export function flowStepTitle(step: FlowStep | null | undefined): string {
  if (!step?.type) {
    return '模块';
  }
  const base = TYPE_LABEL[step.type] ?? step.type;
  const params = step.params ?? {};
  if (step.type === 'manual' || step.type === 'schedule' || step.type === 'interval') {
    return formatTriggerSummary(step.type, params);
  }
  if (step.type === 'parallel')
    return `${base} · ${Number(params.branches ?? 2)} 支 · ${params.mode === 'any' ? '首个成功' : '全部完成'}`;  if (step.type === 'touch')
    return `${base} · ${params.phase === 'move' ? '移动' : params.phase === 'up' ? '松开' : '按下'}`;
  if (step.type === 'delay') {
    if (delayIsRandom(params)) {
      const range = randomDelayRangeOf(params);
      return `${base} · ${range.min}~${range.max}ms（随机）`;
    }
    return `${base} · ${delayMsOf(params)}ms`;
  }
  if (step.type === 'click' || step.type === 'hold') {
    const eventKind = clickEventKind(params, step.type);
    const actionLabel = clickEventLabel(eventKind);
    const mode = clickTargetMode(params);
    if (mode === null) {
      return `${actionLabel} · 无效点击方式`;
    }
    let target =
      mode === 'recognizer' && typeof params.rec === 'string' && params.rec
        ? params.rec
        : formatClickCoordSummary(params);
    const pick = mode === 'recognizer' ? selectionSummary(params.strategy, params.index) : '';
    if (pick) {
      target = `${target} · ${pick}`;
    }
    if (eventKind === 'long_press') {
      const durationMs = Number(params.duration_ms ?? 600) || 600;
      return `${actionLabel} · ${target} · ${durationMs}ms`;
    }
    return `${actionLabel} · ${target}`;
  }
  if (step.type === 'swipe') {
    return `${base} · ${formatSwipeSummary(params)}`;
  }
  if (step.type === 'wait' && typeof params.rec === 'string' && params.rec) {
    return `${base} · ${params.rec}`;
  }
  if (step.type === 'cond') {
    const summary = condSummaryFromParams(params);
    if (summary) {
      return `${base} · ${summary}`;
    }
  }
  if (step.type === 'loop') {
    return `${base} · ${loopCountOf(params)} 次`;
  }
  if (step.type === 'key' && typeof params.value === 'string' && params.value) {
    return `${base} · ${keyValueLabel(params.value)}`;
  }
  if (step.type === 'text' && typeof params.value === 'string' && params.value.trim()) {
    const preview = params.value.trim();
    return `${base} · ${preview.length > 12 ? `${preview.slice(0, 12)}…` : preview}`;
  }
  if (step.type === 'call' && typeof params.name === 'string' && params.name.trim()) {
    return `${base} · ${params.name.trim()}`;
  }
  if (step.type === 'setvar') {
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    const value = typeof params.value === 'string' ? params.value.trim() : '';
    if (name && value) {
      return `${base} · ${name} = ${value.length > 10 ? `${value.slice(0, 10)}…` : value}`;
    }
    if (name) {
      return `${base} · ${name}`;
    }
  }
  return base;
}

let stepIdSequence = 0;

/** 生成不会因并行模块批量插入而重复的步骤 id。 */
export function newStepId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return `s_${uuid.replaceAll('-', '').slice(0, 16)}`;
  }
  stepIdSequence = (stepIdSequence + 1) % 1_000_000;
  return `s_${Date.now().toString(36)}_${stepIdSequence.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultModuleStep(module: PaletteModule): FlowStep {
  return { id: newStepId(), type: module.type, params: { ...module.defaultParams } };
}
