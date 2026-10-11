/**
 * 「＋操作」菜单的内容：一级选"做什么"，二级选"具体怎么做"。
 *
 * 为什么要有二级：加一步操作天然是两步决策 —— 先挑动作类型（点击/等待/按键…），
 * 再定参数（点哪个模板、等多久、按哪个键）。全塞进一级菜单会又长又难扫，
 * 参数全丢给下方详情面板又太绕（用户反馈"菜单里的事件应该能配置"）。
 * 所以：常用参数做成二级菜单项，特殊值留一个「自定义…」到详情面板配。
 *
 * 纯函数（给上下文，出菜单项），可以单测；节点卡片只负责把菜单弹出来。
 */
import type { MenuItem } from '@/features/graph/GraphContextMenu';

/**
 * 解析用户填的**相对坐标**：
 *   - `0.42` → 0.42（0~1 归一化，引擎要的就是这个）
 *   - `42%` / `42` → 0.42（顺手支持百分比与"直接写 0~100"，免得用户猜口径）
 *   - 空 / 非数字 / 越界 → null（调用方跳过，不建这一步）
 */
export function parseRelative(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const text = raw.trim().replace('%', '');
  if (text === '') {
    return null;
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return null;
  }
  const ratio = Math.abs(value) > 1 ? value / 100 : value;
  if (ratio < 0 || ratio > 1) {
    return null;
  }
  return Math.round(ratio * 1000) / 1000;
}

export interface ActionMenuContext {
  /** 有截图的模板（点击/滑动的目标） */
  readonly templates: readonly string[];
  /** 图里定义的变量（赋值动作的目标） */
  readonly variables: readonly string[];
  /** 脚本库里的脚本（调用子脚本） */
  readonly scripts: readonly string[];
  /** 真建一步：action 直接给引擎的 action 载荷，条件可选 */
  readonly create: (patch: {
    action?: Record<string, unknown>;
    when?: string;
    condition?: Record<string, unknown>;
  }) => void;
}

/** 常用按键：值和引擎的 key 动作对齐 */
const KEYS: ReadonlyArray<{ label: string; value: string }> = [
  { label: '返回', value: 'back' },
  { label: '桌面', value: 'home' },
  { label: '最近任务', value: 'app_switch' },
  { label: '电源', value: 'power' },
  { label: '回车', value: 'enter' },
];

const SWIPES: ReadonlyArray<{ label: string; x1: number; y1: number; x2: number; y2: number }> = [
  { label: '上滑', x1: 0.5, y1: 0.75, x2: 0.5, y2: 0.25 },
  { label: '下滑', x1: 0.5, y1: 0.25, x2: 0.5, y2: 0.75 },
  { label: '左滑', x1: 0.8, y1: 0.5, x2: 0.2, y2: 0.5 },
  { label: '右滑', x1: 0.2, y1: 0.5, x2: 0.8, y2: 0.5 },
];

const COORD_NOTE = '相对坐标 0~1（也可以写 50% 或 50）';

/** 建完这一步后统一在详情里选中它（"自定义…"的落点） */
function custom(context: ActionMenuContext, type: string): MenuItem {
  return {
    label: '自定义…（在下方详情里配）',
    onSelect: () => context.create({ action: { type } }),
  };
}

/**
 * 生成「＋操作」的一级菜单。
 * 每项的二级菜单就是它的常用参数；点二级项 = 建好这一步并带上参数。
 */
