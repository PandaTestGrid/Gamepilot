/**
 * 动作参数 → "引脚"（蓝图里节点上那些小圆点）。
 *
 * UE 蓝图里每个参数是一个引脚，能看出来"这个值是从哪来的"。我们的引脚还不能拖线（P2 后续），
 * 但**先把它显示出来**：选中节点时摊开它的操作参数，变量引用高亮 ——
 * 一眼就能看出"这一步的坐标是活的还是写死的"。
 *
 * 纯函数，可单测。
 */
import type { EdgeAction, ParamValue } from '@/types';

export interface ActionPin {
  /** 参数名（X / Y / 到X / 时长…） */
  readonly label: string;
  /** 显示值：字面量数字或 `$变量名` */
  readonly value: string;
  /** 是否是变量引用（界面上高亮） */
  readonly isVar: boolean;
}

function pin(label: string, value: ParamValue | undefined): ActionPin | null {
  if (value === undefined || value === '') {
    return null;
  }
  const isVar = typeof value === 'string' && value.startsWith('$');
  return {
    label,
    value: isVar ? value : typeof value === 'number' ? value.toFixed(2) : String(value),
    isVar,
  };
}

/** 一个动作摊开成引脚；识别器目标显示成"目标"引脚（它不是数字，但同样是"值从哪来"）。 */
export function actionPins(action: EdgeAction): readonly ActionPin[] {
  const pins: ActionPin[] = [];
  if (action.target) {
    pins.push({ label: '目标', value: action.target, isVar: false });
  }
  if (action.toTarget) {
    pins.push({ label: '到目标', value: action.toTarget, isVar: false });
  }
  for (const [label, value] of [
    ['X', action.x],
    ['Y', action.y],
    ['到X', action.toX],
    ['到Y', action.toY],
    ['时长', action.durationMs],
    ['秒数', action.seconds],
    ['值', action.value],
  ] as const) {
    const item = pin(label, value);
    if (item) {
      pins.push(item);
    }
  }
  if (action.type === 'set' && action.name) {
    pins.unshift({ label: '变量', value: action.name, isVar: false });
  }
  return pins;
}

/** 紧凑摘要（节点上地方小）：最多显示 N 个引脚。 */
export function summarizePins(pins: readonly ActionPin[], max = 4): readonly ActionPin[] {
  return pins.slice(0, max);
}
