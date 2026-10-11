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