export function buildActionMenu(context: ActionMenuContext): MenuItem[] {
  const templateItems: MenuItem[] = context.templates.map((label) => ({
    label: `「${label}」`,
    hint: '模板',
    onSelect: () =>
      context.create({
        action: { type: 'click', target: label },
        when: label,
        condition: { all_of: [label] },
      }),
  }));

  return [
    {
      label: '点击',
      hint: 'tap',
      submenu: [
        ...templateItems,
        ...(templateItems.length > 0 ? [{ label: '', divider: true, onSelect: () => undefined }] : []),
        {
          label: '屏幕中心',
          hint: '0.5, 0.5',
          onSelect: () => context.create({ action: { type: 'click', x: 0.5, y: 0.5 } }),
        },
        {
          label: '坐标（相对）',
          note: COORD_NOTE,
          input: {
            fields: [
              { key: 'x', placeholder: 'x' },
              { key: 'y', placeholder: 'y' },
            ],
            submitLabel: '加这一步',
            onSubmit: (values) => {
              const x = parseRelative(values.x);
              const y = parseRelative(values.y);
              if (x === null || y === null) {
                return; // 填得不完整就不建，避免建出一个点 (0,0) 的废动作
              }
              context.create({ action: { type: 'click', x, y } });
            },
          },
        },
        custom(context, 'click'),
      ],
    },
    {
      label: '长按',
      hint: 'long press',
      submenu: [
        {
          label: '0.6 秒',
          onSelect: () => context.create({ action: { type: 'long_press', duration_ms: 600 } }),
        },
        {
          label: '1.2 秒',
          onSelect: () => context.create({ action: { type: 'long_press', duration_ms: 1200 } }),
        },
        {
          label: '2 秒',
          onSelect: () => context.create({ action: { type: 'long_press', duration_ms: 2000 } }),
        },
        {
          label: '坐标 + 时长（相对）',
          note: COORD_NOTE,
          input: {
            fields: [
              { key: 'x', placeholder: 'x' },
              { key: 'y', placeholder: 'y' },
              { key: 'ms', placeholder: '毫秒', defaultValue: '600' },
            ],
            submitLabel: '加这一步',
            onSubmit: (values) => {
              const x = parseRelative(values.x);
              const y = parseRelative(values.y);
              const ms = Number(values.ms);
              if (x === null || y === null || !Number.isFinite(ms) || ms <= 0) {
                return; // 坐标或时长不合法就不建，免得留下一个点 (0,0) 的废动作
              }
              context.create({ action: { type: 'long_press', x, y, duration_ms: Math.round(ms) } });
            },
          },
        },
        custom(context, 'long_press'),
      ],
    },
    {
      label: '滑动',
      hint: 'swipe',
      submenu: [
        ...SWIPES.map((swipe) => ({
          label: swipe.label,
          hint: '全屏',
          onSelect: () =>
            context.create({
              action: { type: 'swipe', x: swipe.x1, y: swipe.y1, to_x: swipe.x2, to_y: swipe.y2 },
            }),
        })),
        {
          label: '起止坐标（相对）',
          note: COORD_NOTE,
          input: {
            fields: [
              { key: 'x', placeholder: 'x1' },
              { key: 'y', placeholder: 'y1' },
              { key: 'to_x', placeholder: 'x2' },
              { key: 'to_y', placeholder: 'y2' },
            ],
            submitLabel: '加这一步',
            onSubmit: (values) => {
              const from = [parseRelative(values.x), parseRelative(values.y)] as const;
              const to = [parseRelative(values.to_x), parseRelative(values.to_y)] as const;
              if (from[0] === null || from[1] === null || to[0] === null || to[1] === null) {
                return;
              }
              context.create({
                action: { type: 'swipe', x: from[0], y: from[1], to_x: to[0], to_y: to[1] },
              });
            },
          },
        },
        custom(context, 'swipe'),
      ],
    },
    {
      label: '等待',
      hint: 'wait',
      submenu: [
        { label: '0.3 秒', onSelect: () => context.create({ action: { type: 'wait', seconds: 0.3 } }) },
        { label: '0.5 秒', onSelect: () => context.create({ action: { type: 'wait', seconds: 0.5 } }) },
        { label: '1 秒', onSelect: () => context.create({ action: { type: 'wait', seconds: 1 } }) },
        { label: '2 秒', onSelect: () => context.create({ action: { type: 'wait', seconds: 2 } }) },
        custom(context, 'wait'),
      ],
    },
    {
      label: '按键',
      hint: 'key',
      submenu: [
        ...KEYS.map((key) => ({
          label: key.label,
          hint: key.value,
          onSelect: () => context.create({ action: { type: 'key', value: key.value } }),
        })),
        custom(context, 'key'),
      ],
    },
    {
      label: '输入文字',
      hint: 'text',
      submenu: [
        {
          label: '输入「测试」',
          hint: '占位',
          onSelect: () => context.create({ action: { type: 'text', value: '测试' } }),
        },
        custom(context, 'text'),
      ],
    },
    {
      label: '赋值',
      hint: '写变量',
      submenu: [
        ...context.variables.map((name) => ({
          label: `「${name}」= 0`,
          hint: '变量',
          onSelect: () => context.create({ action: { type: 'set', name, value: '0' } }),
        })),
        ...(context.variables.length === 0
          ? [{ label: '（还没有变量：详情面板里可以新建）', onSelect: () => undefined }]
          : []),
        custom(context, 'set'),
      ],
    },
    {
      label: '调用子脚本',
      hint: 'call',
      submenu: [
        ...context.scripts.map((script) => ({
          label: script,
          hint: '脚本',
          onSelect: () => context.create({ action: { type: 'call', script } }),
        })),
        ...(context.scripts.length === 0 ? [{ label: '（脚本库还是空的）', onSelect: () => undefined }] : []),
        custom(context, 'call'),
      ],
    },
  ];
}
