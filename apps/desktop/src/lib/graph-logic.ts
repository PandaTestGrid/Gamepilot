/**
 * 状态图 ↔ 脚本的"人话"层。
 *
 * 图上每个节点是一个界面、每条边是一步操作。但 JSON 里是 `{"type":"click","x":0.5,...}`，
 * 直接看数字看不出"这一步在干什么"，这一层专门把它翻译成人能读的句子：
 *
 * - `describeAction`      一步操作 → "点击 (0.50, 0.80)"
 * - `describeCondition`   判断条件 → "『桌面』出现 且 无『弹窗』"
 * - `describeEdgeLogic`   整条边   → "在『桌面』上：点击『拨号』→ 进入『拨号盘』"
 * - `describeNodeLogic`   整个节点 → "界面判定：『图标』；出去的步骤 3 条…"
 *
 * 全部是纯函数（不碰 React），所以可以单测；界面只负责显示。
 */
import type { EdgeAction, GraphData, GraphEdgeView, GraphNodeView } from '@/types';

function percent(value: number | undefined): string {
  return typeof value === 'number' ? value.toFixed(2) : '?';
}

/** 一步操作 → 一行摘要（图上和列表里都用它）。 */
export function describeAction(action: EdgeAction, compact = false): string {
  switch (action.type) {
    case 'click': {
      const where = action.target ? `『${action.target}』` : `(${percent(action.x)}, ${percent(action.y)})`;
      return `点击 ${where}`;
    }
    case 'long_press': {
      const where = action.target ? `『${action.target}』` : `(${percent(action.x)}, ${percent(action.y)})`;
      const held = action.durationMs ? ` 按住 ${(action.durationMs / 1000).toFixed(2)}s` : '';
      return `长按 ${where}${compact ? '' : held}`;
    }
    case 'swipe': {
      if (action.target && action.toTarget) {
        return `滑动 『${action.target}』→『${action.toTarget}』`;
      }
      const from = `(${percent(action.x)}, ${percent(action.y)})`;
      const to = `(${percent(action.toX)}, ${percent(action.toY)})`;
      const spent = action.durationMs ? ` ${(action.durationMs / 1000).toFixed(2)}s` : '';
      return `滑动 ${from}→${to}${compact ? '' : spent}`;
    }
    case 'wait':
      return `等待 ${(action.seconds ?? 0.5).toFixed(2)}s`;
    case 'key':
      return `按键 ${action.value || action.target || '?'}`;
    case 'text':
      return `输入 "${action.value ?? ''}"`;
    default:
      return action.type;
  }
}

/** 判断条件 → 一行摘要（和引擎 core/conditions.py 的语义一一对应）。 */
export function describeCondition(edge: GraphEdgeView): string {
  const { condition, when } = edge;
  if (condition.always) {
    const limited = condition.withinMs > 0 ? `（限时 ${condition.withinMs}ms）` : '';
    return `无条件${limited}`;
  }
  const parts: string[] = [];
  const all = condition.allOf.length > 0 ? condition.allOf : when && when !== 'always' ? [when] : [];
  if (all.length > 0) {
    parts.push(all.map((label) => `『${label}』出现`).join(' 且 '));
  }
  if (condition.anyOf.length > 0) {
    parts.push(`（${condition.anyOf.map((label) => `『${label}』`).join(' 或 ')}）任一出现`);
  }
  if (condition.noneOf.length > 0) {
    parts.push(condition.noneOf.map((label) => `无『${label}』`).join(' 且 '));
  }
  const extra: string[] = [];
  if (condition.minScore > 0) {
    extra.push(`score ≥ ${condition.minScore.toFixed(2)}`);
  }
  if (condition.withinMs > 0) {
    extra.push(`限时 ${condition.withinMs}ms`);
  }
  const suffix = extra.length > 0 ? `（${extra.join('，')}）` : '';
  return (parts.join('、') || '条件未设置') + suffix;
}

/** 图上那条边的标题：**先显示操作**，因为用户更关心"这一步做什么"。 */
export function edgeLabel(edge: GraphEdgeView, graph: GraphData | undefined): string {
  const action = describeAction(edge.actionSpec, true);
  const to = edge.to ? (graph?.nodes.find((item) => item.id === edge.to)?.name ?? edge.to) : '原地';
  const mark = edge.kind === 'recovery' ? '⚡ ' : '';
  return `${mark}${action} → ${to}`;
}

/** 一条边的完整逻辑（底部编辑器里显示）。 */
export function describeEdgeLogic(edge: GraphEdgeView, graph: GraphData | undefined): string {
  const from = edge.from
    ? (graph?.nodes.find((item) => item.id === edge.from)?.name ?? edge.from)
    : '任意界面';
  const to = edge.to ? (graph?.nodes.find((item) => item.id === edge.to)?.name ?? edge.to) : null;
  const condition = describeCondition(edge);
  const action = describeAction(edge.actionSpec);
  const tail = to ? `，然后进入『${to}』` : '（不切界面）';
  const notes: string[] = [];
  if (edge.priority !== 0) {
    notes.push(`优先级 ${edge.priority}`);
  }
  if (edge.cooldownMs > 0) {
    notes.push(`冷却 ${edge.cooldownMs}ms`);
  }
  const noteText = notes.length > 0 ? `（${notes.join('，')}）` : '';
  return `在『${from}』：${condition} 时，${action}${tail}${noteText}`;
}

/** 一个节点的完整逻辑（点节点时显示，也能看出它在脚本里的位置）。 */
export function describeNodeLogic(node: GraphNodeView, graph: GraphData | undefined): string[] {
  const lines: string[] = [];
  const enter =
    node.enter.length > 0
      ? node.enter.map((label) => `『${label}』`).join(' 或 ')
      : '（没有识别器，进不来也认不出）';
  lines.push(`界面判定：命中 ${enter} 就认为当前在这个界面`);
  const outgoing = (graph?.edges ?? []).filter((edge) => edge.from === node.id);
  const incoming = (graph?.edges ?? []).filter((edge) => edge.to === node.id);
  lines.push(`出去的操作 ${outgoing.length} 条，进来的路径 ${incoming.length} 条`);
  if (outgoing.length > 0) {
    lines.push(
      `按优先级依次尝试：${outgoing.map((edge) => describeAction(edge.actionSpec, true)).join(' → ')}`,
    );
  }
  lines.push(`已经进入过 ${node.visits} 次`);
  return lines;
}
