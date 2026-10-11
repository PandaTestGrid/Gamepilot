/**
 * 变量的"数据流"：谁在用它。
 *
 * 蓝图里数据连线之所以好用，是因为能一眼看出"这个值被哪些节点用着"。
 * 我们的引脚还没做（P2 后续），但**这条信息本身**可以先给出来：
 * 面板上显示"被 3 步引用：步骤1_X、点击_时长…"，改之前就知道会影响谁。
 *
 * 纯函数，可单测。
 */
import type { EdgeAction, GraphData, ParamValue } from '@/types';

/** 从参数值里读出它引用的变量名（`$名字` → 名字；字面量 → null）。 */
export function referencedVariable(value: ParamValue | undefined): string | null {
  return typeof value === 'string' && value.startsWith('$') && value.length > 1 ? value.slice(1) : null;
}

/** 一个动作里用到的所有变量。 */
export function actionVariables(action: EdgeAction): string[] {
  const keys: Array<keyof EdgeAction> = ['x', 'y', 'toX', 'toY', 'durationMs', 'seconds'];
  const names = keys
    .map((key) => referencedVariable(action[key]))
    .filter((name): name is string => name !== null);
  // assign 是赋值动作的右值（可能是 $变量名）
  const assign = referencedVariable(action.assign);
  if (assign) {
    names.push(assign);
  }
  return [...new Set(names)];
}

export interface VariableUsage {
  /** 变量名 → 用它的边 id */
  readonly byVariable: Record<string, string[]>;
  /** 边 id → 它引用的变量 */
  readonly byEdge: Record<string, string[]>;
}

export function collectVariableUsage(graph: GraphData | undefined): VariableUsage {
  const byVariable: Record<string, string[]> = {};
  const byEdge: Record<string, string[]> = {};
  for (const edge of graph?.edges ?? []) {
    const names = actionVariables(edge.actionSpec);
    if (names.length === 0) {
      continue;
    }
    byEdge[edge.id] = names;
    for (const name of names) {
      byVariable[name] = [...(byVariable[name] ?? []), edge.id];
    }
  }
  return { byVariable, byEdge };
}

/** 面板上显示用：被哪几步引用（最多列 3 个）。 */
export function usageSummary(edgeIds: readonly string[]): string {
  if (edgeIds.length === 0) {
    return '还没有步骤引用它';
  }
  const head = edgeIds.slice(0, 3).join('、');
  return edgeIds.length > 3 ? `被 ${edgeIds.length} 步引用：${head}…` : `被引用：${head}`;
}
