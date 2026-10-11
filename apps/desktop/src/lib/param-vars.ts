/**
 * "把参数存成变量"：把动作里的字面量参数抽成变量，动作改成引用。
 *
 * 为什么需要它：录出来的动作坐标都是写死的数字（0.512、0.834…），
 * 想统一调整（换分辨率、微调位置）就得一条条改。抽成变量后改一处全脚本生效 ——
 * 这正是蓝图里"数据连线"要解决的问题，这里先给出**一键**的入口。
 *
 * 纯函数，方便单测；界面只负责调用与保存。
 */
import type { EdgeAction, ParamValue } from '@/types';

export interface ParamExtraction {
  /** 新变量（默认值来自当前字面量） */
  readonly variables: Record<string, { type: string; value: number }>;
  /** 改写成引用后的动作 */
  readonly action: EdgeAction;
}

function isLiteral(value: ParamValue | undefined): value is number {
  return typeof value === 'number';
}

/** 变量名：`<标签>_<后缀>`，重名时自动加序号。 */
function uniqueName(taken: Set<string>, base: string, suffix: string): string {
  let name = `${base}${suffix}`;
  let index = 2;
  while (taken.has(name)) {
    name = `${base}${suffix}${index}`;
    index += 1;
  }
  taken.add(name);
  return name;
}

/**
 * 抽出可以变成变量的参数。
 *
 * 只处理"位置/时长"这类数字参数（坐标、滑动终点、时长、等待秒数）；
 * 识别器标签（target）保持原样 —— 它本来就是"键"，不需要再包一层。
 */
export function extractParamsToVariables(
  action: EdgeAction,
  label: string,
  taken: ReadonlySet<string> = new Set(),
): ParamExtraction {
  const used = new Set(taken);
  const variables: Record<string, { type: string; value: number }> = {};
  const next: EdgeAction = { ...action };
  const base = (label || '步骤').slice(0, 12);

  const take = (key: 'x' | 'y' | 'toX' | 'toY' | 'durationMs' | 'seconds', suffix: string): void => {
    const value = action[key];
    if (!isLiteral(value)) {
      return;
    }
    const name = uniqueName(used, base, suffix);
    variables[name] = { type: 'number', value };
    // 引用写法：$变量名
    (next as unknown as Record<string, unknown>)[key] = `$${name}`;
  };

  take('x', '_X');
  take('y', '_Y');
  take('toX', '_到X');
  take('toY', '_到Y');
  take('durationMs', '_时长');
  take('seconds', '_秒');

  return { variables, action: next };
}

/** 引脚上可以绑变量的参数名（和 actionPins 的 label 对应）。 */
export const PIN_KEYS = {
  X: 'x',
  Y: 'y',
  到X: 'toX',
  到Y: 'toY',
  时长: 'durationMs',
  秒数: 'seconds',
} as const;

export type PinKey = (typeof PIN_KEYS)[keyof typeof PIN_KEYS];

/**
 * 点一个引脚：字面量 → 绑成变量；已经是变量 → 拆回字面量（用变量当前值）。
 *
 * 为什么不做拖线：拖拽在触控板/小窗口上很容易失败，而且要先解决"从哪儿拖"。
 * 点一下就切换，交互更稳，效果一样 —— 参数变成"活的"。
 */
export function togglePin(
  action: EdgeAction,
  key: PinKey,
  options: { variables: ReadonlyArray<{ name: string; value: number | string | boolean }>; name: string },
): ParamExtraction & { bound: boolean } {
  const current = action[key];
  const bound = typeof current === 'string' && current.startsWith('$') && current.length > 1;

  if (bound) {
    // 拆回字面量：优先用变量当前值，找不到就用 0
    const varName = current.slice(1);
    const found = options.variables.find((item) => item.name === varName);
    const literal = typeof found?.value === 'number' ? found.value : Number(found?.value ?? 0);
    const next = { ...action } as unknown as Record<string, unknown>;
    next[key] = Number.isFinite(literal) ? literal : 0;
    return { variables: {}, action: next as unknown as EdgeAction, bound: false };
  }

  if (typeof current !== 'number') {
    return { variables: {}, action, bound: false };
  }
  const taken = new Set(options.variables.map((item) => item.name));
  let name = `${options.name}_${key}`;
  let index = 2;
  while (taken.has(name)) {
    name = `${options.name}_${key}${index}`;
    index += 1;
  }
  const next = { ...action } as unknown as Record<string, unknown>;
  next[key] = `$${name}`;
  return {
    variables: { [name]: { type: 'number', value: current } },
    action: next as unknown as EdgeAction,
    bound: true,
  };
}
